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

const DIAGNOSTIC_STORAGE_KEY = 'comfyps_diagnostic_log_v1'
const DIAGNOSTIC_LOG_LIMIT = 180

function normalizeWorkflowName(name) {
  return name || UNSYNCED_WORKFLOW_LABEL
}

function normalizePersistentSettingsSnapshot(rawSettings = {}) {
  return {
    ...normalizeSettingsSnapshot(rawSettings || {}),
    controlFrontendTarget: '',
  }
}

function truncateDiagnosticString(value, maxLength = 280) {
  const text = String(value ?? '')
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function sanitizeDiagnosticDetails(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (depth >= 3) return truncateDiagnosticString(value, 160)

  if (typeof value === 'string') {
    return truncateDiagnosticString(value, 280)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeDiagnosticDetails(item, depth + 1))
  }

  if (typeof value === 'object') {
    const nextObject = {}
    for (const key of Object.keys(value).slice(0, 16)) {
      if (/(^|_)(image|raw|pixels|data_url|data)$/i.test(String(key))) {
        continue
      }
      const normalizedValue = sanitizeDiagnosticDetails(value[key], depth + 1)
      if (normalizedValue === undefined) continue
      nextObject[key] = normalizedValue
    }
    return nextObject
  }

  return truncateDiagnosticString(value, 120)
}

