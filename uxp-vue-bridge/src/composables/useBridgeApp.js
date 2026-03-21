import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { sendToHost, subscribeHostMessages } from '../core/bridge/webviewBridge'
import { createConnectionStore } from '../core/connection/connectionStore'
import { HOST_EVENT_TYPES, HOST_MESSAGE_TYPES } from '../core/protocol/hostProtocol'
import { clearResultCache, loadResultCache, saveResultCache } from '../core/results/resultCache'
import { createResultStore } from '../core/results/resultStore'
import { DEFAULT_SETTINGS, normalizeSettingsSnapshot, resolveActiveApiProfile } from '../core/settings/bridgeSettings'
import { createTaskStore } from '../core/tasks/taskStore'
import {
  createWorkflowStore,
  isResolvedWorkflowState,
  isRunnableWorkflowName,
  resolveCurrentWorkflowName,
  UNSELECTED_WORKFLOW_LABEL,
  UNSYNCED_WORKFLOW_LABEL,
} from '../core/workflows/workflowStore'

function normalizeWorkflowName(name) {
  return name || UNSYNCED_WORKFLOW_LABEL
}

function normalizePersistentSettingsSnapshot(rawSettings = {}) {
  return {
    ...normalizeSettingsSnapshot(rawSettings || {}),
    controlFrontendTarget: '',
  }
}

