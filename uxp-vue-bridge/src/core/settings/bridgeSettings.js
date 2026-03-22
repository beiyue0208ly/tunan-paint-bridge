const DEFAULT_API_PROVIDER = 'openai'
const DEFAULT_API_MODEL_ENDPOINT = 'image-generation'

function normalizeApiEndpointType(rawType) {
  const normalized = String(rawType || '').trim().toLowerCase()
  if (!normalized) return ''

  if (normalized.includes('/images/generations')) {
    return 'image-generation'
  }

  if (normalized.includes(':generatecontent') || normalized.includes('/v1beta/models/')) {
    return 'gemini'
  }

  if (normalized.includes('/chat/completions')) {
    return 'openai'
  }

  switch (normalized) {
    case 'image-generation':
    case 'image_generation':
      return 'image-generation'
    case 'gemini':
      return 'gemini'
    case 'openai':
    case 'chat':
    case 'chat-completions':
    case 'chat_completions':
      return 'openai'
    default:
      return ''
  }
}

function inferApiModelEndpointType(modelId = '') {
  const normalized = String(modelId || '').trim().toLowerCase()
  if (normalized.includes('gemini') && normalized.includes('image')) {
    return 'gemini'
  }
  return DEFAULT_API_MODEL_ENDPOINT
}

function normalizeApiSupportedEndpointTypes(rawTypes, modelId = '') {
  const sourceTypes = Array.isArray(rawTypes)
    ? rawTypes
    : rawTypes
      ? [rawTypes]
      : []
  const normalizedTypes = [...new Set(sourceTypes.map(normalizeApiEndpointType).filter(Boolean))]

  if (normalizedTypes.length > 0) {
    return normalizedTypes
  }

  const inferredType = inferApiModelEndpointType(modelId)
  return inferredType ? [inferredType] : []
}

export function resolveApiSavedModelId(item) {
  if (typeof item === 'string') {
    return String(item || '').trim()
  }

  if (item && typeof item === 'object') {
    return String(item.id || item.model || item.value || '').trim()
  }

  return ''
}

export function resolveApiSavedModelLabel(item) {
  if (typeof item === 'string') {
    return String(item || '').trim()
  }

  if (item && typeof item === 'object') {
    return String(item.label || item.name || item.id || item.model || item.value || '').trim()
  }

  return ''
}

export function resolveApiSavedModelEndpointType(item) {
  if (!item || typeof item !== 'object') {
    return ''
  }

  const directType = normalizeApiEndpointType(item.endpointType || item.endpoint_type)
  if (directType) {
    return directType
  }

  const supportedTypes = normalizeApiSupportedEndpointTypes(
    item.supportedEndpointTypes || item.supported_endpoint_types || item.endpointTypes || item.endpoint_types,
    resolveApiSavedModelId(item),
  )

  return supportedTypes[0] || ''
}

function createApiSavedModelEntry(item) {
  const id = resolveApiSavedModelId(item)
  if (!id) return null

  const rawObject = item && typeof item === 'object' ? item : null
  const supportedEndpointTypes = normalizeApiSupportedEndpointTypes(
    rawObject?.supportedEndpointTypes ||
      rawObject?.supported_endpoint_types ||
      rawObject?.endpointTypes ||
      rawObject?.endpoint_types,
    id,
  )
  const endpointType =
    resolveApiSavedModelEndpointType(rawObject) ||
    supportedEndpointTypes[0] ||
    inferApiModelEndpointType(id)

  return {
    id,
    label: resolveApiSavedModelLabel(rawObject || id) || id,
    owner: String(rawObject?.owner || rawObject?.owned_by || rawObject?.ownedBy || '').trim(),
    group: String(rawObject?.group || '').trim(),
    groupLabel: String(rawObject?.groupLabel || rawObject?.group || '').trim(),
    score: Number.isFinite(Number(rawObject?.score)) ? Number(rawObject.score) : 0,
    isImageLikely: rawObject?.isImageLikely !== undefined ? Boolean(rawObject.isImageLikely) : true,
    supportedEndpointTypes,
    endpointType,
  }
}

