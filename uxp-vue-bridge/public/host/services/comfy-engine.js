(function initTunanComfyEngine(global) {
  const COMFY_VERBOSE_LOGS = false
  const MAX_COMPLETED_PROMPT_IDS = 40
  const COMPLETED_PROMPT_ID_TTL_MS = 10 * 60 * 1000

  class TunanComfyEngine {
    constructor(workflowService, emit) {
      this.workflowService = workflowService
      this.emit = emit
      this.ws = null
      this.clientId = `tunan-${Math.random().toString(36).slice(2, 10)}`
      this.config = {
        host: '127.0.0.1',
        port: '8188',
      }
      this.isConnected = false
      this.isBootstrappingConnection = false
      this.pendingRequests = new Map()
      this.reconnectTimer = null
      this.reconnectAttempts = 0
      this.shouldReconnect = false
      this.connectPromise = null
      this.connectionLifecycle = {
        status: 'disconnected',
        updatedAt: Date.now(),
      }
      this.executionState = {
        active: false,
        progress: 0,
        promptId: null,
        updatedAt: 0,
        executionTime: 0,
      }
      this.executionStartedAt = 0
      this.lastExecutionTime = 0
      this.completedPromptIds = new Map()

      this.workflowService?.setRequestBridge((message, options) => this.request(message, options))
    }

    debugLog(stage, payload = {}) {
      if (!COMFY_VERBOSE_LOGS) return
      try {
        console.log(`[ComfyHostDebug] ${stage}`, payload)
      } catch {
        console.log(`[ComfyHostDebug] ${stage}`)
      }
    }

    logWs(stage, payload = {}) {
      if (!COMFY_VERBOSE_LOGS) return
      try {
        console.log(`[ComfyHostWS] ${stage}`, payload)
      } catch {
        console.log(`[ComfyHostWS] ${stage}`)
      }
    }

    summarizeWorkflowState() {
      return {
        currentWorkflow: this.workflowService?.currentWorkflow,
        openedTabs: (this.workflowService?.openedTabs || []).map((tab) => ({
          id: tab.id,
          name: tab.name,
          isCurrent: Boolean(tab.isCurrent),
        })),
        savedCount: this.workflowService?.savedWorkflows?.length || 0,
        selectedFrontendTarget: this.workflowService?.selectedFrontendTarget || '',
      }
    }

    updateConfig(config = {}) {
      const nextConfig = config.settings || config
      this.config = {
        ...this.config,
        host: nextConfig.host || this.config.host,
        port: String(nextConfig.port || this.config.port),
        controlFrontendTarget:
          nextConfig.controlFrontendTarget || this.config.controlFrontendTarget || '',
      }
      return this.config
    }

    getWsUrl() {
      return `ws://${this.config.host}:${this.config.port}/tunan/ps/ws`
    }

    getHttpUrl(path = '') {
      return `http://${this.config.host}:${this.config.port}${path}`
    }

    emitState(result = {}) {
      this.emit?.({
        type: 'HOST_PUSH',
        result,
      })
    }

    emitExecutionState() {
      this.emitState({
        executionState: {
          ...this.executionState,
        },
      })
    }

    emitConnectionLifecycle(status, payload = {}) {
      this.connectionLifecycle = {
        status,
        host: this.config.host,
        port: this.config.port,
        updatedAt: Date.now(),
        ...payload,
      }
      this.emitState({
        connectionLifecycle: {
          ...this.connectionLifecycle,
        },
        connected: status === 'connected',
        meta: {
          host: this.config.host,
          port: this.config.port,
          mode: 'comfyui',
        },
      })
    }

    markExecutionState(patch = {}) {
      const nextActive =
        typeof patch.active === 'boolean' ? patch.active : Boolean(this.executionState.active)
      const wasActive = Boolean(this.executionState.active)

      if (nextActive && !wasActive) {
        this.executionStartedAt = performance.now()
      }

      let executionTime = this.executionState.executionTime || 0
      if (typeof patch.executionTime === 'number' && Number.isFinite(patch.executionTime)) {
        executionTime = patch.executionTime
      } else if (!nextActive && wasActive && this.executionStartedAt > 0) {
        executionTime = (performance.now() - this.executionStartedAt) / 1000
        this.lastExecutionTime = executionTime
        this.executionStartedAt = 0
      }

      this.executionState = {
        ...this.executionState,
        ...patch,
        executionTime,
        updatedAt: Date.now(),
      }
      this.emitExecutionState()
    }

    resetExecutionState() {
      this.executionState = {
        active: false,
        progress: 0,
        promptId: null,
        updatedAt: Date.now(),
        executionTime: this.lastExecutionTime || 0,
      }
      this.executionStartedAt = 0
      this.emitExecutionState()
    }

    pruneCompletedPromptIds(now = Date.now()) {
      for (const [promptId, completedAt] of this.completedPromptIds.entries()) {
        if (!promptId) {
          this.completedPromptIds.delete(promptId)
          continue
        }

        if (now - completedAt > COMPLETED_PROMPT_ID_TTL_MS) {
          this.completedPromptIds.delete(promptId)
        }
      }

      while (this.completedPromptIds.size > MAX_COMPLETED_PROMPT_IDS) {
        const oldestPromptId = this.completedPromptIds.keys().next().value
        if (!oldestPromptId) break
        this.completedPromptIds.delete(oldestPromptId)
      }
    }

    markPromptCompleted(promptId) {
      const normalizedPromptId = String(promptId || '').trim()
      if (!normalizedPromptId) return

      this.completedPromptIds.set(normalizedPromptId, Date.now())
      this.pruneCompletedPromptIds()
    }

    forgetCompletedPrompt(promptId) {
      const normalizedPromptId = String(promptId || '').trim()
      if (!normalizedPromptId) return
      this.completedPromptIds.delete(normalizedPromptId)
    }

    isPromptCompleted(promptId) {
      const normalizedPromptId = String(promptId || '').trim()
      if (!normalizedPromptId) return false

      this.pruneCompletedPromptIds()
      return this.completedPromptIds.has(normalizedPromptId)
    }

    clearCompletedPromptIds() {
      this.completedPromptIds.clear()
    }

    isWorkflowBusy() {
      return Boolean(this.executionState.active)
    }

    buildConnectedPayload() {
      return {
        connected: true,
        meta: {
          host: this.config.host,
          port: this.config.port,
          mode: 'comfyui',
        },
        workflows: this.workflowService.workflows,
        openedTabs: this.workflowService.openedTabs,
        currentWorkflow: this.workflowService.currentWorkflow,
        currentWorkflowId: this.workflowService.currentWorkflowId,
        savedWorkflows: this.workflowService.savedWorkflows,
        controlMode: this.workflowService.controlMode,
        activeFrontend: this.workflowService.activeFrontend,
        availableFrontends: this.workflowService.availableFrontends,
        frontendSessions: this.workflowService.frontendSessions,
        selectedFrontendTarget: this.workflowService.selectedFrontendTarget,
      }
    }

    async testConnection(config = {}) {
      return this.connect(config)
    }

    async connect(config = {}) {
      this.updateConfig(config)
      this.shouldReconnect = true
      this.clearReconnectTimer()
      this.logWs('connect:start', {
        host: this.config.host,
        port: this.config.port,
        hasOpenSocket: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
        executionActive: Boolean(this.executionState.active),
        promptId: this.executionState.promptId || null,
      })
      this.debugLog('connect:start', {
        config: this.config,
        hasOpenSocket: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      })

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.emitConnectionLifecycle('connected', { reason: 'already_open' })
        return this.buildConnectedPayload()
      }

      if (this.connectPromise) {
        this.logWs('connect:join', {
          host: this.config.host,
          port: this.config.port,
        })
        return this.connectPromise
      }

      this.emitConnectionLifecycle(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting', {
        attempt: this.reconnectAttempts,
      })

      this.connectPromise = (async () => {
        this.workflowService.setEmitSuspended(true)
        this.isBootstrappingConnection = true
        this.debugLog('connect:bootstrap-begin', this.summarizeWorkflowState())

        try {
          await this.openWebSocket()
          this.debugLog('connect:after-openWebSocket', this.summarizeWorkflowState())
          await this.workflowService.setControlTarget(this.config.controlFrontendTarget || '').catch(() => {})
          this.debugLog('connect:after-setControlTarget', this.summarizeWorkflowState())
          await this.workflowService.fetchOpenedTabs()
          this.debugLog('connect:after-fetchOpenedTabs', this.summarizeWorkflowState())

          await this.workflowService.fetchSavedWorkflows(true)
          this.debugLog('connect:after-fetchSavedWorkflows', this.summarizeWorkflowState())
        } finally {
          this.isBootstrappingConnection = false
          this.workflowService.setEmitSuspended(false)
          this.debugLog('connect:bootstrap-end', this.summarizeWorkflowState())
        }

        this.emitConnectionLifecycle('connected', {
          reason: 'bootstrap_complete',
          clientId: this.clientId,
        })
        this.emitState(this.buildConnectedPayload())

        return this.buildConnectedPayload()
      })().finally(() => {
        this.connectPromise = null
      })

      return this.connectPromise
    }

    async disconnect() {
      this.debugLog('disconnect:start', this.summarizeWorkflowState())
      this.logWs('disconnect:manual', {
        host: this.config.host,
        port: this.config.port,
        executionActive: Boolean(this.executionState.active),
        promptId: this.executionState.promptId || null,
      })
      this.shouldReconnect = false
      this.clearReconnectTimer()
      this.isBootstrappingConnection = false
      this.workflowService.setEmitSuspended(false)
      this.rejectPendingRequests(new Error('连接已断开'))

      if (this.ws) {
        try {
          this.ws.onclose = null
          this.ws.close()
        } catch {}
      }

      this.ws = null
      this.isConnected = false
      this.clearCompletedPromptIds()
      this.resetExecutionState()
      this.emitConnectionLifecycle('manual-disconnect', { reason: 'user' })
      this.emitState({
        connected: false,
        meta: {
          host: this.config.host,
          port: this.config.port,
          mode: 'comfyui',
        },
      })

      return {
        connected: false,
        disconnected: true,
        meta: {
          host: this.config.host,
          port: this.config.port,
          mode: 'comfyui',
        },
      }
    }

    async ensureConnected(config = {}) {
      this.updateConfig(config)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return
      }
      await this.connect(config)
    }

    clearReconnectTimer() {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }

    scheduleReconnect() {
      if (this.reconnectTimer || !this.shouldReconnect) {
        return
      }

      const delay = Math.min(1500 * (this.reconnectAttempts + 1), 6000)
      this.reconnectAttempts += 1
      this.emitConnectionLifecycle('reconnecting', {
        reason: 'socket_closed',
        attempt: this.reconnectAttempts,
        retryDelay: delay,
      })
      this.logWs('reconnect:scheduled', {
        attempt: this.reconnectAttempts,
        delay,
        host: this.config.host,
        port: this.config.port,
        executionActive: Boolean(this.executionState.active),
        promptId: this.executionState.promptId || null,
      })
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null

        if (!this.shouldReconnect || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
          return
        }

        try {
          this.logWs('reconnect:attempt', {
            attempt: this.reconnectAttempts,
            host: this.config.host,
            port: this.config.port,
          })
          await this.connect({
            host: this.config.host,
            port: this.config.port,
            controlFrontendTarget: this.config.controlFrontendTarget || '',
          })
          this.logWs('reconnect:success', {
            attempt: this.reconnectAttempts,
            host: this.config.host,
            port: this.config.port,
          })
        } catch {
          this.emitConnectionLifecycle('backend-unreachable', {
            reason: 'reconnect_failed',
            attempt: this.reconnectAttempts,
            retryDelay: Math.min(1500 * (this.reconnectAttempts + 1), 6000),
          })
          this.logWs('reconnect:failed', {
            attempt: this.reconnectAttempts,
            host: this.config.host,
            port: this.config.port,
          })
          if (this.shouldReconnect) {
            this.scheduleReconnect()
          }
        }
      }, delay)
    }

    async openWebSocket() {
      if (this.ws) {
        try {
          this.ws.close()
        } catch {}
      }

      await new Promise((resolve, reject) => {
        let settled = false
        const ws = new WebSocket(this.getWsUrl())
        this.logWs('open:start', {
          url: this.getWsUrl(),
          executionActive: Boolean(this.executionState.active),
          promptId: this.executionState.promptId || null,
        })
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            ws.close()
          } catch {}
          reject(new Error('WebSocket 连接超时'))
        }, 8000)

        ws.onopen = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          this.ws = ws
          this.isConnected = true
          this.reconnectAttempts = 0
          this.debugLog('ws:open', {
            clientId: this.clientId,
            url: this.getWsUrl(),
          })
          this.logWs('open:success', {
            url: this.getWsUrl(),
            clientId: this.clientId,
          })

          ws.send(
            JSON.stringify({
              type: 'client_auth',
              client_type: 'photoshop',
              client_id: this.clientId,
              version: '2.0.0',
            }),
          )

          resolve()
        }

        ws.onmessage = (event) => {
          this.handleSocketMessage(event.data)
        }

        ws.onerror = () => {
          this.logWs('open:error', {
            url: this.getWsUrl(),
            executionActive: Boolean(this.executionState.active),
            promptId: this.executionState.promptId || null,
          })
          if (settled) return
          settled = true
          clearTimeout(timeout)
          reject(new Error('WebSocket 连接失败'))
        }

        ws.onclose = (event) => {
          clearTimeout(timeout)
          this.logWs('close', {
            code: event?.code ?? null,
            reason: event?.reason || '',
            wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null,
            host: this.config.host,
            port: this.config.port,
            promptId: this.executionState.promptId || null,
            executionActive: Boolean(this.executionState.active),
            shouldReconnect: this.shouldReconnect,
          })
          this.ws = null
          this.isConnected = false
          this.clearCompletedPromptIds()
          this.resetExecutionState()
          this.emitConnectionLifecycle(this.shouldReconnect ? 'reconnecting' : 'disconnected', {
            reason: event?.reason || '',
            closeCode: event?.code ?? null,
            wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null,
          })
          this.rejectPendingRequests(new Error('WebSocket 已关闭'))

          if (this.shouldReconnect) {
            this.scheduleReconnect()
          }
        }
      })
    }

    createRequestId(prefix = 'ws') {
      return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }

    createPendingRequest(requestId, expectTypes = [], timeoutMs = 8000) {
      if (!requestId) {
        throw new Error('缺少 request_id')
      }

      if (this.pendingRequests.has(requestId)) {
        this.pendingRequests.get(requestId)?.reject?.(new Error('重复的 request_id'))
        this.pendingRequests.delete(requestId)
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(requestId)
          reject(new Error('WebSocket 请求超时'))
        }, timeoutMs)

        this.pendingRequests.set(requestId, {
          expectTypes: Array.isArray(expectTypes) ? expectTypes : [],
          resolve: (message) => {
            clearTimeout(timeout)
            resolve(message)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          },
        })
      })
    }

    resolvePendingRequest(message) {
      const requestId = message?.request_id || message?.requestId || null
      if (!requestId) return false

      const pending = this.pendingRequests.get(requestId)
      if (!pending) return false

      const messageType = message?.type || ''
      const isError = messageType === 'error' || messageType === 'execution_error'

      if (!isError && pending.expectTypes.length && !pending.expectTypes.includes(messageType)) {
        return false
      }

      this.pendingRequests.delete(requestId)

      if (isError) {
        pending.reject(new Error(message.message || message.error || 'WebSocket 请求失败'))
      } else {
        pending.resolve(message)
      }

      return true
    }

    rejectPendingRequests(error) {
      for (const [requestId, pending] of this.pendingRequests.entries()) {
        try {
          pending.reject(error)
        } catch {}
        this.pendingRequests.delete(requestId)
      }
    }

    sendWsJson(message = {}) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('ComfyUI WebSocket 未连接')
      }

      this.ws.send(JSON.stringify(message))
    }

    async request(message = {}, { expectTypes = [], timeoutMs = 8000 } = {}) {
      const requestId = message.request_id || this.createRequestId(message.type || 'ws')
      const waitResponse = this.createPendingRequest(requestId, expectTypes, timeoutMs)
      this.sendWsJson({
        ...message,
        request_id: requestId,
      })
      return waitResponse
    }

    extractMessageState(message = {}) {
      const hasSelectedSessionId =
        Object.prototype.hasOwnProperty.call(message, 'selected_session_id') ||
        Object.prototype.hasOwnProperty.call(message.data || {}, 'selected_session_id')

      return {
        tabs: message.tabs || message.data?.tabs || [],
        current:
          message.current_tab ||
          message.current ||
          message.data?.current_tab ||
          message.data?.current ||
          null,
        session_kind: message.frontend_kind || message.data?.frontend_kind || null,
        session_id: message.frontend_session_id || message.data?.frontend_session_id || null,
        control_mode: message.control_mode || message.data?.control_mode || 'auto',
        selected_session_id: hasSelectedSessionId
          ? message.selected_session_id ?? message.data?.selected_session_id ?? ''
          : this.workflowService.selectedFrontendTarget,
        available_frontends:
          message.available_frontends || message.data?.available_frontends || this.workflowService.availableFrontends,
        frontend_sessions:
          message.frontend_sessions || message.data?.frontend_sessions || this.workflowService.frontendSessions,
      }
    }

    handleSocketMessage(rawMessage) {
      let message = null
      try {
        message = JSON.parse(rawMessage)
      } catch {
        this.debugLog('ws:parse-error', { rawMessage })
        return
      }

      this.pruneCompletedPromptIds()

      this.debugLog('ws:message', {
        type: message?.type || '',
        requestId: message?.request_id || message?.requestId || null,
        currentTab: message?.current_tab || message?.data?.current_tab || null,
        tabs: Array.isArray(message?.tabs || message?.data?.tabs)
          ? (message.tabs || message.data.tabs).length
          : null,
      })

      this.resolvePendingRequest(message)

      switch (message.type) {
        case 'get_tabs_response':
        case 'workflow_sync':
        case 'tabs_updated': {
          const state = this.extractMessageState(message)
          this.debugLog(`ws:${message.type}`, {
            bootstrapping: this.isBootstrappingConnection,
            current: state.current,
            tabs: (state.tabs || []).map((tab) => ({
              id: tab.id || tab.tab_id || tab.name,
              name: tab.name || tab.filename || '',
              isCurrent: Boolean(tab.is_current ?? tab.isCurrent),
            })),
            selectedFrontendTarget: state.selected_session_id || '',
          })

          this.workflowService.applyControlState(state)
          this.workflowService.updateOpenedTabs(state.tabs, state.current)

          if (!this.isBootstrappingConnection) {
            this.emitState(this.workflowService.buildStatePayload())
          }
          break
        }

        case 'workflows_list':
          if (!this.isBootstrappingConnection) {
            this.workflowService.savedWorkflows = (message.workflows || [])
              .filter((item) => item?.id !== 'current_active')
              .map((item) => this.workflowService.normalizeSavedWorkflow(item))
            this.workflowService.refreshSavedWorkflowOpenState()
            this.emitState(this.workflowService.buildStatePayload())
          }
          break

        case 'receive_image': {
          const currentPromptId = this.executionState.promptId || null
          if (currentPromptId) {
            this.markPromptCompleted(currentPromptId)
          }
          if (this.executionState.active) {
            this.markExecutionState({
              active: false,
              progress: 100,
              promptId: null,
            })
          }

          const payload = message.data || {}
          const format = payload.format || 'png'
          const image = payload.image?.startsWith('data:')
            ? payload.image
            : `data:image/${format};base64,${payload.image}`

          this.emitState({
            image,
            meta: {
              id: `result-${payload.timestamp || Date.now()}`,
              name: payload.name || 'ComfyUI 输出',
              placement: payload.original_placement || null,
              canvasRole: payload.canvas_role || payload.original_placement?.canvasRole || '',
              imageWidth: Number(payload.dimensions?.width || 0),
              imageHeight: Number(payload.dimensions?.height || 0),
              visibleBounds: payload.visible_bounds || null,
              hasAlpha: Boolean(payload.has_alpha),
              source: 'comfyui',
              sourceLayerName: payload.source_layer_name || '',
              documentName: payload.document_name || '',
              captureSource: payload.capture_source || '',
            },
          })
          break
        }

        case 'progress':
          this.emitState({
            progress: message.progress || message.data?.progress || 0,
          })
          break

        case 'execution_started':
          if (this.isPromptCompleted(message.prompt_id)) {
            break
          }
          this.markExecutionState({
            active: true,
            progress: 0,
            promptId: message.prompt_id || message.promptId || this.executionState.promptId || null,
          })
          break

        case 'execution_progress':
          if (this.isPromptCompleted(message.prompt_id)) {
            break
          }
          this.markExecutionState({
            active: true,
            progress: Number(message.progress || message.data?.progress || 0),
            promptId: message.prompt_id || message.promptId || this.executionState.promptId || null,
          })
          break

        case 'execution_complete':
          if (message.prompt_id) {
            this.markPromptCompleted(message.prompt_id)
          }
          this.markExecutionState({
            active: false,
            progress: 100,
            promptId: null,
            executionTime:
              typeof message.execution_time === 'number' && Number.isFinite(message.execution_time)
                ? message.execution_time
                : undefined,
          })
          break

        case 'workflow_stopped':
          this.resetExecutionState()
          break

        case 'execution_error':
          this.resetExecutionState()
          this.emitState({
            error: message.message || message.error || 'ComfyUI 执行失败',
          })
          break

        case 'error':
          this.emitState({
            error: message.message || message.error || 'ComfyUI 执行失败',
          })
          break

        default:
          break
      }
    }

    async dataUrlToBytes(dataUrl) {
      const blob = this.dataUrlToBlob(dataUrl)
      const buffer = await blob.arrayBuffer()
      return new Uint8Array(buffer)
    }

    bytesToBase64(bytes) {
      if (!bytes?.length) {
        return ''
      }

      const chunkSize = 0x8000
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize))
        binary += String.fromCharCode(...chunk)
      }
      return btoa(binary)
    }

    async uploadCaptureViaWs(capture = {}) {
      if (!capture?.image?.data && !capture?.image?.rawPixels) {
        throw new Error('没有可上传的 Photoshop 图像')
      }

      if (capture.parameters) {
        await this.request(
          {
            type: 'parameters',
            data: capture.parameters,
          },
          { expectTypes: ['parameters_ack'] },
        )
      }

      const imageBytes = capture.image.rawPixels
        ? capture.image.rawPixels
        : await this.dataUrlToBytes(capture.image.data)
      const format = capture.image.format || 'png'
      const requestId = this.createRequestId('binary')
      const binaryMeta = {
        ...(capture.meta || {}),
        original_placement: capture.placement || null,
      }

      if (capture.image.rawPixels) {
        binaryMeta.raw_image = true
        binaryMeta.raw_components = capture.image.components
        binaryMeta.raw_source_width = capture.image.sourceWidth
        binaryMeta.raw_source_height = capture.image.sourceHeight
        binaryMeta.raw_canvas_width = capture.image.canvasWidth
        binaryMeta.raw_canvas_height = capture.image.canvasHeight
        binaryMeta.raw_offset_x = capture.image.offsetX
        binaryMeta.raw_offset_y = capture.image.offsetY
        binaryMeta.raw_target_width = capture.image.width
        binaryMeta.raw_target_height = capture.image.height
        binaryMeta.raw_output_format = capture.image.outputFormat || 'png'
        binaryMeta.raw_jpeg_quality = capture.image.jpegQuality || 90
      }

      if (capture.selectionMask?.rawPixels) {
        binaryMeta.selection_mask_raw = true
        binaryMeta.selection_mask_raw_data = this.bytesToBase64(capture.selectionMask.rawPixels)
        binaryMeta.selection_mask_components = capture.selectionMask.components
        binaryMeta.selection_mask_source_width = capture.selectionMask.sourceWidth
        binaryMeta.selection_mask_source_height = capture.selectionMask.sourceHeight
        binaryMeta.selection_mask_canvas_width = capture.selectionMask.canvasWidth
        binaryMeta.selection_mask_canvas_height = capture.selectionMask.canvasHeight
        binaryMeta.selection_mask_offset_x = capture.selectionMask.offsetX
        binaryMeta.selection_mask_offset_y = capture.selectionMask.offsetY
        binaryMeta.selection_mask_target_width = capture.selectionMask.width
        binaryMeta.selection_mask_target_height = capture.selectionMask.height
      } else if (capture.selectionMask?.data) {
        binaryMeta.selection_mask_data = capture.selectionMask.data.includes(',')
          ? capture.selectionMask.data.split(',', 2)[1]
          : capture.selectionMask.data
        binaryMeta.selection_mask_format = capture.selectionMask.format || 'png'
      }

      if (capture.contentAlpha?.rawPixels) {
        binaryMeta.content_alpha_raw = true
        binaryMeta.content_alpha_raw_data = this.bytesToBase64(capture.contentAlpha.rawPixels)
        binaryMeta.content_alpha_components = capture.contentAlpha.components
        binaryMeta.content_alpha_source_width = capture.contentAlpha.sourceWidth
        binaryMeta.content_alpha_source_height = capture.contentAlpha.sourceHeight
        binaryMeta.content_alpha_canvas_width = capture.contentAlpha.canvasWidth
        binaryMeta.content_alpha_canvas_height = capture.contentAlpha.canvasHeight
        binaryMeta.content_alpha_offset_x = capture.contentAlpha.offsetX
        binaryMeta.content_alpha_offset_y = capture.contentAlpha.offsetY
        binaryMeta.content_alpha_target_width = capture.contentAlpha.width
        binaryMeta.content_alpha_target_height = capture.contentAlpha.height
      }

      const waitBinaryStart = this.createPendingRequest(requestId, ['binary_start_ack'], 8000)
      this.sendWsJson({
        type: 'binary_start',
        request_id: requestId,
        name: capture.image.name || `ps_capture.${format}`,
        size: imageBytes.byteLength,
        format,
        width: capture.image.width || 0,
        height: capture.image.height || 0,
        document_name: capture.meta?.document_name || capture.meta?.documentName || '',
        timestamp: Date.now(),
        chunks: 1,
        metadata: binaryMeta,
      })
      await waitBinaryStart

      const waitBinaryEnd = this.createPendingRequest(requestId, ['binary_end_ack'], 15000)
      this.ws.send(imageBytes.buffer)
      this.sendWsJson({
        type: 'binary_end',
        request_id: requestId,
      })
      await waitBinaryEnd
    }

    async runWorkflow(payload = {}) {
      this.updateConfig(payload.settings || payload)
      await this.ensureConnected(payload.settings || payload)
      await this.uploadCaptureViaWs(payload.capture)

      return this.runOnly(payload)
    }

    async runOnly(payload = {}) {
      this.updateConfig(payload.settings || payload)
      await this.ensureConnected(payload.settings || payload)

      const executeResult = await this.request(
        {
          type: 'control_workflow',
          action: 'execute',
          workflow_id: this.resolveWorkflowId(payload.workflow, payload.workflowId),
          client_id: this.clientId,
        },
        { expectTypes: ['workflow_executing'], timeoutMs: 8000 },
      )

      this.markExecutionState({
        active: true,
        progress: 0,
        promptId: executeResult.prompt_id || null,
      })
      if (executeResult.prompt_id) {
        this.forgetCompletedPrompt(executeResult.prompt_id)
      }

      return {
        accepted: true,
        promptId: executeResult.prompt_id || null,
        currentWorkflow: this.workflowService.currentWorkflow,
        currentWorkflowId: this.workflowService.currentWorkflowId,
        workflows: this.workflowService.workflows,
        savedWorkflows: this.workflowService.savedWorkflows,
      }
    }

    async sendOnly(payload = {}) {
      this.updateConfig(payload.settings || payload)
      await this.ensureConnected(payload.settings || payload)
      await this.uploadCaptureViaWs(payload.capture)

      return {
        accepted: true,
        currentWorkflow: this.workflowService.currentWorkflow,
        workflows: this.workflowService.workflows,
      }
    }

    async stopTask() {
      const interruptUrl = this.getHttpUrl('/interrupt')
      this.logWs('stop:http-request', {
        url: interruptUrl,
        promptId: this.executionState.promptId || null,
        executionActive: Boolean(this.executionState.active),
      })

      const response = await fetch(interruptUrl, {
        method: 'POST',
        cache: 'no-store',
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(errorText || `停止工作流失败 (${response.status})`)
      }

      this.logWs('stop:http-success', {
        url: interruptUrl,
        promptId: this.executionState.promptId || null,
        executionActive: Boolean(this.executionState.active),
      })

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.resetExecutionState()
        return { stopped: true }
      }

      this.resetExecutionState()

      return {
        stopped: true,
      }
    }

    async rerunTask(payload = {}) {
      return this.runWorkflow(payload)
    }

    resolveWorkflowId(workflowName, workflowId) {
      if (workflowId) return workflowId
      if (!workflowName) return 'current_active'

      const matchedSaved = this.workflowService.savedWorkflows.find((item) => item.name === workflowName)
      if (matchedSaved) return matchedSaved.id

      const matchedTab = this.workflowService.openedTabs.find((tab) => tab.name === workflowName)
      if (matchedTab) return matchedTab.id || 'current_active'

      return 'current_active'
    }

    dataUrlToBlob(dataUrl) {
      const [header, content] = dataUrl.split(',')
      const mimeMatch = header.match(/data:(.*?);base64/)
      const mimeType = mimeMatch?.[1] || 'image/png'
      const binary = atob(content)
      const bytes = new Uint8Array(binary.length)

      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }

      return new Blob([bytes], { type: mimeType })
    }
  }

  global.TunanComfyEngine = TunanComfyEngine
})(window)