export function useBridgeApp() {
  const DENOISE_SLIDER_STEPS = 1000
  const showSettings = ref(false)
  const settingsActiveTab = ref('connection')
  const appMode = ref('comfyui')
  const settingsSnapshot = ref({ ...DEFAULT_SETTINGS })
  const denoiseValue = ref(0.75)
  const denoiseVisualValue = ref(denoiseValue.value)
  const realtimeOn = ref(false)
  const showPromptPanel = ref(false)
  const positivePrompt = ref('')
  const negativePrompt = ref('ugly, blurry, deformed, bad anatomy, watermark, text')
  const stepsValue = ref(20)
  const cfgScale = ref(7)
  const seedValue = ref(-1)
  const isConnecting = ref(false)
  const connectionError = ref('')
  const connectionStatusText = ref('未连接')
  const connectionPhase = ref('disconnected')
  const connectionBadgePhase = ref('disconnected')
  const connectionBadgeOverrideText = ref('')
  const taskErrorMessage = ref('')
  const taskErrorTimer = ref(null)
  const dropdownRef = ref(null)
  const actionMenuRef = ref(null)
  const apiPrompt = ref('')
  const apiSendCanvas = ref(true)
  const referenceImages = ref([])
  const referencePanelExpanded = ref(false)
  const apiModelOptions = ref([])
  const apiModelsLoading = ref(false)
  const apiModelsError = ref('')
  const activeFrontend = ref(null)
  const availableFrontends = ref({ desktop: 0, browser: 0, unknown: 0 })
  const frontendSessions = ref([])
  const selectedFrontendTarget = ref('')
  const connectionRetryTimer = ref(null)
  const connectionBadgeTimer = ref(null)
  const workflowResyncTimer = ref(null)
  const executionProgressSettling = ref(false)
  const executionProgressSettleTimer = ref(null)
  const autoConnectState = ref({
    active: false,
    config: null,
    attemptIndex: 0,
  })
  const pendingConnectCancellation = ref(false)
  let pendingLocalSettings = null
  let settingsBootstrapped = false
  let lastConnectionBadgePressAt = 0
  let workflowResyncAttemptIndex = 0

  const connectionStore = createConnectionStore()
  const comfyResultStore = createResultStore()
  const apiResultStore = createResultStore()
  const workflowStore = createWorkflowStore()
  const taskStore = createTaskStore()
  const realtimeTickInFlight = ref(false)
  const executionState = ref({
    active: false,
    progress: 0,
    promptId: null,
    updatedAt: 0,
  })
  let userStopRequestedAt = 0
  let realtimeIntervalId = null
  let realtimePrimeTimer = null
  let denoiseVisualFrameId = null
  let apiTaskStageTimer = null
  let apiTaskElapsedTimer = null
  let resultCachePersistTimer = null
  let resultCacheHydrated = false
  const apiTaskElapsedMs = ref(0)
  const apiBadgeLastState = ref('idle')
  const apiBadgeLastError = ref('')

  const denoiseInt = computed(() => Math.round(denoiseValue.value * DENOISE_SLIDER_STEPS))
  const denoisePct = computed(() => denoiseVisualValue.value * 100)
  const denoiseDisplay = computed(() => denoiseValue.value.toFixed(2))
  const effectiveDenoiseLinked = computed(() => connectionStore.isConnected.value)
  const denoiseVisualPosition = computed(() => {
    const knobSize = 10
    const offset = (0.5 - denoiseVisualValue.value) * knobSize
    return `calc(${denoisePct.value}% + ${offset}px)`
  })
  const apiHistoryBottom = computed(() => (referencePanelExpanded.value ? '146px' : '100px'))
  const activeResultStore = computed(() => (appMode.value === 'api' ? apiResultStore : comfyResultStore))
  const activeHistoryItems = computed(() => activeResultStore.value.historyItems.value)
  const activeHistoryId = computed(() => activeResultStore.value.activeHistoryId.value)
  const activeMainImage = computed(() => activeResultStore.value.mainImage.value)
  const activeMainMeta = computed(() => activeResultStore.value.mainMeta.value)
  const hasAnyResultHistory = computed(
    () =>
      Boolean(comfyResultStore.mainImage.value) ||
      comfyResultStore.historyItems.value.length > 0 ||
      Boolean(apiResultStore.mainImage.value) ||
      apiResultStore.historyItems.value.length > 0,
  )
  const isApiTaskBusy = computed(
    () =>
      appMode.value === 'api' &&
      taskStore.currentTask.value?.kind === 'api-generate' &&
      ['pending', 'running'].includes(taskStore.currentTask.value?.status),
  )
  const apiTaskHintText = computed(() => {
    if (!isApiTaskBusy.value) return ''
    const elapsedSeconds = Math.max(0, Math.floor(apiTaskElapsedMs.value / 1000))
    if (taskStore.currentTask.value?.status === 'pending') {
      return elapsedSeconds > 0
        ? `正在发送到图像服务 · ${elapsedSeconds}s`
        : '正在发送到图像服务...'
    }
    if (elapsedSeconds < 8) {
      return elapsedSeconds > 0
        ? `服务端已接收，正在准备图像 · ${elapsedSeconds}s`
        : '服务端已接收，正在准备图像...'
    }
    if (elapsedSeconds < 20) {
      return `正在生成图像 · ${elapsedSeconds}s`
    }
    if (elapsedSeconds < 40) {
      return `仍在生成图像 · ${elapsedSeconds}s`
    }
    return `生成耗时较长 · ${elapsedSeconds}s`
  })
  const activeApiProfile = computed(() => resolveActiveApiProfile(settingsSnapshot.value))
  const apiBadgeState = computed(() => {
    const activeProfile = activeApiProfile.value
    if (!activeProfile) {
      return {
        phase: 'waiting',
        text: 'API 未配置',
        title: '当前还没有可用的 API 卡片，点击打开设置并新建卡片。',
      }
    }

    const missingFields = []
    if (!String(activeProfile.apiKey || '').trim()) missingFields.push('Key')
    if (!String(activeProfile.baseUrl || '').trim()) missingFields.push('地址')
    if (!String(activeProfile.activeModel || activeProfile.model || '').trim()) missingFields.push('模型')

    if (missingFields.length > 0) {
      return {
        phase: 'waiting',
        text: 'API 待完善',
        title: `当前卡片“${activeProfile.name || '未命名卡片'}”还缺少：${missingFields.join('、')}。点击打开设置检查。`,
      }
    }

    if (apiBadgeLastState.value === 'failed') {
      return {
        phase: 'failed',
        text: 'API 失败',
        title: apiBadgeLastError.value
          ? `最近一次请求失败：${apiBadgeLastError.value}`
          : `当前卡片“${activeProfile.name || '未命名卡片'}”最近一次请求失败，点击打开设置检查。`,
      }
    }

    return {
      phase: 'connected',
      text: 'API 就绪',
      title: `当前卡片：${activeProfile.name || '未命名卡片'}。点击打开设置查看或编辑。`,
    }
  })
  const isTaskRunning = computed(() => taskStore.isRunning.value)
  const isTaskPending = computed(() => taskStore.isPending.value)
  const isExecutionRunning = computed(() => executionState.value.active)
  const isPrimaryActionBusy = computed(() => isTaskPending.value || isExecutionRunning.value)
  const executionProgressPercent = computed(() => {
    const progress = Number(executionState.value.progress || 0)
    if (!Number.isFinite(progress)) return 0
    return Math.min(100, Math.max(0, Math.round(progress)))
  })
  const executionProgressStage = computed(() => {
    if (executionProgressSettling.value) return 'complete'
    if (isTaskPending.value && !isExecutionRunning.value) return 'preparing'
    if (isExecutionRunning.value && executionProgressPercent.value <= 0) return 'preparing'
    if (isExecutionRunning.value || executionProgressPercent.value > 0) return 'running'
    return 'idle'
  })
  const isExecutionProgressIndeterminate = computed(
    () => executionProgressStage.value === 'preparing',
  )
  const showExecutionProgress = computed(
    () =>
      appMode.value === 'comfyui' &&
      connectionStore.isConnected.value &&
      (isTaskPending.value || isExecutionRunning.value || executionProgressSettling.value),
  )
  const executionProgressText = computed(() => {
    if (executionProgressStage.value === 'complete') return '完成'
    if (executionProgressStage.value === 'preparing') return '准备中'
    if (executionProgressStage.value === 'running') {
      return `进度 ${executionProgressPercent.value}%`
    }
    return ''
  })
  const canRerun = computed(() => taskStore.canRerun.value)
  const actionMenuOpen = ref(false)
  const currentWorkflow = computed(() =>
    workflowStore.currentWorkflow.value ||
    resolveCurrentWorkflowName(
      workflowStore.openedTabs.value,
      workflowStore.currentWorkflow.value,
      workflowStore.currentWorkflowId.value,
    ),
  )
  const currentWorkflowId = computed(() => workflowStore.currentWorkflowId.value || '')
  const currentWorkflowTab = computed(() => {
    const preferredTabId = currentWorkflowId.value
    if (preferredTabId) {
      const matchedById = workflowStore.openedTabs.value.find((tab) => tab.id === preferredTabId)
      if (matchedById) {
        return matchedById
      }
    }

    return (
      workflowStore.openedTabs.value.find((tab) => tab.isCurrent) ||
      workflowStore.openedTabs.value.find((tab) => tab.name === currentWorkflow.value) ||
      null
    )
  })
  const currentWorkflowModified = computed(
    () =>
      connectionStore.isConnected.value &&
      isRunnableWorkflowName(currentWorkflow.value) &&
      Boolean(currentWorkflowTab.value?.isModified),
  )
  const canSendOnly = computed(
    () => connectionStore.isConnected.value && !isTaskPending.value && !isExecutionRunning.value,
  )
  const realtimeActionMode = computed(() => (settingsSnapshot.value.realtimeAction === 'send' ? 'send' : 'run'))
  const isRealtimeArmed = computed(
    () =>
      realtimeOn.value &&
      connectionStore.isConnected.value &&
      !isTaskPending.value &&
      !isExecutionRunning.value,
  )
  const canRunCurrentWorkflow = computed(
    () =>
      connectionStore.isConnected.value &&
      !isTaskPending.value &&
      !isExecutionRunning.value &&
      isRunnableWorkflowName(currentWorkflow.value),
  )
  const canOpenActionMenu = computed(
    () => connectionStore.isConnected.value && !isTaskPending.value && !isExecutionRunning.value,
  )
  const canTriggerPrimaryAction = computed(() => {
    if (isPrimaryActionBusy.value) return true
    return canRunCurrentWorkflow.value
  })
  const primaryActionLabel = computed(() => {
    if (isPrimaryActionBusy.value) return '停止'
    if (isRealtimeArmed.value) return '实时中'
    return '运行'
  })
  const primaryActionTitle = computed(() => {
    if (isPrimaryActionBusy.value) return ''
    if (isRealtimeArmed.value) {
      return realtimeActionMode.value === 'send' ? '实时发送已开启' : '实时运行已开启'
    }
    return ''
  })
  const primaryActionDisabled = computed(() => {
    if (isPrimaryActionBusy.value) return false
    if (isRealtimeArmed.value) return true
    return !canRunCurrentWorkflow.value
  })
  const primaryActionDisplayLabel = computed(() => {
    if (isPrimaryActionBusy.value) return '停止'
    if (isRealtimeArmed.value) return '实时中'
    return '运行'
  })
  const primaryActionDisplayTitle = computed(() => {
    if (isPrimaryActionBusy.value) return ''
    if (isRealtimeArmed.value) {
      return realtimeActionMode.value === 'send' ? '实时发送已开启' : '实时运行已开启'
    }
    return ''
  })
  const frontendTargetOptions = computed(() => {
    const options = []
    let browserIndex = 0
    let desktopIndex = 0

    for (const session of frontendSessions.value) {
      if (!session?.session_id) continue
      let label = '未知前端'
      if (session.kind === 'desktop') {
        desktopIndex += 1
        label = desktopIndex > 1 ? `桌面客户端 ${desktopIndex}` : '桌面客户端'
      } else if (session.kind === 'browser') {
        browserIndex += 1
        label = `网页端 ${browserIndex}`
      }

      if (session.current_tab_name) {
        label += ` 路 ${session.current_tab_name}`
      }

      options.push({
        label,
        value: session.session_id,
      })
    }

    return options
  })
  const connectionBadgeText = computed(() => {
    if (connectionBadgeOverrideText.value) return connectionBadgeOverrideText.value
    if (appMode.value === 'api') return 'API 模式'

    switch (connectionBadgePhase.value) {
      case 'connected':
        return '已连接'
      case 'connecting':
        return '连接中...'
      case 'waiting':
        return '等待 ComfyUI'
      case 'failed':
        return '连接失败'
      default:
        return '未连接'
    }
  })
  const connectionActionTitle = computed(() => {
    if (appMode.value === 'api') return '当前为 API 模式'
    if (connectionPhase.value === 'connected') return '点击断开连接'
    if (connectionPhase.value === 'connecting' || connectionPhase.value === 'waiting') return '点击取消连接'
    if (connectionPhase.value === 'failed') return '点击重试连接'
    return '点击连接'
  })
  // Keep retrying long enough for "plugin first, ComfyUI later" startup.
  const AUTO_CONNECT_RETRY_DELAYS = [1200, 2500, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]
  const WORKFLOW_RESYNC_DELAYS = [260, 720, 1600, 3000, 5000]
  const USER_STOP_GRACE_MS = 6000
  const TRANSIENT_CONNECTION_BADGE_DELAY_MS = 420

  function clearConnectionRetryTimer() {
    if (connectionRetryTimer.value) {
      clearTimeout(connectionRetryTimer.value)
      connectionRetryTimer.value = null
    }
  }

  function clearConnectionBadgeTimer() {
    if (connectionBadgeTimer.value) {
      clearTimeout(connectionBadgeTimer.value)
      connectionBadgeTimer.value = null
    }
  }

  function clearWorkflowResyncTimer() {
    if (workflowResyncTimer.value) {
      clearTimeout(workflowResyncTimer.value)
      workflowResyncTimer.value = null
    }
  }

  function resetWorkflowResyncState() {
    clearWorkflowResyncTimer()
    workflowResyncAttemptIndex = 0
  }

  function clearTaskErrorTimer() {
    if (taskErrorTimer.value) {
      clearTimeout(taskErrorTimer.value)
      taskErrorTimer.value = null
    }
  }

  function clearTaskError() {
    clearTaskErrorTimer()
    taskErrorMessage.value = ''
  }

  function openSettingsPanel(tab = null) {
    if (tab && ['connection', 'layer', 'document', 'interface'].includes(tab)) {
      settingsActiveTab.value = tab
    }
    showSettings.value = true
  }

  function clearApiTaskStageTimer() {
    if (apiTaskStageTimer) {
      clearTimeout(apiTaskStageTimer)
      apiTaskStageTimer = null
    }
  }

  function clearApiTaskElapsedTimer() {
    if (apiTaskElapsedTimer) {
      clearInterval(apiTaskElapsedTimer)
      apiTaskElapsedTimer = null
    }
    apiTaskElapsedMs.value = 0
  }

  function clearResultCachePersistTimer() {
    if (resultCachePersistTimer) {
      clearTimeout(resultCachePersistTimer)
      resultCachePersistTimer = null
    }
  }

  function schedulePersistResultCaches() {
    if (!resultCacheHydrated) return
    clearResultCachePersistTimer()
    resultCachePersistTimer = setTimeout(async () => {
      resultCachePersistTimer = null
      await Promise.all([
        saveResultCache('comfyui', comfyResultStore.exportState()),
        saveResultCache('api', apiResultStore.exportState()),
      ])
    }, 120)
  }

  async function hydrateResultCaches() {
    const [cachedComfy, cachedApi] = await Promise.all([
      loadResultCache('comfyui'),
      loadResultCache('api'),
    ])

    const comfyHasLiveResults =
      Boolean(comfyResultStore.mainImage.value) || comfyResultStore.historyItems.value.length > 0
    const apiHasLiveResults =
      Boolean(apiResultStore.mainImage.value) || apiResultStore.historyItems.value.length > 0

    if (cachedComfy && !comfyHasLiveResults) {
      comfyResultStore.hydrateState(cachedComfy)
    }

    if (cachedApi && !apiHasLiveResults) {
      apiResultStore.hydrateState(cachedApi)
    }

    resultCacheHydrated = true
  }

  async function clearResultHistoryCache() {
    clearResultCachePersistTimer()
    comfyResultStore.clearResults()
    apiResultStore.clearResults()
    await Promise.all([clearResultCache('comfyui'), clearResultCache('api')])
    clearTaskError()
  }

  function startApiTaskElapsedTimer(taskId) {
    clearApiTaskElapsedTimer()
    const startedAt = Date.now()
    apiTaskElapsedMs.value = 0
    apiTaskElapsedTimer = setInterval(() => {
      const currentTask = taskStore.currentTask.value
      if (
        !currentTask ||
        currentTask.id !== taskId ||
        currentTask.kind !== 'api-generate' ||
        !['pending', 'running'].includes(currentTask.status)
      ) {
        clearApiTaskElapsedTimer()
        return
      }
      apiTaskElapsedMs.value = Date.now() - startedAt
    }, 1000)
  }

  function scheduleApiTaskRunning(taskId) {
    clearApiTaskStageTimer()
    apiTaskStageTimer = setTimeout(() => {
      apiTaskStageTimer = null
      if (
        taskStore.currentTask.value?.id === taskId &&
        taskStore.currentTask.value?.kind === 'api-generate' &&
        taskStore.currentTask.value?.status === 'pending'
      ) {
        taskStore.setTaskStatus('running')
      }
    }, 280)
  }

  function markUserStopRequested() {
    userStopRequestedAt = Date.now()
  }

  function clearUserStopRequested() {
    userStopRequestedAt = 0
  }

  function clearExecutionProgressSettleTimer() {
    if (executionProgressSettleTimer.value) {
      clearTimeout(executionProgressSettleTimer.value)
      executionProgressSettleTimer.value = null
    }
  }

  function clearExecutionProgressSettling() {
    clearExecutionProgressSettleTimer()
    executionProgressSettling.value = false
  }

  function armExecutionProgressSettling() {
    clearExecutionProgressSettleTimer()
    executionProgressSettling.value = true
    executionProgressSettleTimer.value = setTimeout(() => {
      executionProgressSettleTimer.value = null
      executionProgressSettling.value = false
    }, 420)
  }

  function hasRecentUserStopRequest() {
    return userStopRequestedAt > 0 && Date.now() - userStopRequestedAt <= USER_STOP_GRACE_MS
  }

  function isComfyExecutionTask(task = taskStore.currentTask.value) {
    return Boolean(task && ['comfyui-run', 'comfyui-run-only'].includes(task.kind))
  }

  function clearRealtimeTimer() {
    if (realtimeIntervalId) {
      clearInterval(realtimeIntervalId)
      realtimeIntervalId = null
    }
  }

  function clearRealtimePrimeTimer() {
    if (realtimePrimeTimer) {
      clearTimeout(realtimePrimeTimer)
      realtimePrimeTimer = null
    }
  }

  function setTaskError(message, options = {}) {
    const errorText = String(message || '').trim()
    if (!errorText) return
    clearTaskErrorTimer()
    taskErrorMessage.value = errorText
    const sticky = options.sticky === true
    if (sticky) return
    if (settingsSnapshot.value.showNotifications === false) return
    const duration = Math.max(1, Number(settingsSnapshot.value.notificationDuration || 3))
    taskErrorTimer.value = setTimeout(() => {
      taskErrorTimer.value = null
      taskErrorMessage.value = ''
    }, duration * 1000)
  }

  function syncConnectionBadgePhase(nextPhase, nextBadgeText = '') {
    clearConnectionBadgeTimer()

    if (nextPhase === 'connecting' || nextPhase === 'waiting') {
      connectionBadgeTimer.value = setTimeout(() => {
        connectionBadgeTimer.value = null
        if (connectionPhase.value === nextPhase) {
          connectionBadgeOverrideText.value = nextBadgeText || ''
          connectionBadgePhase.value = nextPhase
        }
      }, TRANSIENT_CONNECTION_BADGE_DELAY_MS)
      return
    }

    connectionBadgeOverrideText.value = nextBadgeText || ''
    connectionBadgePhase.value = nextPhase
  }

  function resetAutoConnectState() {
    clearConnectionRetryTimer()
    autoConnectState.value = {
      active: false,
      config: null,
      attemptIndex: 0,
    }
  }

  function setConnectionPhase(nextPhase, options = {}) {
    connectionPhase.value = nextPhase
    isConnecting.value = nextPhase === 'connecting'
    syncConnectionBadgePhase(nextPhase, options.badgeText || '')

    if (typeof options.error === 'string') {
      connectionError.value = options.error
    }

    if (nextPhase === 'connected') {
      const host = options.meta?.host || settingsSnapshot.value?.host || '127.0.0.1'
      const port = options.meta?.port || settingsSnapshot.value?.port || '8188'
      connectionStatusText.value = options.statusText || `已连接 (${host}:${port})`
      connectionError.value = ''
      return
    }

    if (nextPhase === 'connecting') {
      connectionStatusText.value = options.statusText || '连接中...'
      return
    }

    if (nextPhase === 'waiting') {
      connectionStatusText.value = options.statusText || '等待 ComfyUI'
      return
    }

    if (nextPhase === 'failed') {
      connectionStatusText.value = options.statusText || '连接失败'
      return
    }

    connectionStatusText.value = options.statusText || '未连接'
  }

  function clearConnectedUiState() {
    resetWorkflowResyncState()
    realtimeTickInFlight.value = false
    executionState.value = {
      active: false,
      progress: 0,
      promptId: null,
      updatedAt: Date.now(),
    }
    activeFrontend.value = null
    availableFrontends.value = { desktop: 0, browser: 0, unknown: 0 }
    frontendSessions.value = []
    selectedFrontendTarget.value = ''
    workflowStore.clear()
    workflowStore.toggleDropdown(false)
    workflowStore.toggleBrowser(false)
    showPromptPanel.value = false
  }

  function hasResolvedWorkflowSync() {
    return connectionStore.isConnected.value && isResolvedWorkflowState(
      currentWorkflow.value,
      workflowStore.openedTabs.value,
    )
  }

  function needsWorkflowResync() {
    return appMode.value === 'comfyui' && connectionStore.isConnected.value && !hasResolvedWorkflowSync()
  }

  // Auto-connect can beat ComfyUI tab hydration. Retry only a few times while workflow state is empty.
  function scheduleWorkflowResync(options = {}) {
    const restart = Boolean(options.restart)
    if (restart) {
      resetWorkflowResyncState()
    }

    if (!needsWorkflowResync() || workflowResyncTimer.value) {
      return
    }

    const delay =
      WORKFLOW_RESYNC_DELAYS[workflowResyncAttemptIndex] ||
      WORKFLOW_RESYNC_DELAYS[WORKFLOW_RESYNC_DELAYS.length - 1]

    workflowResyncTimer.value = setTimeout(() => {
      workflowResyncTimer.value = null

      if (!needsWorkflowResync()) {
        workflowResyncAttemptIndex = 0
        return
      }

      workflowResyncAttemptIndex += 1
      refreshWorkflowState()
    }, delay)
  }

  function mergeConnectionConfig(config = {}) {
    return normalizeSettingsSnapshot({
      ...settingsSnapshot.value,
      ...(config || {}),
    })
  }

  function scheduleNextAutoConnectRetry(lastError = '') {
    const state = autoConnectState.value
    if (!state.active || !state.config) {
      setConnectionPhase('failed', { error: lastError || connectionError.value })
      return
    }

    const delay = AUTO_CONNECT_RETRY_DELAYS[state.attemptIndex]
    if (delay == null) {
      resetAutoConnectState()
      setConnectionPhase('failed', { error: lastError || connectionError.value })
      return
    }

    autoConnectState.value = {
      ...state,
      attemptIndex: state.attemptIndex + 1,
    }
    setConnectionPhase('waiting', { error: lastError || connectionError.value })
    clearConnectionRetryTimer()
    connectionRetryTimer.value = setTimeout(() => {
      connectionRetryTimer.value = null
      performConnectAttempt(state.config, { auto: true })
    }, delay)
  }

  function performConnectAttempt(config = {}, options = {}) {
    const mergedConfig = mergeConnectionConfig(config)
    pendingConnectCancellation.value = false
    setConnectionPhase('connecting', { error: '' })

    const sent = sendToHost(HOST_MESSAGE_TYPES.CONNECT_COMFYUI, mergedConfig)

    if (!sent) {
      if (options.auto) {
        scheduleNextAutoConnectRetry('无法发送连接命令，请重新打开插件面板')
      } else {
        setConnectionPhase('failed', { error: '无法发送连接命令，请重新打开插件面板' })
      }
    }
  }

  function beginAutoConnect(config = {}) {
    const mergedConfig = mergeConnectionConfig(config)
    autoConnectState.value = {
      active: true,
      config: mergedConfig,
      attemptIndex: 0,
    }
    performConnectAttempt(mergedConfig, { auto: true })
  }

  function cancelConnectionFlow() {
    pendingConnectCancellation.value = true
    resetAutoConnectState()
    setConnectionPhase('disconnected', { error: '' })
    connectionStatusText.value = '未连接'
    sendToHost(HOST_MESSAGE_TYPES.DISCONNECT_COMFYUI, {
      ...settingsSnapshot.value,
    })
  }

  function updateConnectionState(connected, meta = {}, options = {}) {
    connectionStore.setConnected(connected, meta)

    if (connected) {
      resetAutoConnectState()
      setConnectionPhase('connected', {
        meta,
        statusText: options.statusText || '',
        badgeText: options.badgeText || '',
      })
      return
    }

    if (options.preserveUi) {
      setConnectionPhase(options.phase || 'waiting', {
        error: options.error ?? '',
        statusText: options.statusText || '',
        badgeText: options.badgeText || '',
      })
      return
    }

    setConnectionPhase(options.phase || 'disconnected', {
      error: options.error ?? '',
      statusText: options.statusText || '',
      badgeText: options.badgeText || '',
    })
    clearConnectedUiState()
  }

  function syncConnectedPhase(meta = {}, options = {}) {
    connectionStore.setConnected(true, meta)
    resetAutoConnectState()

    if (hasResolvedWorkflowSync()) {
      setConnectionPhase('connected', {
        meta,
        statusText: options.connectedStatusText || '',
        badgeText: options.connectedBadgeText || '',
      })
      return
    }

    setConnectionPhase('waiting', {
      error: '',
      statusText: options.waitingStatusText || '同步工作流...',
      badgeText: options.waitingBadgeText || '同步工作流...',
    })
    scheduleWorkflowResync({ restart: true })
  }

  function handleConnectionLifecycle(lifecycle = {}, meta = {}) {
    const status = lifecycle.status || ''
    if (!status) return false

    if (status === 'connected') {
      syncConnectedPhase(meta)
      scheduleWorkflowResync({ restart: true })
      return true
    }

    if (status === 'connecting') {
      resetWorkflowResyncState()
      connectionStore.setConnected(false, meta)
      setConnectionPhase('connecting', {
        error: '',
        statusText: '连接中...',
        badgeText: '连接中...',
      })
      return true
    }

    if (status === 'reconnecting') {
      resetWorkflowResyncState()
      connectionStore.setConnected(false, meta)
      setConnectionPhase('waiting', {
        error: '',
        statusText: '重连中...',
        badgeText: '重连中...',
      })
      return true
    }

    if (status === 'backend-unreachable') {
      resetWorkflowResyncState()
      connectionStore.setConnected(false, meta)
      setConnectionPhase('waiting', {
        error: '',
        statusText: '无法连接 ComfyUI，正在重试...',
        badgeText: '重试中...',
      })
      return true
    }

    if (status === 'manual-disconnect') {
      resetWorkflowResyncState()
      updateConnectionState(false, meta, {
        phase: 'disconnected',
        error: '',
      })
      return true
    }

    if (status === 'disconnected') {
      resetWorkflowResyncState()
      updateConnectionState(false, meta, {
        phase: 'failed',
        error: '',
      })
      return true
    }

    return false
  }

  function applyControlState(result = {}) {
    if (Object.prototype.hasOwnProperty.call(result, 'activeFrontend')) {
      activeFrontend.value = result.activeFrontend || null
    }

    if (result.availableFrontends) {
      availableFrontends.value = result.availableFrontends
    }

    if (Array.isArray(result.frontendSessions)) {
      frontendSessions.value = result.frontendSessions
    }

    if (Object.prototype.hasOwnProperty.call(result, 'selectedFrontendTarget')) {
      const explicitTarget = result.selectedFrontendTarget || ''
      selectedFrontendTarget.value =
        explicitTarget ||
        result.activeFrontend?.sessionId ||
        frontendSessions.value[0]?.session_id ||
        ''
    } else if (settingsSnapshot.value?.controlFrontendTarget) {
      selectedFrontendTarget.value = settingsSnapshot.value.controlFrontendTarget
    } else {
      selectedFrontendTarget.value =
        result.activeFrontend?.sessionId ||
        frontendSessions.value[0]?.session_id ||
        ''
    }
  }

  function applyWorkflowResult(result = {}) {
    applyControlState(result)

    const nextCurrentWorkflow = result.currentWorkflow
      ? normalizeWorkflowName(result.currentWorkflow)
      : ''
    const nextCurrentWorkflowId = result.currentWorkflowId
      ? String(result.currentWorkflowId)
      : ''

    if (Array.isArray(result.openedTabs)) {
      workflowStore.setOpenedTabs(result.openedTabs, nextCurrentWorkflow, nextCurrentWorkflowId)
    }

    if (Array.isArray(result.workflows) && !Array.isArray(result.openedTabs)) {
      workflowStore.setWorkflows(result.workflows)
    }

    if (!Array.isArray(result.openedTabs) && (nextCurrentWorkflow || nextCurrentWorkflowId)) {
      workflowStore.setCurrentWorkflow(nextCurrentWorkflow, nextCurrentWorkflowId)
    }

    if (Array.isArray(result.savedWorkflows)) {
      workflowStore.setSavedWorkflows(result.savedWorkflows)
    }

    if (Array.isArray(result.browserWorkflows)) {
      workflowStore.setSavedWorkflows(result.browserWorkflows)
    }

    const includesWorkflowState =
      Object.prototype.hasOwnProperty.call(result, 'currentWorkflow') ||
      Object.prototype.hasOwnProperty.call(result, 'currentWorkflowId') ||
      Array.isArray(result.openedTabs) ||
      Array.isArray(result.workflows)

    if (hasResolvedWorkflowSync()) {
      resetWorkflowResyncState()
      if (connectionStore.isConnected.value && connectionPhase.value !== 'connected') {
        setConnectionPhase('connected', {
          meta: connectionStore.connectionMeta.value,
        })
      }
    } else if (includesWorkflowState) {
      scheduleWorkflowResync()
    }

  }

  function onDenoise(event) {
    const nextSliderValue = Number.parseFloat(event.target.value)
    if (!Number.isFinite(nextSliderValue)) return

    const normalized = Math.min(1, Math.max(0, nextSliderValue / DENOISE_SLIDER_STEPS))
    denoiseValue.value = Math.round(normalized * DENOISE_SLIDER_STEPS) / DENOISE_SLIDER_STEPS
  }

  function stopDenoiseVisualAnimation() {
    if (denoiseVisualFrameId) {
      cancelAnimationFrame(denoiseVisualFrameId)
      denoiseVisualFrameId = null
    }
  }

  function stepDenoiseVisualAnimation() {
    denoiseVisualFrameId = null
    const current = denoiseVisualValue.value
    const target = denoiseValue.value
    const next = current + (target - current) * 0.32

    if (Math.abs(target - next) < 0.0005) {
      denoiseVisualValue.value = target
      return
    }

    denoiseVisualValue.value = next
    denoiseVisualFrameId = requestAnimationFrame(stepDenoiseVisualAnimation)
  }

  function startDenoiseVisualAnimation() {
    if (!denoiseVisualFrameId) {
      denoiseVisualFrameId = requestAnimationFrame(stepDenoiseVisualAnimation)
    }
  }

  function openWorkflowBrowser() {
    if (!connectionStore.isConnected.value) return
    closeActionMenu()
    workflowStore.toggleBrowser()
    if (!workflowStore.browserVisible.value) return

    sendToHost(HOST_MESSAGE_TYPES.OPEN_WORKFLOW_BROWSER, {
      ...settingsSnapshot.value,
    })
  }

  function handleWorkflowLoad(workflow) {
    if (!workflow?.name) return
    workflowStore.toggleBrowser(false)
    sendToHost(HOST_MESSAGE_TYPES.SWITCH_WORKFLOW, {
      workflow: workflow.name,
      workflowId: workflow.openTabId || workflow.id || null,
    })
  }

  function buildComfyPayload() {
    return {
      workflow: currentWorkflow.value,
      workflowId: currentWorkflowTab.value?.workflowId || null,
      denoise: denoiseValue.value,
      seed: seedValue.value,
      positivePrompt: positivePrompt.value,
      negativePrompt: negativePrompt.value,
      cfgScale: cfgScale.value,
      steps: stepsValue.value,
      settings: settingsSnapshot.value,
    }
  }

  function runWorkflow() {
    if (!canRunCurrentWorkflow.value) return
    clearTaskError()
    clearUserStopRequested()
    const payload = buildComfyPayload()
    taskStore.beginTask('comfyui-run', payload, { status: 'pending' })
    sendToHost(HOST_MESSAGE_TYPES.RUN_WORKFLOW, payload)
  }

  function sendOnly() {
    if (!canSendOnly.value) return
    clearTaskError()
    clearUserStopRequested()
    const payload = buildComfyPayload()
    taskStore.beginTask('comfyui-send-only', payload, { status: 'pending' })
    sendToHost(HOST_MESSAGE_TYPES.SEND_ONLY, payload)
  }

  function runOnly() {
    if (!canRunCurrentWorkflow.value) return
    clearTaskError()
    clearUserStopRequested()
    const payload = buildComfyPayload()
    taskStore.beginTask('comfyui-run-only', payload, { status: 'pending' })
    sendToHost(HOST_MESSAGE_TYPES.RUN_ONLY, payload)
  }

  function canRunRealtimeTick() {
    const requiresWorkflow = realtimeActionMode.value !== 'send'
    return (
      realtimeOn.value &&
      appMode.value === 'comfyui' &&
      connectionStore.isConnected.value &&
      !realtimeTickInFlight.value &&
      !isTaskPending.value &&
      !isExecutionRunning.value &&
      (!requiresWorkflow || isRunnableWorkflowName(currentWorkflow.value))
    )
  }

  function handleRealtimeTick() {
    if (!canRunRealtimeTick()) return
    realtimeTickInFlight.value = true
    const sent = sendToHost(HOST_MESSAGE_TYPES.REALTIME_TICK, buildComfyPayload())
    if (!sent) {
      realtimeTickInFlight.value = false
    }
  }

  function primeRealtimeTick(delayMs = 120) {
    clearRealtimePrimeTimer()
    realtimePrimeTimer = setTimeout(() => {
      realtimePrimeTimer = null
      handleRealtimeTick()
    }, delayMs)
  }

  function syncRealtimeTimer() {
    clearRealtimeTimer()

    if (!realtimeOn.value || appMode.value !== 'comfyui' || !connectionStore.isConnected.value) {
      return
    }

    const intervalSeconds = Math.max(2, Number(settingsSnapshot.value.realtimeDebounce || 5))
    realtimeIntervalId = setInterval(handleRealtimeTick, intervalSeconds * 1000)
  }

  function stopTask() {
    if (!taskStore.currentTask.value && !isExecutionRunning.value) return
    clearTaskError()
    markUserStopRequested()
    sendToHost(HOST_MESSAGE_TYPES.STOP_TASK, {})
  }

  function handleApiBadgeClick() {
    if (appMode.value !== 'api') return
    openSettingsPanel('connection')
  }

  function closeActionMenu() {
    actionMenuOpen.value = false
  }

  function toggleActionMenu() {
    if (!canOpenActionMenu.value) return
    workflowStore.toggleDropdown(false)
    actionMenuOpen.value = !actionMenuOpen.value
  }

  function handleRunPrimaryAction() {
    if (isPrimaryActionBusy.value) {
      stopTask()
      return
    }
    if (isRealtimeArmed.value) return
    runWorkflow()
  }

  function handleRunFromMenu() {
    closeActionMenu()
    runWorkflow()
  }

  function handleSendOnlyFromMenu() {
    closeActionMenu()
    sendOnly()
  }

  function handleRunOnlyFromMenu() {
    closeActionMenu()
    runOnly()
  }

  function handleDisableRealtimeFromMenu() {
    closeActionMenu()
    realtimeOn.value = false
  }

  function rerunLastTask() {
    if (!taskStore.lastTaskSnapshot.value) return
    const { kind, payload } = taskStore.lastTaskSnapshot.value
    clearUserStopRequested()
    taskStore.beginTask(kind, payload)

    const type = kind === 'api-generate' ? HOST_MESSAGE_TYPES.API_GENERATE : HOST_MESSAGE_TYPES.RERUN_TASK
    sendToHost(type, payload)
  }

  function resolveApiReferenceTargetEdge() {
    const rawValue = String(settingsSnapshot.value.apiReferenceSizeLimit || 'original')
    if (rawValue === 'original') {
      return null
    }

    if (rawValue === 'custom') {
      const customValue = Number(settingsSnapshot.value.customSizeValue || 0)
      return Number.isFinite(customValue) && customValue > 0 ? customValue : null
    }

    const nextValue = Number(rawValue)
    return Number.isFinite(nextValue) && nextValue > 0 ? nextValue : null
  }

  function loadImageElement(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('参考图加载失败'))
      img.src = dataUrl
    })
  }

  async function resizeApiReferenceImage(dataUrl, targetEdge) {
    if (!dataUrl || !targetEdge) return dataUrl

    const image = await loadImageElement(dataUrl)
    const width = image.naturalWidth || image.width || 0
    const height = image.naturalHeight || image.height || 0
    const edgeControl = settingsSnapshot.value.edgeControl === 'short' ? 'short' : 'long'
    const currentEdge = edgeControl === 'short' ? Math.min(width, height) : Math.max(width, height)

    if (!currentEdge || currentEdge <= 0 || currentEdge <= targetEdge) {
      return dataUrl
    }

    const scale = targetEdge / currentEdge
    const nextWidth = Math.max(1, Math.round(width * scale))
    const nextHeight = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = nextWidth
    canvas.height = nextHeight

    const context = canvas.getContext('2d')
    if (!context) return dataUrl

    context.drawImage(image, 0, 0, nextWidth, nextHeight)

    const mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);/i.exec(dataUrl)
    const mimeType = mimeMatch?.[1] || 'image/png'
    const outputType = ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
      ? mimeType
      : 'image/png'

    return outputType === 'image/jpeg' || outputType === 'image/webp'
      ? canvas.toDataURL(outputType, 0.92)
      : canvas.toDataURL(outputType)
  }

  async function prepareApiReferenceImages() {
    const targetEdge = resolveApiReferenceTargetEdge()
    const sourceImages = referenceImages.value.map((img) => img.data).filter(Boolean)
    if (!targetEdge || sourceImages.length === 0) {
      return sourceImages
    }

    const preparedImages = await Promise.all(
      sourceImages.map(async (imageData) => {
        try {
          return await resizeApiReferenceImage(imageData, targetEdge)
        } catch {
          return imageData
        }
      }),
    )

    return preparedImages
  }

  async function sendApiRequest() {
    if (!apiPrompt.value.trim()) return
    if (isApiTaskBusy.value) return
    clearTaskError()
    apiBadgeLastState.value = 'idle'
    apiBadgeLastError.value = ''
    const promptText = apiPrompt.value
    const preparedReferenceImages = await prepareApiReferenceImages()

    const payload = {
      prompt: promptText,
      sendCanvas: apiSendCanvas.value,
      referenceImages: preparedReferenceImages,
      settings: settingsSnapshot.value,
    }

    const task = taskStore.beginTask('api-generate', payload, { status: 'pending' })
    startApiTaskElapsedTimer(task.id)
    apiPrompt.value = ''
    const sent = sendToHost(HOST_MESSAGE_TYPES.API_GENERATE, payload)
    if (!sent) {
      clearApiTaskElapsedTimer()
      apiPrompt.value = promptText
      apiBadgeLastState.value = 'failed'
      apiBadgeLastError.value = '无法发送生成命令，请重新打开插件面板'
      setTaskError('无法发送生成命令，请重新打开插件面板', { sticky: true })
      taskStore.finishTask('error', { error: '无法发送生成命令，请重新打开插件面板' })
      return
    }
    scheduleApiTaskRunning(task.id)
  }

  function clearApiModelListState() {
    apiModelsLoading.value = false
    apiModelsError.value = ''
    apiModelOptions.value = []
  }

  function fetchApiModels(settingsOverride = null) {
    apiModelsLoading.value = true
    apiModelsError.value = ''

    const nextSettings = settingsOverride
      ? normalizePersistentSettingsSnapshot(settingsOverride)
      : settingsSnapshot.value

    const sent = sendToHost(HOST_MESSAGE_TYPES.FETCH_API_MODELS, {
      settings: nextSettings,
    })

    if (!sent) {
      apiModelsLoading.value = false
      apiModelsError.value = '无法发送模型拉取命令，请重新打开插件面板'
    }
  }

  function autoResizeTextarea(event) {
    const el = event.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`
  }

  function selectWorkflow(workflow) {
    const name = typeof workflow === 'string' ? workflow : workflow?.name
    const workflowId = typeof workflow === 'string' ? null : workflow?.id || null
    if (!name && !workflowId) return
    workflowStore.toggleDropdown(false)
    if (workflowId && workflowId === currentWorkflowId.value) return
    if (!workflowId && name === currentWorkflow.value) return
    sendToHost(HOST_MESSAGE_TYPES.SWITCH_WORKFLOW, {
      workflow: name,
      workflowId,
    })
  }

  function handleControlTargetChange(target) {
    const nextTarget = target || ''
    selectedFrontendTarget.value = nextTarget

    if (!connectionStore.isConnected.value) {
      return
    }

    sendToHost(HOST_MESSAGE_TYPES.UPDATE_CONTROL_TARGET, {
      controlFrontendTarget: nextTarget,
    })
  }

  function handleConnect(config) {
    resetAutoConnectState()
    performConnectAttempt(config || {}, { auto: false })
  }

  function refreshWorkflowState() {
    if (appMode.value !== 'comfyui' || !connectionStore.isConnected.value) return
    sendToHost(HOST_MESSAGE_TYPES.REFRESH_WORKFLOW_STATE, {
      ...settingsSnapshot.value,
    })
  }

  function handleDisconnect() {
    pendingConnectCancellation.value = false
    resetAutoConnectState()
    resetWorkflowResyncState()
    realtimeTickInFlight.value = false
    setConnectionPhase('disconnected', { error: '' })
    workflowStore.clear()
    closeActionMenu()
    sendToHost(HOST_MESSAGE_TYPES.DISCONNECT_COMFYUI, {
      ...settingsSnapshot.value,
    })
  }

  function handleConnectionBadgeClick() {
    if (appMode.value !== 'comfyui') return

    if (connectionPhase.value === 'connected') {
      handleDisconnect()
      return
    }

    if (connectionPhase.value === 'connecting' || connectionPhase.value === 'waiting') {
      cancelConnectionFlow()
      return
    }

    handleConnect(settingsSnapshot.value)
  }

  function handleConnectionBadgePointerDown(event) {
    if (event && typeof event.button === 'number' && event.button !== 0) return
    lastConnectionBadgePressAt = Date.now()
    handleConnectionBadgeClick()
  }

  function handleConnectionBadgeClickEvent() {
    if (Date.now() - lastConnectionBadgePressAt < 350) {
      return
    }

    handleConnectionBadgeClick()
  }

  function resolveResultStoreForMessage(message, result = {}) {
    const requestType = result.requestType || message.result?.requestType || ''
    if (message.type === `${HOST_MESSAGE_TYPES.API_GENERATE}_RESPONSE`) {
      return apiResultStore
    }
    if (requestType === HOST_MESSAGE_TYPES.API_GENERATE) {
      return apiResultStore
    }
    if (taskStore.currentTask.value?.kind === 'api-generate') {
      return apiResultStore
    }
    return comfyResultStore
  }

  function sendToPS() {
    const resultStore = activeResultStore.value
    if (!resultStore.mainImage.value) return
    sendToHost(HOST_MESSAGE_TYPES.ADD_IMAGE_TO_PS, {
      image: resultStore.mainImage.value,
      placement: resultStore.mainMeta.value?.placement ?? null,
      meta: resultStore.mainMeta.value ?? null,
      settings: settingsSnapshot.value,
    })
  }

  function selectHistoryItem(item) {
    if (!item?.id) return
    activeResultStore.value.swapWithHistory(item.id)
  }

  function toggleDropdown() {
    if (!connectionStore.isConnected.value) return
    closeActionMenu()
    workflowStore.toggleDropdown()
  }

  function syncSettingsToHost(nextSettings = {}) {
    const mergedSettings = normalizePersistentSettingsSnapshot(nextSettings || {})
    settingsSnapshot.value = mergedSettings
    try {
      localStorage.setItem('comfyps_settings', JSON.stringify(mergedSettings))
    } catch {
      // ignore storage failures
    }
    sendToHost(HOST_MESSAGE_TYPES.SYNC_SETTINGS, mergedSettings)
  }

  function handleSettingsChange(nextSettings = {}) {
    const mergedSettings = normalizePersistentSettingsSnapshot({
      ...settingsSnapshot.value,
      ...(nextSettings || {}),
    })

    settingsSnapshot.value = mergedSettings
    if (mergedSettings.appMode) {
      appMode.value = mergedSettings.appMode
    }
    syncSettingsToHost(mergedSettings)
  }

  function handleHostMessage(message) {
    if (message.type === HOST_EVENT_TYPES.READY) {
      sendToHost(HOST_MESSAGE_TYPES.PING)
      sendToHost(HOST_MESSAGE_TYPES.GET_SETTINGS)
      return
    }

    if (message.type === 'HOST_ERROR') {
      if (message.result?.requestType === HOST_MESSAGE_TYPES.FETCH_API_MODELS) {
        apiModelsLoading.value = false
        apiModelsError.value = message.result?.error || '模型列表读取失败'
        return
      }
      if (message.result?.requestType === HOST_MESSAGE_TYPES.REALTIME_TICK) {
        realtimeTickInFlight.value = false
      }
      if (message.result?.requestType === HOST_MESSAGE_TYPES.REFRESH_WORKFLOW_STATE) {
        scheduleWorkflowResync()
        return
      }
      const errorText = message.result?.error || '连接失败'
      const requestType = message.result?.requestType || ''
      const isConnectionFailure =
        requestType === HOST_MESSAGE_TYPES.CONNECT_COMFYUI || requestType === HOST_MESSAGE_TYPES.TEST_CONNECTION
      if (requestType === HOST_MESSAGE_TYPES.STOP_TASK) {
        clearUserStopRequested()
      }
      if (isConnectionFailure && autoConnectState.value.active) {
        scheduleNextAutoConnectRetry(errorText)
      } else if (isConnectionFailure) {
        setConnectionPhase('failed', { error: errorText })
      } else {
        connectionError.value = errorText
        const isApiRequestFailure = requestType === HOST_MESSAGE_TYPES.API_GENERATE
        if (isApiRequestFailure) {
          apiBadgeLastState.value = 'failed'
          apiBadgeLastError.value = errorText
        }
        setTaskError(errorText, { sticky: isApiRequestFailure })
        if (
          requestType === HOST_MESSAGE_TYPES.API_GENERATE &&
          !apiPrompt.value &&
          typeof taskStore.currentTask.value?.payload?.prompt === 'string'
        ) {
          apiPrompt.value = taskStore.currentTask.value.payload.prompt
        }
        clearApiTaskStageTimer()
        clearApiTaskElapsedTimer()
        taskStore.finishTask('error', { error: errorText })
      }
      return
    }

    if (message.type === `${HOST_MESSAGE_TYPES.GET_SETTINGS}_RESPONSE`) {
      const hostSettings = message.result?.settings || {}
      const hasHostSettings = Object.keys(hostSettings).length > 0
      const effectiveSettings = hasHostSettings
        ? normalizePersistentSettingsSnapshot(hostSettings)
        : pendingLocalSettings
          ? normalizePersistentSettingsSnapshot(pendingLocalSettings)
          : normalizePersistentSettingsSnapshot()

      settingsSnapshot.value = effectiveSettings
      appMode.value = effectiveSettings.appMode || 'comfyui'
      selectedFrontendTarget.value = effectiveSettings.controlFrontendTarget || ''

      if (!hasHostSettings) {
        syncSettingsToHost(effectiveSettings)
      }

      if (!settingsBootstrapped && effectiveSettings.autoConnect && effectiveSettings.appMode !== 'api') {
        beginAutoConnect(effectiveSettings)
      }

      settingsBootstrapped = true
      return
    }

    if (message.type === HOST_EVENT_TYPES.SETTINGS_UPDATED && message.payload) {
      settingsSnapshot.value = normalizePersistentSettingsSnapshot(message.payload || {})
      try {
        localStorage.setItem('comfyps_settings', JSON.stringify(settingsSnapshot.value))
      } catch {
        // ignore storage failures
      }
      if (message.payload.appMode) {
        appMode.value = message.payload.appMode
      }
      return
    }

    if (typeof message.connected === 'boolean' && !message.result?.connectionLifecycle) {
      if (message.connected) {
        syncConnectedPhase(message.meta ?? {})
      } else {
        updateConnectionState(false, message.meta ?? {})
      }
    }

    if (typeof message.isConnected === 'boolean' && !message.result?.connectionLifecycle) {
      if (message.isConnected) {
        syncConnectedPhase(message.meta ?? {})
      } else {
        updateConnectionState(false, message.meta ?? {})
      }
    }

    const result = message.result || {}

    if (message.type === `${HOST_MESSAGE_TYPES.FETCH_API_MODELS}_RESPONSE`) {
      apiModelsLoading.value = false
      if (result.error) {
        apiModelsError.value = result.error
      } else {
        const models = Array.isArray(result.models) ? result.models : []
        apiModelOptions.value = models
          .map((modelEntry) => {
            if (typeof modelEntry === 'string') {
              return {
                label: modelEntry,
                value: modelEntry,
                group: '未分类',
                groupLabel: '未分类',
                owner: '',
                score: 0,
                isImageLikely: false,
                supportedEndpointTypes: ['image-generation'],
                endpointType: 'image-generation',
              }
            }

            const value = String(modelEntry?.id || modelEntry?.model || '').trim()
            if (!value) return null

            const group = String(modelEntry?.group || modelEntry?.groupLabel || modelEntry?.owner || '').trim() || '未分类'
            const label = String(modelEntry?.label || modelEntry?.name || value).trim() || value
            const supportedEndpointTypes = Array.isArray(modelEntry?.supportedEndpointTypes)
              ? modelEntry.supportedEndpointTypes
              : Array.isArray(modelEntry?.supported_endpoint_types)
                ? modelEntry.supported_endpoint_types
                : []
            return {
              label,
              value,
              group,
              groupLabel: group,
              owner: String(modelEntry?.owner || '').trim(),
              score: Number(modelEntry?.score || 0),
              isImageLikely: Boolean(modelEntry?.isImageLikely),
              supportedEndpointTypes: supportedEndpointTypes
                .map((item) => String(item || '').trim())
                .filter(Boolean),
              endpointType: String(modelEntry?.endpointType || modelEntry?.endpoint_type || '').trim(),
            }
          })
          .filter(Boolean)
        apiModelsError.value = models.length ? '' : '没有读取到可用模型'
      }
      return
    }

    if (result.connectionLifecycle) {
      handleConnectionLifecycle(result.connectionLifecycle, result.meta ?? message.meta ?? {})
    }

    if (result.executionState && typeof result.executionState.active === 'boolean') {
      const wasActive = executionState.value.active
      executionState.value = {
        active: Boolean(result.executionState.active),
        progress: Number(result.executionState.progress || 0),
        promptId: result.executionState.promptId || null,
        updatedAt: result.executionState.updatedAt || Date.now(),
      }

      if (executionState.value.active || executionState.value.progress < 100) {
        clearExecutionProgressSettling()
      }

      const currentTask = taskStore.currentTask.value
      const isComfyRunTask = isComfyExecutionTask(currentTask)

      if (executionState.value.active && isComfyRunTask) {
        taskStore.setTaskStatus('running', {
          promptId: executionState.value.promptId,
        })
      }

      if (!executionState.value.active && wasActive && isComfyRunTask) {
        if (hasRecentUserStopRequest()) {
          clearExecutionProgressSettling()
          clearTaskError()
          taskStore.finishTask('stopped')
        } else {
          if (executionState.value.progress >= 100) {
            armExecutionProgressSettling()
          }
          taskStore.finishTask('done', {
            promptId: executionState.value.promptId,
          })
        }
      }
    } else if (typeof result.progress === 'number') {
      executionState.value = {
        ...executionState.value,
        progress: Number(result.progress || 0),
        updatedAt: Date.now(),
      }
      if (executionState.value.progress > 0 && executionState.value.progress < 100) {
        clearExecutionProgressSettling()
      }
    }

    if (typeof result.connected === 'boolean' && !result.connectionLifecycle) {
      if (result.connected) {
        syncConnectedPhase(result.meta ?? {})
      } else {
        updateConnectionState(false, result.meta ?? {})
      }
    }

    applyWorkflowResult(result)

    if (message.type === `${HOST_MESSAGE_TYPES.CONNECT_COMFYUI}_RESPONSE`) {
      if (pendingConnectCancellation.value) {
        pendingConnectCancellation.value = false
        if (result.connected) {
          handleDisconnect()
        }
        return
      }

      if (result.error) {
        if (autoConnectState.value.active) {
          scheduleNextAutoConnectRetry(result.error)
        } else {
          setConnectionPhase('failed', { error: result.error })
        }
      } else if (result.connected) {
        syncConnectedPhase(result.meta ?? {})
      }
    }

    if (message.type === `${HOST_MESSAGE_TYPES.OPEN_WORKFLOW_BROWSER}_RESPONSE`) {
      applyWorkflowResult({
        workflows: result.workflows,
        openedTabs: result.openedTabs,
        currentWorkflow: result.currentWorkflow,
        savedWorkflows: result.browserWorkflows || result.savedWorkflows,
        activeFrontend: result.activeFrontend,
        availableFrontends: result.availableFrontends,
        frontendSessions: result.frontendSessions,
        selectedFrontendTarget: result.selectedFrontendTarget,
      })
    }

    if (message.type === `${HOST_MESSAGE_TYPES.SWITCH_WORKFLOW}_RESPONSE`) {
      applyWorkflowResult(result)
    }

    if (message.type === `${HOST_MESSAGE_TYPES.RUN_WORKFLOW}_RESPONSE`) {
      if (!result.error) {
        clearExecutionProgressSettling()
        closeActionMenu()
        taskStore.setTaskStatus('pending', {
          accepted: Boolean(result.accepted),
          promptId: result.promptId || null,
        })
      }
    }

    if (message.type === `${HOST_MESSAGE_TYPES.SEND_ONLY}_RESPONSE`) {
      if (!result.error) {
        closeActionMenu()
        taskStore.finishTask('done', {
          accepted: Boolean(result.accepted),
        })
      }
    }

    if (message.type === `${HOST_MESSAGE_TYPES.RUN_ONLY}_RESPONSE`) {
      if (!result.error) {
        clearExecutionProgressSettling()
        closeActionMenu()
        taskStore.setTaskStatus('pending', {
          accepted: Boolean(result.accepted),
          promptId: result.promptId || null,
        })
      }
    }

    if (message.type === `${HOST_MESSAGE_TYPES.REALTIME_TICK}_RESPONSE`) {
      realtimeTickInFlight.value = false
    }

    if (message.type === `${HOST_MESSAGE_TYPES.UPDATE_CONTROL_TARGET}_RESPONSE`) {
      applyWorkflowResult(result)
    }

    if (message.type === `${HOST_MESSAGE_TYPES.DISCONNECT_COMFYUI}_RESPONSE`) {
      realtimeTickInFlight.value = false
      clearExecutionProgressSettling()
      setConnectionPhase('disconnected', { error: '' })
      workflowStore.clear()
    }

    if (result.error) {
      if (hasRecentUserStopRequest() && isComfyExecutionTask()) {
        clearExecutionProgressSettling()
        executionState.value = {
          active: false,
          progress: 0,
          promptId: null,
          updatedAt: Date.now(),
        }
        clearTaskError()
        taskStore.finishTask('stopped')
        return
      }
      if (message.type !== `${HOST_MESSAGE_TYPES.CONNECT_COMFYUI}_RESPONSE`) {
        connectionError.value = connectionError.value || result.error
        const isApiResultFailure =
          message.type === `${HOST_MESSAGE_TYPES.API_GENERATE}_RESPONSE` ||
          taskStore.currentTask.value?.kind === 'api-generate'
        if (isApiResultFailure) {
          apiBadgeLastState.value = 'failed'
          apiBadgeLastError.value = result.error
        }
        setTaskError(result.error, { sticky: isApiResultFailure })
      }
      if (
        taskStore.currentTask.value?.kind === 'api-generate' &&
        !apiPrompt.value &&
        typeof taskStore.currentTask.value?.payload?.prompt === 'string'
      ) {
        apiPrompt.value = taskStore.currentTask.value.payload.prompt
      }
      clearExecutionProgressSettling()
      clearApiTaskStageTimer()
      clearApiTaskElapsedTimer()
      executionState.value = {
        active: false,
        progress: 0,
        promptId: null,
        updatedAt: Date.now(),
      }
      taskStore.finishTask('error', { error: result.error })
    }

    if (result.stopped) {
      apiBadgeLastState.value = 'idle'
      apiBadgeLastError.value = ''
      markUserStopRequested()
      if (
        taskStore.currentTask.value?.kind === 'api-generate' &&
        !apiPrompt.value &&
        typeof taskStore.currentTask.value?.payload?.prompt === 'string'
      ) {
        apiPrompt.value = taskStore.currentTask.value.payload.prompt
      }
      clearExecutionProgressSettling()
      clearApiTaskStageTimer()
      clearApiTaskElapsedTimer()
      executionState.value = {
        active: false,
        progress: 0,
        promptId: null,
        updatedAt: Date.now(),
      }
      clearTaskError()
      taskStore.finishTask('stopped')
    }

    const incomingImage = result.image ?? message.payload?.image
    if (incomingImage) {
      const resultStore = resolveResultStoreForMessage(message, result)
      if (resultStore === apiResultStore) {
        apiBadgeLastState.value = 'success'
        apiBadgeLastError.value = ''
      }
      clearUserStopRequested()
      executionState.value = {
        active: false,
        progress: 100,
        promptId: null,
        updatedAt: Date.now(),
      }
      armExecutionProgressSettling()
      resultStore.pushIncomingResult(incomingImage, result.meta ?? message.payload?.meta ?? {})
      clearApiTaskStageTimer()
      clearApiTaskElapsedTimer()
      taskStore.finishTask('done')
    }
  }

  function onClickOutside(event) {
    if (dropdownRef.value && !dropdownRef.value.contains(event.target)) {
      workflowStore.toggleDropdown(false)
    }
    if (actionMenuRef.value && !actionMenuRef.value.contains(event.target)) {
      closeActionMenu()
    }
  }

  let unsubscribeHost = null
  const handleWindowFocus = () => {
    refreshWorkflowState()
  }
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      refreshWorkflowState()
    }
  }

  onMounted(() => {
    document.addEventListener('click', onClickOutside)
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    unsubscribeHost = subscribeHostMessages(handleHostMessage)

    try {
      const saved = localStorage.getItem('comfyps_settings')
      if (saved) {
        pendingLocalSettings = normalizePersistentSettingsSnapshot(JSON.parse(saved))
        if (pendingLocalSettings?.appMode) {
          appMode.value = pendingLocalSettings.appMode
        }
      }
    } catch {
      pendingLocalSettings = null
    }

    hydrateResultCaches()
  })

  watch(
    [
      appMode,
      () => settingsSnapshot.value.realtimeDebounce,
      currentWorkflow,
      isTaskPending,
      isExecutionRunning,
    ],
    () => {
      syncRealtimeTimer()
    },
    { immediate: true },
  )

  watch(realtimeOn, (nextValue, previousValue) => {
    syncRealtimeTimer()

    if (nextValue && !previousValue) {
      primeRealtimeTick()
      return
    }

    if (!nextValue) {
      clearRealtimePrimeTimer()
      realtimeTickInFlight.value = false
    }
  })

  watch(
    denoiseValue,
    () => {
      startDenoiseVisualAnimation()
    },
    { immediate: true },
  )

  watch(
    () => connectionStore.isConnected.value,
    (nextValue, previousValue) => {
      syncRealtimeTimer()

      if (realtimeOn.value && nextValue && !previousValue) {
        primeRealtimeTick(180)
      }

      if (!nextValue) {
        clearRealtimePrimeTimer()
        realtimeTickInFlight.value = false
      }
    },
    { immediate: true },
  )

  watch(
    () => [settingsSnapshot.value.apiProvider, settingsSnapshot.value.apiBaseUrl, settingsSnapshot.value.apiKey].join('|'),
    () => {
      clearApiModelListState()
    },
  )

  watch(
    () => {
      const profile = activeApiProfile.value
      return [
        profile?.id || '',
        profile?.name || '',
        profile?.apiKey || '',
        profile?.baseUrl || '',
        profile?.activeModel || profile?.model || '',
      ].join('|')
    },
    () => {
      apiBadgeLastState.value = 'idle'
      apiBadgeLastError.value = ''
    },
  )

  watch(
    [
      comfyResultStore.mainImage,
      comfyResultStore.mainMeta,
      comfyResultStore.historyItems,
      comfyResultStore.activeHistoryId,
      apiResultStore.mainImage,
      apiResultStore.mainMeta,
      apiResultStore.historyItems,
      apiResultStore.activeHistoryId,
    ],
    () => {
      schedulePersistResultCaches()
    },
    { deep: true },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('click', onClickOutside)
    window.removeEventListener('focus', handleWindowFocus)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    clearConnectionRetryTimer()
    clearConnectionBadgeTimer()
    resetWorkflowResyncState()
    clearTaskErrorTimer()
    clearExecutionProgressSettling()
    clearRealtimeTimer()
    clearRealtimePrimeTimer()
    clearApiTaskStageTimer()
    clearApiTaskElapsedTimer()
    clearResultCachePersistTimer()
    stopDenoiseVisualAnimation()
    unsubscribeHost?.()
  })

  return {
    actionMenuOpen,
    actionMenuRef,
    activeSlot: activeHistoryId,
    apiBadgePhase: computed(() => apiBadgeState.value.phase),
    apiBadgeText: computed(() => apiBadgeState.value.text),
    apiBadgeTitle: computed(() => apiBadgeState.value.title),
    apiHistoryBottom,
    apiModelOptions,
    apiModelsError,
    apiModelsLoading,
    apiPrompt,
    apiSendCanvas,
    apiTaskHintText,
    appMode,
    currentWorkflowModified,
    autoResizeTextarea,
    canOpenActionMenu,
    executionProgressPercent,
    executionProgressStage,
    executionProgressText,
    clearApiModelListState,
    fetchApiModels,
    showExecutionProgress,
    canRerun,
    canRunCurrentWorkflow,
    canSendOnly,
    canTriggerPrimaryAction,
    closeActionMenu,
    connectionActionTitle,
    connectionBadgePhase,
    connectionBadgeText,
    connectionError,
    connectionPhase,
    connectionStatusText,
    taskErrorMessage,
    frontendTargetOptions,
    currentTask: taskStore.currentTask,
    currentWorkflow,
    currentWorkflowId,
    cfgScale,
    clearResultHistoryCache,
    denoiseDisplay,
    denoiseInt,
    denoiseValue,
    denoiseVisualPosition,
    dropdownOpen: workflowStore.dropdownOpen,
    dropdownRef,
    effectiveDenoiseLinked,
    handleApiBadgeClick,
    handleConnect,
    handleConnectionBadgeClickEvent,
    handleConnectionBadgePointerDown,
    handleControlTargetChange,
    handleDisconnect,
    handleSettingsChange,
    handleDisableRealtimeFromMenu,
    handleRunFromMenu,
    handleRunOnlyFromMenu,
    handleRunPrimaryAction,
    handleSendOnlyFromMenu,
    handleWorkflowLoad,
    hasAnyResultHistory,
    historyItems: activeHistoryItems,
    isConnected: connectionStore.isConnected,
    isApiTaskBusy,
    isConnecting,
    isExecutionProgressIndeterminate,
    isExecutionRunning,
    isPrimaryActionBusy,
    isPrimaryActionDisabled: primaryActionDisabled,
    isRealtimeArmed,
    isTaskRunning,
    isTaskPending,
    mainImage: activeMainImage,
    mainMeta: activeMainMeta,
    negativePrompt,
    onDenoise,
    openWorkflowBrowser,
    primaryActionDisplayLabel,
    primaryActionDisplayTitle,
    primaryActionLabel,
    primaryActionTitle,
    positivePrompt,
    realtimeOn,
    realtimeActionMode,
    referenceImages,
    referencePanelExpanded,
    rerunLastTask,
    runOnly,
    runWorkflow,
    savedWorkflows: workflowStore.savedWorkflows,
    selectHistoryItem,
    selectWorkflow,
    selectedFrontendTarget,
    sendApiRequest,
    sendOnly,
    sendToPS,
    seedValue,
    settingsSnapshot,
    settingsActiveTab,
    showPromptPanel,
    showSettings,
    showWorkflowBrowser: workflowStore.browserVisible,
    openSettingsPanel,
    stepsValue,
    stopTask,
    toggleActionMenu,
    toggleDropdown,
    openedWorkflowTabs: workflowStore.openedTabs,
    workflows: workflowStore.workflows,
  }
}
