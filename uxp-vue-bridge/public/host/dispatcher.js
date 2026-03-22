(function initTunanHostDispatcher(global) {
  const SETTINGS_STORAGE_KEY = 'tunan_host_settings_v1'

  class TunanHostDispatcher {
    constructor(emit) {
      this.emit = emit
      this.settings = {}
      this.settingsLoaded = false
      this.runtimeControlFrontendTarget = ''
      this.taskCenter = new global.TunanTaskCenter()
      this.photoshopService = new global.TunanPhotoshopService()
      this.workflowService = new global.TunanWorkflowService(this.emit)
      this.comfyEngine = new global.TunanComfyEngine(this.workflowService, this.emit)
      this.apiEngine = new global.TunanApiEngine()

      this.workflowService.setConfigProvider(() => this.resolveConnectionConfig())
    }

    async loadSettings() {
      const uxp = require('uxp')
      const fs = uxp.storage.localFileSystem
      const dataFolder = await fs.getDataFolder()
      try {
        const entries = await dataFolder.getEntries()
        const file = entries.find((entry) => entry?.isFile && entry.name === SETTINGS_STORAGE_KEY)
        if (!file) return {}
        const raw = await file.read()
        return raw
          ? {
              ...JSON.parse(raw),
              controlFrontendTarget: '',
            }
          : {}
      } catch {
        return {}
      }
    }

    async persistSettings() {
      const uxp = require('uxp')
      const fs = uxp.storage.localFileSystem
      const dataFolder = await fs.getDataFolder()
      try {
        const file = await dataFolder.createFile(SETTINGS_STORAGE_KEY, { overwrite: true })
        await file.write(JSON.stringify(this.getSettingsSnapshot(), null, 2))
      } catch {
        // ignore storage failures
      }
    }

    async ensureSettingsLoaded() {
      if (this.settingsLoaded) return
      this.settings = await this.loadSettings()
      this.settingsLoaded = true
    }

    getSettingsSnapshot() {
      return {
        ...(this.settings || {}),
        controlFrontendTarget: '',
      }
    }

    normalizeConnectionHost(rawHost = '') {
      const text = String(rawHost || '')
        .trim()
        .replace(/[：]/g, ':')
      if (!text) return '127.0.0.1'

      try {
        const withProtocol = /^[a-z]+:\/\//i.test(text) ? text : `http://${text}`
        const parsed = new URL(withProtocol)
        return parsed.hostname || '127.0.0.1'
      } catch {
        return text
          .replace(/^[a-z]+:\/\//i, '')
          .replace(/\/.*$/, '')
          .replace(/:\d+$/, '')
          .trim() || '127.0.0.1'
      }
    }

    normalizeConnectionPort(rawPort = '', rawHost = '') {
      const portText = String(rawPort || '').trim()
      if (/^\d+$/.test(portText)) {
        return portText
      }

      const hostText = String(rawHost || '').trim().replace(/[：]/g, ':')
      try {
        const withProtocol = /^[a-z]+:\/\//i.test(hostText) ? hostText : `http://${hostText}`
        const parsed = new URL(withProtocol)
        if (parsed.port && /^\d+$/.test(parsed.port)) {
          return parsed.port
        }
      } catch {
        const matchedPort = hostText.match(/:(\d+)(?:\/|$)/)
        if (matchedPort?.[1]) {
          return matchedPort[1]
        }
      }

      return '8188'
    }

    resolveConnectionConfig(payload = {}) {
      const payloadSettings = payload.settings || {}
      const settings = this.settings || {}
      const payloadTarget =
        typeof payload.controlFrontendTarget === 'string' ? payload.controlFrontendTarget : ''
      const payloadSettingsTarget =
        typeof payloadSettings.controlFrontendTarget === 'string'
          ? payloadSettings.controlFrontendTarget
          : ''
      const rawHost = payload.host || settings.host || '127.0.0.1'
      const rawPort = payload.port || settings.port || '8188'
      return {
        host: this.normalizeConnectionHost(rawHost),
        port: this.normalizeConnectionPort(rawPort, rawHost),
        controlFrontendMode: payload.controlFrontendMode || settings.controlFrontendMode || 'auto',
        controlFrontendTarget: payloadTarget || payloadSettingsTarget || this.runtimeControlFrontendTarget || '',
      }
    }

    normalizeRunPayload(messagePayload = {}) {
      return {
        workflow: messagePayload.workflow || this.workflowService.currentWorkflow || 'current_active',
        workflowId: messagePayload.workflowId || null,
        settings: {
          ...this.settings,
          ...(messagePayload.settings || {}),
        },
        parameters: {
          denoise: messagePayload.denoise ?? 0.75,
          seed: messagePayload.seed ?? -1,
          positive_prompt: messagePayload.positivePrompt || '',
          negative_prompt: messagePayload.negativePrompt || '',
          cfg_scale: messagePayload.cfgScale ?? 7,
          steps: messagePayload.steps ?? 20,
        },
      }
    }

    buildTaskPayloadSnapshot(normalizedPayload = {}) {
      return {
        workflow: normalizedPayload.workflow || 'current_active',
        workflowId: normalizedPayload.workflowId || null,
        settings: {
          ...(normalizedPayload.settings || {}),
        },
        denoise: normalizedPayload.parameters?.denoise ?? 0.75,
        seed: normalizedPayload.parameters?.seed ?? -1,
        positivePrompt: normalizedPayload.parameters?.positive_prompt || '',
        negativePrompt: normalizedPayload.parameters?.negative_prompt || '',
        cfgScale: normalizedPayload.parameters?.cfg_scale ?? 7,
        steps: normalizedPayload.parameters?.steps ?? 20,
      }
    }

    isRealtimeSkippableError(error) {
      const message = String(error?.message || error || '')
      return [
        '请先在 Photoshop 中打开一个文档',
        '当前没有活动图层',
        '当前图层没有可发送内容',
        '当前图层在选区内没有内容',
        '未能读取选区边界',
        '选区内没有可发送内容',
      ].some((keyword) => message.includes(keyword))
    }

    rewritePhotoshopCaptureError(error) {
      const rawMessage = String(error?.message || error || '')
      const code = error?.number ?? error?.code ?? error?.result ?? null
      const isSmartObjectUpdate =
        code === -25010 ||
        rawMessage.includes('-25010') ||
        rawMessage.includes('无法更新智能对象文件')

      if (!isSmartObjectUpdate) {
        return error
      }

      return new Error(
        `Photoshop 在读取当前文档里的智能对象图层时失败。` +
        `这通常是之前回贴进去的旧智能对象层已经失效。` +
        `请先隐藏或删除刚回贴的智能对象层，再试一次；` +
        `或者在设置里把“回贴图层类型”改成“像素图层”。` +
        `原始错误: ${rawMessage}`,
      )
    }

    logRealtime(stage, payload = {}) {
      void stage
      void payload
    }

    async prepareRunPayload(messagePayload = {}) {
      const normalized = this.normalizeRunPayload(messagePayload)
      let capture = null
      try {
        capture = await this.photoshopService.collectActiveContext(normalized.settings)
      } catch (error) {
        throw this.rewritePhotoshopCaptureError(error)
      }
      capture.parameters = {
        ...(capture.parameters || {}),
        ...normalized.parameters,
      }

      return {
        ...normalized,
        capture,
      }
    }

    async prepareApiPayload(messagePayload = {}) {
      const settings = {
        ...this.settings,
        ...(messagePayload.settings || {}),
      }

      let capture = null
      if (messagePayload.sendCanvas) {
        capture = this.photoshopService.collectActiveContextForApi
          ? await this.photoshopService.collectActiveContextForApi(settings)
          : await this.photoshopService.collectActiveContext(settings)
      }

      return {
        ...messagePayload,
        settings,
        capture,
      }
    }

    async dispatch(message) {
      const { TYPES } = global.TunanHostProtocol
      await this.ensureSettingsLoaded()

      switch (message.type) {
        case TYPES.PING:
          return { pong: true, timestamp: Date.now() }

        case TYPES.GET_PS_INFO:
          return this.photoshopService.getBasicInfo()

        case TYPES.GET_SETTINGS:
          return {
            settings: this.getSettingsSnapshot(),
          }

        case TYPES.SYNC_SETTINGS:
          this.runtimeControlFrontendTarget = this.runtimeControlFrontendTarget || ''
          this.settings = {
            ...this.settings,
            ...(message.payload || {}),
            controlFrontendTarget: '',
          }
          await this.persistSettings()
          return {
            synced: true,
            appMode: this.settings.appMode || 'comfyui',
            settings: this.getSettingsSnapshot(),
          }

        case TYPES.CONNECT_COMFYUI:
          return this.comfyEngine.connect(this.resolveConnectionConfig(message.payload || {}))

        case TYPES.DISCONNECT_COMFYUI:
          return this.comfyEngine.disconnect()

        case TYPES.TEST_CONNECTION:
          return this.comfyEngine.testConnection(this.resolveConnectionConfig(message.payload || {}))

        case TYPES.SCAN_COMFYUI_INSTANCES: {
          const resolvedConfig = this.resolveConnectionConfig(message.payload || {})
          const scanResult = await this.comfyEngine.scanLocalInstances(resolvedConfig)
          return {
            ...scanResult,
            scanId: message.payload?.scanId || '',
          }
        }

        case TYPES.SHUTDOWN_COMFYUI_INSTANCE:
          return this.comfyEngine.shutdownInstance(this.resolveConnectionConfig(message.payload || {}))

        case TYPES.OPEN_WORKFLOW_BROWSER:
          return this.workflowService.listWorkflows()

        case TYPES.REFRESH_WORKFLOW_STATE:
          return this.workflowService.fetchOpenedTabs()

        case TYPES.UPDATE_CONTROL_TARGET:
          this.runtimeControlFrontendTarget = message.payload?.controlFrontendTarget || ''
          return this.workflowService.setControlTarget(this.runtimeControlFrontendTarget)

        case TYPES.SWITCH_WORKFLOW:
          return this.workflowService.switchWorkflow({
            workflowId: message.payload?.workflowId || null,
            workflowName: message.payload?.workflow || null,
          })

        case TYPES.RUN_WORKFLOW: {
          const preparedPayload = await this.prepareRunPayload(message.payload)
          this.taskCenter.beginTask('comfyui-run', this.buildTaskPayloadSnapshot(preparedPayload))
          const result = await this.comfyEngine.runWorkflow(preparedPayload)
          if (!result.error) {
            await this.photoshopService.refreshRealtimeBaseline(preparedPayload.settings).catch(() => {})
          }
          return result
        }

        case TYPES.SEND_ONLY: {
          const preparedPayload = await this.prepareRunPayload(message.payload)
          this.taskCenter.beginTask('comfyui-send-only', this.buildTaskPayloadSnapshot(preparedPayload))
          const result = await this.comfyEngine.sendOnly(preparedPayload)
          if (!result.error) {
            await this.photoshopService.refreshRealtimeBaseline(preparedPayload.settings).catch(() => {})
          }
          return result
        }

        case TYPES.RUN_ONLY: {
          const normalizedPayload = this.normalizeRunPayload(message.payload)
          this.taskCenter.beginTask('comfyui-run-only', this.buildTaskPayloadSnapshot(normalizedPayload))
          return this.comfyEngine.runOnly(normalizedPayload)
        }

        case TYPES.REALTIME_TICK: {
          const realtimeSettings = (message.payload && message.payload.settings) || this.settings || {}
          const realtimeAction = realtimeSettings.realtimeAction === 'send' ? 'send' : 'run'

          if (!this.comfyEngine.isConnected) {
            this.logRealtime('skipped', { reason: 'not_connected' })
            return { skipped: true, reason: 'not_connected' }
          }

          if (this.comfyEngine.isWorkflowBusy()) {
            this.logRealtime('skipped', { reason: 'busy' })
            return { skipped: true, reason: 'busy' }
          }

          let decision = null
          try {
            decision = await this.photoshopService.evaluateRealtimeTick(
              (message.payload && message.payload.settings) || this.settings || {},
            )
          } catch (error) {
            if (this.isRealtimeSkippableError(error)) {
              this.logRealtime('skipped', {
                reason: 'capture_unavailable',
                message: error.message || String(error),
              })
              return { skipped: true, reason: 'capture_unavailable', message: error.message || String(error) }
            }
            throw error
          }

          if (!decision?.shouldRun) {
            this.logRealtime('skipped', {
              reason: decision?.reason || 'no_change',
              diff: decision?.diff || null,
              thresholds: decision?.thresholds || null,
            })
            return {
              skipped: true,
              reason: decision?.reason || 'no_change',
              diff: decision?.diff || null,
              thresholds: decision?.thresholds || null,
            }
          }

          try {
            const preparedPayload = await this.prepareRunPayload(message.payload)
            const result = realtimeAction === 'send'
              ? await this.comfyEngine.sendOnly(preparedPayload)
              : await this.comfyEngine.runWorkflow(preparedPayload)
            if (!result.error) {
              this.photoshopService.commitRealtimeBaseline(decision)
            }
            this.logRealtime('triggered', {
              action: realtimeAction,
              reason: decision.reason || 'triggered',
              accepted: Boolean(result.accepted),
              diff: decision.diff || null,
              thresholds: decision.thresholds || null,
            })
            return {
              ...result,
              realtime: true,
              action: realtimeAction,
              reason: decision.reason || 'triggered',
              diff: decision.diff || null,
              thresholds: decision.thresholds || null,
            }
          } catch (error) {
            if (this.isRealtimeSkippableError(error)) {
              this.logRealtime('skipped', {
                reason: 'capture_unavailable',
                message: error.message || String(error),
              })
              return { skipped: true, reason: 'capture_unavailable', message: error.message || String(error) }
            }
            throw error
          }
        }

        case TYPES.STOP_TASK: {
          const currentTask = this.taskCenter.getCurrentTask()
          const result =
            currentTask?.kind === 'api-generate'
              ? await this.apiEngine.stopTask(message.payload)
              : await this.comfyEngine.stopTask(message.payload)
          this.taskCenter.finishTask('stopped')
          return result
        }

        case TYPES.RERUN_TASK: {
          const lastTask = this.taskCenter.getLastTaskSnapshot()
          if (!lastTask?.payload) {
            throw new Error('没有可重跑的上一轮任务')
          }

          const preparedPayload = lastTask.kind === 'comfyui-run-only'
            ? this.normalizeRunPayload(lastTask.payload)
            : await this.prepareRunPayload(lastTask.payload)
          this.taskCenter.beginTask(lastTask.kind, this.buildTaskPayloadSnapshot(preparedPayload))
          if (lastTask.kind === 'comfyui-send-only') {
            return this.comfyEngine.sendOnly(preparedPayload)
          }
          if (lastTask.kind === 'comfyui-run-only') {
            return this.comfyEngine.runOnly(preparedPayload)
          }
          return this.comfyEngine.rerunTask(preparedPayload)
        }

        case TYPES.FETCH_API_MODELS:
          return this.apiEngine.fetchModels({
            settings: {
              ...this.settings,
              ...(message.payload?.settings || {}),
            },
          })

        case TYPES.API_GENERATE:
          this.taskCenter.beginTask('api-generate', message.payload)
          return this.apiEngine.generate(await this.prepareApiPayload(message.payload || {}))

        case TYPES.ADD_IMAGE_TO_PS:
          return this.photoshopService.addImageToDocument(message.payload)

        default:
          return {
            error: 'Unknown message type',
            type: message.type,
          }
      }
    }
  }

  global.TunanHostDispatcher = TunanHostDispatcher
})(window)
