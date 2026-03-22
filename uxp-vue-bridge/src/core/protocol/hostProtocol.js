export const HOST_MESSAGE_TYPES = {
  PING: 'PING',
  GET_PS_INFO: 'GET_PS_INFO',
  GET_SETTINGS: 'GET_SETTINGS',
  SYNC_SETTINGS: 'SYNC_SETTINGS',
  CONNECT_COMFYUI: 'CONNECT_COMFYUI',
  DISCONNECT_COMFYUI: 'DISCONNECT_COMFYUI',
  TEST_CONNECTION: 'TEST_CONNECTION',
  SCAN_COMFYUI_INSTANCES: 'SCAN_COMFYUI_INSTANCES',
  SHUTDOWN_COMFYUI_INSTANCE: 'SHUTDOWN_COMFYUI_INSTANCE',
  OPEN_WORKFLOW_BROWSER: 'OPEN_WORKFLOW_BROWSER',
  REFRESH_WORKFLOW_STATE: 'REFRESH_WORKFLOW_STATE',
  UPDATE_CONTROL_TARGET: 'UPDATE_CONTROL_TARGET',
  SWITCH_WORKFLOW: 'SWITCH_WORKFLOW',
  RUN_WORKFLOW: 'RUN_WORKFLOW',
  SEND_ONLY: 'SEND_ONLY',
  RUN_ONLY: 'RUN_ONLY',
  REALTIME_TICK: 'REALTIME_TICK',
  STOP_TASK: 'STOP_TASK',
  RERUN_TASK: 'RERUN_TASK',
  FOCUS_WEBVIEW: 'FOCUS_WEBVIEW',
  FOCUS_STATE_SYNC: 'FOCUS_STATE_SYNC',
  FETCH_API_MODELS: 'FETCH_API_MODELS',
  API_GENERATE: 'API_GENERATE',
  ADD_IMAGE_TO_PS: 'ADD_IMAGE_TO_PS',
}

export const HOST_EVENT_TYPES = {
  READY: 'HOST_READY',
  SETTINGS_UPDATED: 'from-vue:settings-updated',
  WEBVIEW_ACTIVATED: 'HOST_WEBVIEW_ACTIVATED',
}

export function createHostMessage(type, payload = {}) {
  return JSON.stringify({
    type,
    payload,
    requestId: Date.now(),
  })
}

export function normalizeHostMessage(rawMessage) {
  if (!rawMessage) return null

  if (typeof rawMessage === 'object') {
    return rawMessage
  }

  if (typeof rawMessage !== 'string') {
    return null
  }

  try {
    return JSON.parse(rawMessage)
  } catch {
    return null
  }
}