function loadStoredDiagnosticEntries() {
  try {
    const raw = localStorage.getItem(DIAGNOSTIC_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => ({
        id: String(entry?.id || ''),
        ts: Number(entry?.ts || Date.now()),
        level: String(entry?.level || 'info'),
        scope: String(entry?.scope || 'app'),
        message: truncateDiagnosticString(entry?.message || '', 220),
        details: sanitizeDiagnosticDetails(entry?.details ?? {}, 0),
      }))
      .filter((entry) => entry.id && entry.message)
      .slice(0, DIAGNOSTIC_LOG_LIMIT)
  } catch {
    return []
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
  const detectedComfyInstances = ref([])
  const isScanningComfyInstances = ref(false)
  const instanceScanStatusText = ref('')
  const pendingInstanceScanContext = ref(null)
  const shuttingDownInstanceIds = ref([])
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
  let nextInstanceScanSequence = 0
  let instanceScanRefreshTimer = null

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
  const diagnosticEntries = ref(loadStoredDiagnosticEntries())

  function persistDiagnosticEntries() {
    try {
      localStorage.setItem(
        DIAGNOSTIC_STORAGE_KEY,
        JSON.stringify(diagnosticEntries.value.slice(0, DIAGNOSTIC_LOG_LIMIT)),
      )
    } catch {
      // ignore persistence failures
    }
  }

  function appendDiagnosticLog(level = 'info', scope = 'app', message = '', details = {}) {
    const normalizedMessage = truncateDiagnosticString(message || '', 220).trim()
    if (!normalizedMessage) return

    diagnosticEntries.value = [
      {
        id: `diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
        scope: String(scope || 'app').trim() || 'app',
        message: normalizedMessage,
        details: sanitizeDiagnosticDetails(details ?? {}, 0),
      },
      ...diagnosticEntries.value,
    ].slice(0, DIAGNOSTIC_LOG_LIMIT)

    persistDiagnosticEntries()
  }

  function clearDiagnosticLogs() {
    diagnosticEntries.value = []
    persistDiagnosticEntries()
  }

  function formatDiagnosticTimestamp(timestamp) {
    try {
      return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
    } catch {
      return String(timestamp || '')
    }
  }

  function buildDiagnosticSettingsSummary() {
    return sanitizeDiagnosticDetails({
      appMode: appMode.value,
      host: settingsSnapshot.value.host,
      port: settingsSnapshot.value.port,
      autoConnect: settingsSnapshot.value.autoConnect,
      captureMode: settingsSnapshot.value.captureMode,
      layerBoundaryMode: settingsSnapshot.value.layerBoundaryMode,
      useSelection: settingsSnapshot.value.useSelection,
      selectionSendMode: settingsSnapshot.value.selectionSendMode,
      sizeLimit: settingsSnapshot.value.sizeLimit,
      imageFormat: settingsSnapshot.value.imageFormat,
      jpegQuality: settingsSnapshot.value.jpegQuality,
      realtimeAction: settingsSnapshot.value.realtimeAction,
      realtimeDebounce: settingsSnapshot.value.realtimeDebounce,
    })
  }

  const diagnosticSummaryText = computed(() => {
    const headerLines = [
      'ComfyPS Bridge Diagnostic Log',
      `Generated: ${formatDiagnosticTimestamp(Date.now())}`,
      `App Mode: ${appMode.value}`,
      `Connection: ${connectionPhase.value}${activeConnectionEndpointText.value ? ` (${activeConnectionEndpointText.value})` : ''}`,
      `Workflow: ${currentWorkflow.value || ''}`,
      `Task: ${taskStore.currentTask.value?.kind || 'none'} / ${taskStore.currentTask.value?.status || 'idle'}`,
      `Settings: ${JSON.stringify(buildDiagnosticSettingsSummary(), null, 2)}`,
      '',
      `Recent Events (${diagnosticEntries.value.length}):`,
    ]

    const eventLines = diagnosticEntries.value.map((entry) => {
      const lines = [
        `[${formatDiagnosticTimestamp(entry.ts)}] [${String(entry.level || 'info').toUpperCase()}] [${entry.scope}] ${entry.message}`,
      ]
      if (entry.details && Object.keys(entry.details).length > 0) {
        lines.push(JSON.stringify(entry.details, null, 2))
      }
      return lines.join('\n')
    })

    return [...headerLines, ...eventLines].join('\n')
  })

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
  const activeConnectionEndpointText = computed(() => {
    if (!connectionStore.isConnected.value) return ''
    const host = String(connectionStore.connectionMeta.value?.host || '').trim()
    const port = String(connectionStore.connectionMeta.value?.port || '').trim()
    if (!host || !port) return ''
    return `${host}:${port}`
  })
  const connectedDetectedInstance = computed(() => {
    const endpoint = activeConnectionEndpointText.value
    if (!endpoint) return null

    const existing = detectedComfyInstances.value.find((instance) => instance.id === endpoint)
    if (existing) {
      return {
        ...existing,
        hasActiveFrontend: true,
      }
    }

    const [host = '', port = ''] = endpoint.split(':')
    if (!host || !port) return null

    const primarySession = frontendSessions.value[0] || null
    const primaryKind = String(primarySession?.kind || activeFrontend.value?.kind || 'desktop').trim()
    const primaryTabName = String(
      primarySession?.current_tab_name ||
        currentWorkflow.value ||
        activeFrontend.value?.currentTabName ||
        activeFrontend.value?.tabName ||
        '',
    ).trim()
    const kindLabel =
      primaryKind === 'browser'
        ? '网页端'
        : primaryKind === 'desktop'
          ? '桌面端'
          : '当前前端'

    return {
      id: endpoint,
      host,
      port,
      bridgeVersion: '',
      service: 'TuNanPaintBridge',
      hasActiveFrontend: true,
      frontendLabel: primaryTabName ? `${kindLabel} · ${primaryTabName}` : kindLabel,
      psConnected: true,
      websocketClients: 1,
      statusText: 'Photoshop 已连接',
    }
  })
  const visibleDetectedComfyInstances = computed(() =>
    {
      const activeInstances = detectedComfyInstances.value.filter((instance) => instance.hasActiveFrontend)
      const connectedInstance = connectedDetectedInstance.value

      if (connectedInstance && !activeInstances.some((instance) => instance.id === connectedInstance.id)) {
        return [connectedInstance, ...activeInstances]
      }

      return activeInstances
    },
  )
  const inactiveDetectedComfyInstances = computed(() => {
    const activeIds = new Set(visibleDetectedComfyInstances.value.map((instance) => instance.id))
    const currentEndpoint = activeConnectionEndpointText.value

    return detectedComfyInstances.value
      .filter((instance) => !activeIds.has(instance.id))
      .sort((left, right) => {
        const leftCurrent = left.id === currentEndpoint
        const rightCurrent = right.id === currentEndpoint
        if (leftCurrent !== rightCurrent) {
          return leftCurrent ? -1 : 1
        }
        return Number(left.port || 0) - Number(right.port || 0)
      })
  })
  // Keep retrying long enough for "plugin first, ComfyUI later" startup.
  const AUTO_CONNECT_RETRY_DELAYS = [1200, 2500, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]
  const WORKFLOW_RESYNC_DELAYS = [260, 720, 1600, 3000, 5000]
  const USER_STOP_GRACE_MS = 6000
  const TRANSIENT_CONNECTION_BADGE_DELAY_MS = 420
  const INSTANCE_SCAN_REFRESH_MS = 3000
  const WORKFLOW_SYNC_FALLBACK_SCAN_ATTEMPT = 2

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

  function clearInstanceScanRefreshTimer() {
    if (instanceScanRefreshTimer) {
      clearInterval(instanceScanRefreshTimer)
      instanceScanRefreshTimer = null
    }
  }

  function syncInstanceScanRefreshTimer() {
    clearInstanceScanRefreshTimer()
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
    if (tab && ['connection', 'layer', 'document', 'interface', 'diagnostic'].includes(tab)) {
      settingsActiveTab.value = tab
    }
    showSettings.value = true
    syncInstanceScanRefreshTimer()
    const nextTab = tab || settingsActiveTab.value
    if (appMode.value === 'comfyui' && nextTab === 'connection' && !connectionStore.isConnected.value) {
      requestComfyInstanceScan(settingsSnapshot.value, { auto: false })
    }
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
    appendDiagnosticLog('error', 'task', errorText, {
      sticky: options.sticky === true,
      kind: taskStore.currentTask.value?.kind || '',
      status: taskStore.currentTask.value?.status || '',
    })
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

  function clearInstanceScanState(options = {}) {
    pendingInstanceScanContext.value = null
    isScanningComfyInstances.value = false

    if (options.clearResults) {
      detectedComfyInstances.value = []
      instanceScanStatusText.value = ''
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

      if (workflowResyncAttemptIndex >= WORKFLOW_SYNC_FALLBACK_SCAN_ATTEMPT) {
        requestComfyInstanceScan(
          {
            ...settingsSnapshot.value,
            ...connectionStore.connectionMeta.value,
          },
          {
            auto: false,
            reason: 'workflow-sync',
          },
        )
      }

      refreshWorkflowState()
    }, delay)
  }

  function mergeConnectionConfig(config = {}) {
    return normalizeSettingsSnapshot({
      ...settingsSnapshot.value,
      ...(config || {}),
    })
  }

  function normalizeDetectedComfyInstances(instances = []) {
    if (!Array.isArray(instances)) return []

    return instances
      .map((instance) => {
        const host = String(instance?.host || '').trim()
        const port = String(instance?.port || '').trim()
        if (!host || !port) return null

        return {
          id: `${host}:${port}`,
          host,
          port,
          bridgeVersion: String(instance?.bridgeVersion || instance?.version || '').trim(),
          service: String(instance?.service || 'TuNanPaintBridge').trim() || 'TuNanPaintBridge',
          hasActiveFrontend: Boolean(instance?.hasActiveFrontend),
          frontendLabel: String(instance?.frontendLabel || '').trim(),
          psConnected: Boolean(instance?.psConnected),
          websocketClients: Math.max(0, Number(instance?.websocketClients || 0) || 0),
          statusText: String(instance?.statusText || '').trim(),
        }
      })
      .filter(Boolean)
  }

  function buildDetectedInstancesStatusText(instances = []) {
    const activeFrontendInstances = instances.filter((instance) => instance.hasActiveFrontend)
    const inactiveInstances = instances.filter((instance) => !instance.hasActiveFrontend)

    if (!activeFrontendInstances.length) {
      if (inactiveInstances.length > 0) {
        return `未发现活动中的 ComfyUI 前端，检测到 ${inactiveInstances.length} 个后台残留`
      }
      return '未发现活动中的 ComfyUI 前端'
    }

    if (activeFrontendInstances.length === 1) {
      const onlyInstance = activeFrontendInstances[0]
      return inactiveInstances.length
        ? `发现 1 个活动前端：${onlyInstance.host}:${onlyInstance.port}，另外有 ${inactiveInstances.length} 个后台残留`
        : `发现 1 个活动前端：${onlyInstance.host}:${onlyInstance.port}`
    }

    return inactiveInstances.length
      ? `发现 ${activeFrontendInstances.length} 个活动前端，另外有 ${inactiveInstances.length} 个后台残留`
      : `发现 ${activeFrontendInstances.length} 个活动前端，请选择要连接的端口`
  }

  function syncDetectedComfyInstances(instances = [], options = {}) {
    const normalizedInstances = normalizeDetectedComfyInstances(instances)
    detectedComfyInstances.value = normalizedInstances

    if (options.preserveStatusText) {
      return normalizedInstances
    }

    instanceScanStatusText.value = buildDetectedInstancesStatusText(normalizedInstances)
    return normalizedInstances
  }

  function pickPreferredAutoConnectInstance(instances = []) {
    const activeFrontendInstances = instances.filter((instance) => instance.hasActiveFrontend)
    if (activeFrontendInstances.length === 1) {
      return activeFrontendInstances[0]
    }

    return null
  }

  function rememberSuccessfulConnection(meta = {}) {
    const host = String(meta?.host || '').trim()
    const port = String(meta?.port || '').trim()
    if (!host || !port || appMode.value !== 'comfyui') return

    if (host === String(settingsSnapshot.value.host || '').trim() && port === String(settingsSnapshot.value.port || '').trim()) {
      return
    }

    syncSettingsToHost({
      ...settingsSnapshot.value,
      host,
      port,
    })
  }

  function requestComfyInstanceScan(config = {}, options = {}) {
    if (isScanningComfyInstances.value) {
      return
    }

    const mergedConfig = mergeConnectionConfig(config)
    const scanId = `scan_${Date.now()}_${nextInstanceScanSequence.toString(36)}`
    nextInstanceScanSequence += 1

    pendingInstanceScanContext.value = {
      scanId,
      auto: options.auto === true,
      reason: String(options.reason || '').trim() || 'manual',
      config: mergedConfig,
      lastError: String(options.lastError || '').trim(),
    }
    isScanningComfyInstances.value = true

    if (options.auto) {
      setConnectionPhase('waiting', {
        error: options.lastError || '',
        statusText: '正在扫描本机 ComfyUI...',
        badgeText: '扫描中...',
      })
    } else {
      instanceScanStatusText.value = '正在扫描本机 ComfyUI...'
    }

    appendDiagnosticLog('info', 'connection', options.auto ? '自动扫描本机 ComfyUI 实例' : '手动扫描本机 ComfyUI 实例', {
      host: mergedConfig.host,
      port: mergedConfig.port,
      reason: options.reason || 'manual',
      lastError: options.lastError || '',
    })

    const sent = sendToHost(HOST_MESSAGE_TYPES.SCAN_COMFYUI_INSTANCES, {
      ...mergedConfig,
      scanId,
    })

    if (sent) {
      return
    }

    pendingInstanceScanContext.value = null
    isScanningComfyInstances.value = false

    if (options.auto) {
      scheduleNextAutoConnectRetry('无法扫描本机 ComfyUI 实例，请重新打开插件面板')
      return
    }

    instanceScanStatusText.value = '无法发送扫描命令，请重新打开插件面板'
  }

  function handleAutoConnectDiscoveryResult(instances = [], context = {}) {
    const autoSelectedInstance = pickPreferredAutoConnectInstance(instances)
    if (autoSelectedInstance) {
      const requestedHost = String(context.config?.host || '').trim()
      const requestedPort = String(context.config?.port || '').trim()
      const sameAsRequested =
        autoSelectedInstance.host === requestedHost && autoSelectedInstance.port === requestedPort

      if (sameAsRequested) {
        scheduleNextAutoConnectRetry(
          context.lastError || `已发现 ${autoSelectedInstance.host}:${autoSelectedInstance.port}，正在等待桥接就绪...`,
        )
        return
      }

      const nextConfig = mergeConnectionConfig({
        ...context.config,
        host: autoSelectedInstance.host,
        port: autoSelectedInstance.port,
      })
      autoConnectState.value = {
        ...autoConnectState.value,
        config: nextConfig,
      }
      const autoConnectReason =
        instances.length > 1 && autoSelectedInstance.hasActiveFrontend
          ? `发现当前活动的 ComfyUI，正在连接 ${autoSelectedInstance.host}:${autoSelectedInstance.port}...`
          : `发现实例，正在连接 ${autoSelectedInstance.host}:${autoSelectedInstance.port}...`
      scheduleConnectToConfig(nextConfig, {
        auto: true,
        statusText: autoConnectReason,
        badgeText: '自动连接',
      })
      return
    }

    const activeFrontendInstances = instances.filter((instance) => instance.hasActiveFrontend)

    if (activeFrontendInstances.length > 1) {
      resetAutoConnectState()
      const portsText = activeFrontendInstances.map((instance) => instance.port).join('、')
      setConnectionPhase('failed', {
        error: `自动连接发现多个活动中的 ComfyUI 前端（${portsText}），请在设置里选择一个端口。`,
        statusText: '发现多个活动前端，请在设置中选择',
        badgeText: '多个实例',
      })
      return
    }

    scheduleNextAutoConnectRetry(context.lastError || '未发现活动中的 ComfyUI 前端')
  }

  function handleWorkflowSyncDiscoveryResult(instances = [], context = {}) {
    if (!needsWorkflowResync()) {
      return
    }

    const activeFrontendInstances = instances.filter((instance) => instance.hasActiveFrontend)
    const currentEndpoint = activeConnectionEndpointText.value

    if (activeFrontendInstances.length === 1) {
      const activeInstance = activeFrontendInstances[0]
      if (activeInstance.id === currentEndpoint) {
        setConnectionPhase('waiting', {
          error: '',
          statusText: `正在同步工作流：${activeInstance.host}:${activeInstance.port}`,
          badgeText: '同步工作流...',
        })
        return
      }

      const nextConfig = mergeConnectionConfig({
        ...context.config,
        host: activeInstance.host,
        port: activeInstance.port,
      })
      scheduleConnectToConfig(nextConfig, {
        auto: false,
        statusText: `当前端口没有活动前端，正在切换到 ${activeInstance.host}:${activeInstance.port}...`,
        badgeText: '切换中...',
      })
      return
    }

    if (activeFrontendInstances.length > 1) {
      setConnectionPhase('waiting', {
        error: '',
        statusText: '发现多个活动前端，请在设置中选择',
        badgeText: '多个实例',
      })
      return
    }

    if (currentEndpoint) {
      setConnectionPhase('waiting', {
        error: '',
        statusText: `当前连接 ${currentEndpoint} 没有活动前端，等待 ComfyUI 前端恢复...`,
        badgeText: '等待前端',
      })
    }
  }

  function scheduleNextAutoConnectRetry(lastError = '') {
    clearInstanceScanState()
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

  function scheduleConnectToConfig(config = {}, options = {}) {
    const mergedConfig = mergeConnectionConfig(config)
    const requestedHost = String(mergedConfig.host || '').trim()
    const requestedPort = String(mergedConfig.port || '').trim()
    const currentHost = String(connectionStore.connectionMeta.value?.host || '').trim()
    const currentPort = String(connectionStore.connectionMeta.value?.port || '').trim()
    const targetChanged = requestedHost !== currentHost || requestedPort !== currentPort
    const hasLiveOrPendingConnection =
      connectionStore.isConnected.value ||
      connectionPhase.value === 'connected' ||
      connectionPhase.value === 'connecting' ||
      connectionPhase.value === 'waiting'

    if (targetChanged && hasLiveOrPendingConnection) {
      pendingConnectCancellation.value = false
      clearConnectionRetryTimer()
      setConnectionPhase('connecting', {
        error: '',
        statusText: options.statusText || `正在切换到 ${requestedHost}:${requestedPort}...`,
        badgeText: options.badgeText || '切换中...',
      })
      sendToHost(HOST_MESSAGE_TYPES.DISCONNECT_COMFYUI, {
        ...settingsSnapshot.value,
      })
      connectionRetryTimer.value = setTimeout(() => {
        connectionRetryTimer.value = null
        performConnectAttempt(mergedConfig, { auto: options.auto === true })
      }, 220)
      return
    }

    if (!targetChanged && connectionPhase.value === 'connected') {
      return
    }

    performConnectAttempt(mergedConfig, { auto: options.auto === true })
  }

  function beginAutoConnect(config = {}) {
    const mergedConfig = mergeConnectionConfig(config)
    clearInstanceScanState()
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
    clearInstanceScanState()
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
      clearInstanceScanState()
      instanceScanStatusText.value = ''
      rememberSuccessfulConnection(meta)
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
    clearInstanceScanState()
    instanceScanStatusText.value = ''
    rememberSuccessfulConnection(meta)

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

    appendDiagnosticLog(status === 'disconnected' ? 'warn' : 'info', 'connection', `连接状态更新：${status}`, {
      host: meta?.host || lifecycle.host || '',
      port: meta?.port || lifecycle.port || '',
      reason: lifecycle.reason || '',
      attempt: lifecycle.attempt ?? '',
      closeCode: lifecycle.closeCode ?? '',
      wasClean: lifecycle.wasClean ?? '',
    })

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
    appendDiagnosticLog('info', 'run', '发送运行工作流命令', {
      workflow: payload.workflow || '',
      workflowId: payload.workflowId || '',
      sizeLimit: payload.settings?.sizeLimit || '',
      imageFormat: payload.settings?.imageFormat || '',
      useSelection: payload.settings?.useSelection,
    })
    taskStore.beginTask('comfyui-run', payload, { status: 'pending' })
    sendToHost(HOST_MESSAGE_TYPES.RUN_WORKFLOW, payload)
  }

  function sendOnly() {
    if (!canSendOnly.value) return
    clearTaskError()
    clearUserStopRequested()
    const payload = buildComfyPayload()
    appendDiagnosticLog('info', 'run', '发送仅传图命令', {
      workflow: payload.workflow || '',
      workflowId: payload.workflowId || '',
      sizeLimit: payload.settings?.sizeLimit || '',
      imageFormat: payload.settings?.imageFormat || '',
      useSelection: payload.settings?.useSelection,
    })
    taskStore.beginTask('comfyui-send-only', payload, { status: 'pending' })
    sendToHost(HOST_MESSAGE_TYPES.SEND_ONLY, payload)
  }

  function runOnly() {
    if (!canRunCurrentWorkflow.value) return
    clearTaskError()
    clearUserStopRequested()
    const payload = buildComfyPayload()
    appendDiagnosticLog('info', 'run', '发送仅运行工作流命令', {
      workflow: payload.workflow || '',
      workflowId: payload.workflowId || '',
    })
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
    appendDiagnosticLog('warn', 'run', '发送停止命令', {
      kind: taskStore.currentTask.value?.kind || '',
      status: taskStore.currentTask.value?.status || '',
      promptId: executionState.value.promptId || '',
    })
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

    appendDiagnosticLog('info', 'api', '发送 API 生图请求', {
      sendCanvas: payload.sendCanvas,
      referenceCount: preparedReferenceImages.length,
      promptLength: String(promptText || '').length,
      activeProfileId: settingsSnapshot.value.activeApiProfileId || '',
    })

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

    appendDiagnosticLog('info', 'api', '请求拉取 API 模型列表', {
      baseUrl: nextSettings.apiBaseUrl || '',
      activeProfileId: nextSettings.activeApiProfileId || '',
    })

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
    appendDiagnosticLog('info', 'workflow', '切换工作流标签', {
      workflow: name || '',
      workflowId: workflowId || '',
    })
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
    const mergedConfig = mergeConnectionConfig(config || {})
    appendDiagnosticLog('info', 'connection', '手动发起连接', {
      host: mergedConfig.host,
      port: mergedConfig.port,
      controlFrontendTarget: mergedConfig.controlFrontendTarget || '',
    })

    resetAutoConnectState()
    clearInstanceScanState()
    scheduleConnectToConfig(mergedConfig, {
      auto: false,
      statusText: `正在切换到 ${mergedConfig.host}:${mergedConfig.port}...`,
      badgeText: '切换中...',
    })
  }

  function handleScanInstances(config) {
    requestComfyInstanceScan(config || settingsSnapshot.value, { auto: false })
  }

  function markInstanceShutdownState(instanceId, shuttingDown) {
    if (!instanceId) return

    if (shuttingDown) {
      if (!shuttingDownInstanceIds.value.includes(instanceId)) {
        shuttingDownInstanceIds.value = [...shuttingDownInstanceIds.value, instanceId]
      }
      return
    }

    shuttingDownInstanceIds.value = shuttingDownInstanceIds.value.filter((value) => value !== instanceId)
  }

  function handleShutdownInstance(target) {
    const host = String(target?.host || '').trim()
    const port = String(target?.port || '').trim()
    if (!host || !port) return

    const instanceId = `${host}:${port}`
    markInstanceShutdownState(instanceId, true)
    instanceScanStatusText.value = `正在关闭 ${host}:${port}...`
    appendDiagnosticLog('warn', 'connection', '请求关闭 ComfyUI 后端', {
      host,
      port,
      isCurrentConnection: instanceId === activeConnectionEndpointText.value,
    })
    const sent = sendToHost(HOST_MESSAGE_TYPES.SHUTDOWN_COMFYUI_INSTANCE, { host, port })
    if (!sent) {
      markInstanceShutdownState(instanceId, false)
      instanceScanStatusText.value = '无法发送关闭命令，请重新打开插件面板'
      return
    }

    if (instanceId === activeConnectionEndpointText.value) {
      setConnectionPhase('waiting', {
        error: '',
        statusText: `正在关闭 ${host}:${port}...`,
        badgeText: '关闭中...',
      })
    }
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
    clearInstanceScanState()
    resetWorkflowResyncState()
    realtimeTickInFlight.value = false
    setConnectionPhase('disconnected', { error: '' })
    workflowStore.clear()
    closeActionMenu()
    appendDiagnosticLog('info', 'connection', '手动断开连接', {
      endpoint: activeConnectionEndpointText.value || '',
    })
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
    appendDiagnosticLog('info', 'photoshop', '发送结果回 Photoshop', {
      sourceMode: appMode.value,
      documentName: resultStore.mainMeta.value?.documentName || '',
      sourceLayerName: resultStore.mainMeta.value?.sourceLayerName || '',
      hasPlacement: Boolean(resultStore.mainMeta.value?.placement),
    })
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
      appendDiagnosticLog('error', 'host', message.result?.error || 'Host Error', {
        requestType: message.result?.requestType || '',
        host: message.result?.host || '',
        port: message.result?.port || '',
      })
      if (message.result?.requestType === HOST_MESSAGE_TYPES.FETCH_API_MODELS) {
        apiModelsLoading.value = false
        apiModelsError.value = message.result?.error || '模型列表读取失败'
        return
      }
      if (message.result?.requestType === HOST_MESSAGE_TYPES.SCAN_COMFYUI_INSTANCES) {
        const scanContext = pendingInstanceScanContext.value
        clearInstanceScanState()
        if (scanContext?.auto) {
          scheduleNextAutoConnectRetry(message.result?.error || '扫描本机 ComfyUI 实例失败')
        } else if (scanContext?.reason === 'workflow-sync') {
          setConnectionPhase('waiting', {
            error: '',
            statusText: '同步工作流时扫描实例失败，正在继续等待...',
            badgeText: '同步工作流...',
          })
        } else {
          instanceScanStatusText.value = message.result?.error || '扫描本机 ComfyUI 实例失败'
        }
        return
      }
      if (message.result?.requestType === HOST_MESSAGE_TYPES.SHUTDOWN_COMFYUI_INSTANCE) {
        const host = String(message.result?.host || '').trim()
        const port = String(message.result?.port || '').trim()
        if (host && port) {
          markInstanceShutdownState(`${host}:${port}`, false)
        } else {
          shuttingDownInstanceIds.value = []
        }
        instanceScanStatusText.value = message.result?.error || '关闭后端失败'
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
        requestComfyInstanceScan(autoConnectState.value.config || settingsSnapshot.value, {
          auto: true,
          lastError: errorText,
        })
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

    if (message.type === `${HOST_MESSAGE_TYPES.SCAN_COMFYUI_INSTANCES}_RESPONSE`) {
      const scanResult = message.result || {}
      const scanContext = pendingInstanceScanContext.value

      if (scanContext?.scanId && scanResult.scanId && scanContext.scanId !== scanResult.scanId) {
        return
      }

      const instances = syncDetectedComfyInstances(scanResult.instances || [])
      clearInstanceScanState()

      if (scanContext?.auto) {
        handleAutoConnectDiscoveryResult(instances, scanContext)
      } else if (scanContext?.reason === 'workflow-sync') {
        handleWorkflowSyncDiscoveryResult(instances, scanContext)
      }
      return
    }

    if (message.type === `${HOST_MESSAGE_TYPES.SHUTDOWN_COMFYUI_INSTANCE}_RESPONSE`) {
      const result = message.result || {}
      const host = String(result.host || '').trim()
      const port = String(result.port || '').trim()
      const instanceId = `${host}:${port}`
      markInstanceShutdownState(instanceId, false)
      instanceScanStatusText.value = `已发送关闭命令：${host}:${port}`
      clearConnectionRetryTimer()
      connectionRetryTimer.value = setTimeout(() => {
        connectionRetryTimer.value = null
        requestComfyInstanceScan(settingsSnapshot.value, { auto: false })
      }, 700)
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

    if (result.transportDiagnostics) {
      const stage = String(result.transportDiagnostics.stage || 'prepared').trim() || 'prepared'
      appendDiagnosticLog(
        stage === 'failed' ? 'error' : 'info',
        'transport',
        `图像传输：${stage}`,
        result.transportDiagnostics,
      )
    }

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
          requestComfyInstanceScan(autoConnectState.value.config || settingsSnapshot.value, {
            auto: true,
            lastError: result.error,
          })
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
        appendDiagnosticLog('info', 'run', '工作流运行命令已被桥接接收', {
          accepted: Boolean(result.accepted),
          promptId: result.promptId || '',
          workflow: result.currentWorkflow || currentWorkflow.value || '',
        })
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
        appendDiagnosticLog('info', 'run', '仅传图命令已完成', {
          accepted: Boolean(result.accepted),
        })
        closeActionMenu()
        taskStore.finishTask('done', {
          accepted: Boolean(result.accepted),
        })
      }
    }

    if (message.type === `${HOST_MESSAGE_TYPES.RUN_ONLY}_RESPONSE`) {
      if (!result.error) {
        appendDiagnosticLog('info', 'run', '仅运行工作流命令已被桥接接收', {
          accepted: Boolean(result.accepted),
          promptId: result.promptId || '',
        })
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
      appendDiagnosticLog('error', 'host', result.error, {
        messageType: message.type || '',
        requestType: result.requestType || '',
      })
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
    appendDiagnosticLog('info', 'app', '诊断日志会话开始', {
      connectionPhase: connectionPhase.value,
      appMode: appMode.value,
    })

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
    [showSettings, appMode],
    () => {
      syncInstanceScanRefreshTimer()
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
    clearInstanceScanRefreshTimer()
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
    activeConnectionEndpointText,
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
    clearDiagnosticLogs,
    detectedComfyInstances: visibleDetectedComfyInstances,
    diagnosticEntries,
    diagnosticSummaryText,
    inactiveDetectedComfyInstances,
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
    handleScanInstances,
    handleShutdownInstance,
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
    isScanningComfyInstances,
    isExecutionProgressIndeterminate,
    isExecutionRunning,
    isPrimaryActionBusy,
    isPrimaryActionDisabled: primaryActionDisabled,
    isRealtimeArmed,
    shuttingDownInstanceIds,
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
    instanceScanStatusText,
    toggleActionMenu,
    toggleDropdown,
    openedWorkflowTabs: workflowStore.openedTabs,
    workflows: workflowStore.workflows,
  }
}