export function normalizeApiSavedModels(models, activeModel = '') {
  const sourceModels = Array.isArray(models) ? models : []
  const normalized = []
  const seen = new Set()

  for (const item of sourceModels) {
    const entry = createApiSavedModelEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    normalized.push(entry)
  }

  const activeId = resolveApiSavedModelId(activeModel)
  if (activeId && !seen.has(activeId)) {
    const activeEntry = createApiSavedModelEntry(activeId)
    if (activeEntry) {
      normalized.unshift(activeEntry)
    }
  }

  return normalized
}

function createProfileId() {
  return `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createApiProfileDraft(overrides = {}) {
  const legacyModel = resolveApiSavedModelId(overrides.activeModel || overrides.model || overrides.apiModel)
  const savedModelsSource = Array.isArray(overrides.savedModels)
    ? overrides.savedModels
    : legacyModel
      ? [legacyModel]
      : []
  const savedModels = normalizeApiSavedModels(savedModelsSource, legacyModel)
  const activeModel =
    resolveApiSavedModelId(overrides.activeModel) ||
    legacyModel ||
    savedModels[0]?.id ||
    ''

  return {
    id: overrides.id || createProfileId(),
    name: String(overrides.name || '').trim(),
    providerType: overrides.providerType || DEFAULT_API_PROVIDER,
    apiKey: String(overrides.apiKey || ''),
    baseUrl: String(overrides.baseUrl || overrides.apiBaseUrl || ''),
    savedModels,
    activeModel,
    model: activeModel,
  }
}

export const DEFAULT_SETTINGS = {
  appMode: 'comfyui',
  host: '127.0.0.1',
  port: '8188',
  autoConnect: true,
  realtimeDebounce: 5,
  realtimeSensitivity: 5,
  realtimeAction: 'run',
  captureMode: 'merged',
  layerBoundaryMode: 'document',
  useSelection: true,
  selectionSendMode: 'rect',
  selectionExpandPx: 64,
  imageFormat: 'png',
  sizeLimit: '1024',
  customSizeValue: 1024,
  edgeControl: 'long',
  returnLayerType: 'smartObject',
  returnLayerNaming: 'source',
  jpegQuality: 90,
  positivePrompt: '',
  negativePrompt: '',
  steps: 20,
  cfgScale: 7,
  seed: -1,
  promptTemplates: [],
  showNotifications: true,
  notificationDuration: 3,
  apiReferenceSizeLimit: 'original',
  apiProfiles: [],
  activeApiProfileId: '',
  apiProvider: DEFAULT_API_PROVIDER,
  apiKey: '',
  apiBaseUrl: '',
  apiModel: '',
  controlFrontendTarget: '',
}

function normalizePromptTemplateEntry(entry = {}, index = 0) {
  const nextEntry = entry && typeof entry === 'object' ? entry : {}
  const name = String(nextEntry.name || '').trim() || `模板 ${index + 1}`

  return {
    name,
    pos: String(nextEntry.pos ?? nextEntry.positive ?? nextEntry.positivePrompt ?? '').trim(),
    neg: String(nextEntry.neg ?? nextEntry.negative ?? nextEntry.negativePrompt ?? '').trim(),
    steps: normalizeNumber(nextEntry.steps, DEFAULT_SETTINGS.steps, { min: 1, max: 150 }),
    cfg: normalizeNumber(nextEntry.cfg ?? nextEntry.cfgScale, DEFAULT_SETTINGS.cfgScale, { min: 1, max: 30 }),
    seed: normalizeNumber(nextEntry.seed, DEFAULT_SETTINGS.seed),
  }
}

function normalizePromptTemplates(rawSettings = {}) {
  const sourceTemplates = Array.isArray(rawSettings.promptTemplates) ? rawSettings.promptTemplates : []
  return sourceTemplates
    .map((entry, index) => normalizePromptTemplateEntry(entry, index))
    .filter((entry) => entry.name)
}

function normalizeNumber(value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const nextValue = Number(value)
  if (Number.isNaN(nextValue)) return fallback
  return Math.min(max, Math.max(min, nextValue))
}

function normalizeReturnLayerType(rawSettings = {}) {
  if (rawSettings.returnLayerType === 'pixelLayer') {
    return 'pixelLayer'
  }

  if (rawSettings.returnLayerType === 'smartObject') {
    return 'smartObject'
  }

  if (typeof rawSettings.createSmartObject === 'boolean') {
    return rawSettings.createSmartObject ? 'smartObject' : 'pixelLayer'
  }

  return DEFAULT_SETTINGS.returnLayerType
}

function normalizeReturnLayerNaming(rawSettings = {}) {
  const nextValue = rawSettings.returnLayerNaming
  if (nextValue === 'source' || nextValue === 'sequence' || nextValue === 'time') {
    return nextValue
  }

  switch (rawSettings.layerNaming) {
    case 'sequential':
      return 'sequence'
    case 'timestamp':
      return 'time'
    case 'prompt':
      return 'source'
    default:
      return DEFAULT_SETTINGS.returnLayerNaming
  }
}

function normalizeApiProviderType(rawProviderType) {
  switch (String(rawProviderType || '').trim()) {
    case 'openai':
    case 'openai_compatible_images':
      return DEFAULT_API_PROVIDER
    case 'gemini':
      return 'gemini'
    case 'grsai':
      return 'grsai'
    default:
      return DEFAULT_API_PROVIDER
  }
}

function migrateLegacyApiProfiles(rawSettings = {}) {
  const hasLegacyApiConfig = Boolean(
    rawSettings.apiKey || rawSettings.apiBaseUrl || rawSettings.apiModel || rawSettings.apiProvider,
  )
  if (!hasLegacyApiConfig) {
    return []
  }

  return [
    createApiProfileDraft({
      name: '默认 API',
      providerType: normalizeApiProviderType(rawSettings.apiProvider),
      apiKey: rawSettings.apiKey,
      baseUrl: rawSettings.apiBaseUrl,
      model: rawSettings.apiModel,
    }),
  ]
}

function normalizeApiProfiles(rawSettings = {}) {
  const sourceProfiles = Array.isArray(rawSettings.apiProfiles)
    ? rawSettings.apiProfiles
    : migrateLegacyApiProfiles(rawSettings)

  return sourceProfiles.map((profile, index) => {
    const normalized = createApiProfileDraft(profile || {})
    if (!normalized.name) {
      normalized.name = `API 卡片 ${index + 1}`
    }
    normalized.providerType = normalizeApiProviderType(normalized.providerType)
    normalized.apiKey = String(normalized.apiKey || '')
    normalized.baseUrl = String(normalized.baseUrl || '')
    normalized.savedModels = normalizeApiSavedModels(normalized.savedModels, normalized.activeModel)
    normalized.activeModel = resolveApiSavedModelId(normalized.activeModel || normalized.model)
    if (!normalized.activeModel && normalized.savedModels.length > 0) {
      normalized.activeModel = normalized.savedModels[0].id
    }
    normalized.model = normalized.activeModel
    return normalized
  })
}

export function resolveActiveApiProfile(settings = {}) {
  const profiles = Array.isArray(settings.apiProfiles) ? settings.apiProfiles : []
  if (!profiles.length) return null

  const activeId = String(settings.activeApiProfileId || '')
  return profiles.find((profile) => profile.id === activeId) || profiles[0] || null
}

export function normalizeSettingsSnapshot(rawSettings = {}) {
  const nextSettings = {
    ...DEFAULT_SETTINGS,
  }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(rawSettings, key)) {
      nextSettings[key] = rawSettings[key]
    }
  }

  nextSettings.port = String(nextSettings.port || DEFAULT_SETTINGS.port)
  nextSettings.sizeLimit = String(nextSettings.sizeLimit || DEFAULT_SETTINGS.sizeLimit)
  nextSettings.customSizeValue = normalizeNumber(nextSettings.customSizeValue, DEFAULT_SETTINGS.customSizeValue, {
    min: 256,
    max: 4096,
  })
  nextSettings.selectionExpandPx = normalizeNumber(nextSettings.selectionExpandPx, DEFAULT_SETTINGS.selectionExpandPx, {
    min: 0,
    max: 4096,
  })
  nextSettings.steps = normalizeNumber(nextSettings.steps, DEFAULT_SETTINGS.steps, {
    min: 1,
    max: 150,
  })
  nextSettings.cfgScale = normalizeNumber(nextSettings.cfgScale, DEFAULT_SETTINGS.cfgScale, {
    min: 1,
    max: 30,
  })
  nextSettings.seed = normalizeNumber(nextSettings.seed, DEFAULT_SETTINGS.seed)
  nextSettings.jpegQuality = normalizeNumber(nextSettings.jpegQuality, DEFAULT_SETTINGS.jpegQuality, {
    min: 1,
    max: 100,
  })
  nextSettings.notificationDuration = normalizeNumber(
    nextSettings.notificationDuration,
    DEFAULT_SETTINGS.notificationDuration,
    { min: 1, max: 10 },
  )
  nextSettings.apiReferenceSizeLimit = [
    'original',
    '512',
    '768',
    '1024',
    '1280',
    '1536',
    '2048',
  ].includes(String(nextSettings.apiReferenceSizeLimit))
    ? String(nextSettings.apiReferenceSizeLimit)
    : DEFAULT_SETTINGS.apiReferenceSizeLimit
  nextSettings.realtimeDebounce = normalizeNumber(nextSettings.realtimeDebounce, DEFAULT_SETTINGS.realtimeDebounce, {
    min: 2,
    max: 60,
  })
  nextSettings.realtimeSensitivity = normalizeNumber(
    nextSettings.realtimeSensitivity,
    DEFAULT_SETTINGS.realtimeSensitivity,
    { min: 1, max: 10 },
  )
  nextSettings.realtimeAction = nextSettings.realtimeAction === 'send' ? 'send' : 'run'
  nextSettings.edgeControl = nextSettings.edgeControl === 'short' ? 'short' : 'long'
  nextSettings.captureMode = nextSettings.captureMode === 'current' ? 'current' : 'merged'
  nextSettings.layerBoundaryMode = nextSettings.layerBoundaryMode === 'content' ? 'content' : 'document'
  nextSettings.selectionSendMode = nextSettings.selectionSendMode === 'shape' ? 'shape' : 'rect'
  nextSettings.imageFormat = nextSettings.imageFormat === 'jpg' ? 'jpg' : 'png'
  nextSettings.returnLayerType = normalizeReturnLayerType(rawSettings)
  nextSettings.returnLayerNaming = normalizeReturnLayerNaming(rawSettings)
  nextSettings.positivePrompt = String(nextSettings.positivePrompt || '')
  nextSettings.negativePrompt = String(nextSettings.negativePrompt || '')
  nextSettings.promptTemplates = normalizePromptTemplates(rawSettings)
  nextSettings.autoConnect = nextSettings.autoConnect !== false
  nextSettings.useSelection = nextSettings.useSelection !== false
  nextSettings.showNotifications = nextSettings.showNotifications !== false
  nextSettings.appMode = nextSettings.appMode === 'api' ? 'api' : 'comfyui'

  nextSettings.apiProfiles = normalizeApiProfiles(rawSettings)
  nextSettings.activeApiProfileId = String(nextSettings.activeApiProfileId || '')
  if (
    nextSettings.activeApiProfileId &&
    !nextSettings.apiProfiles.some((profile) => profile.id === nextSettings.activeApiProfileId)
  ) {
    nextSettings.activeApiProfileId = ''
  }
  if (!nextSettings.activeApiProfileId && nextSettings.apiProfiles.length > 0) {
    nextSettings.activeApiProfileId = nextSettings.apiProfiles[0].id
  }

  const activeApiProfile = resolveActiveApiProfile(nextSettings)
  nextSettings.apiProvider = activeApiProfile?.providerType || DEFAULT_API_PROVIDER
  nextSettings.apiKey = activeApiProfile?.apiKey || ''
  nextSettings.apiBaseUrl = activeApiProfile?.baseUrl || ''
  nextSettings.apiModel = activeApiProfile?.activeModel || activeApiProfile?.model || ''

  return nextSettings
}
