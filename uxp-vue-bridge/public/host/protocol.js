(function initTunanHostProtocol(global) {
  const TYPES = {
    PING: 'PING',
    GET_PS_INFO: 'GET_PS_INFO',
    GET_SETTINGS: 'GET_SETTINGS',
    SYNC_SETTINGS: 'SYNC_SETTINGS',
    CONNECT_COMFYUI: 'CONNECT_COMFYUI',
    DISCONNECT_COMFYUI: 'DISCONNECT_COMFYUI',
    TEST_CONNECTION: 'TEST_CONNECTION',
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

  function parseMessage(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw

    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function createResponse(message, result) {
    return JSON.stringify({
      type: `${message.type}_RESPONSE`,
      requestId: message.requestId,
      result,
    })
  }

  const EVENTS = {
    WEBVIEW_ACTIVATED: 'HOST_WEBVIEW_ACTIVATED',
  }

  global.TunanHostProtocol = {
    TYPES,
    EVENTS,
    parseMessage,
    createResponse,
  }
})(window)
