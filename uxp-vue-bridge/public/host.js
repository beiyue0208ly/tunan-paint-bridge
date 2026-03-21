const webview = document.getElementById('main-webview')
const HOST_WEBVIEW_ACTIVATED_EVENT = window.TunanHostProtocol?.EVENTS?.WEBVIEW_ACTIVATED || 'HOST_WEBVIEW_ACTIVATED'
const HOST_VERBOSE_LOGS = false
const HOST_FOCUS_DEBUG = false
const PLUGIN_ID = 'com.tunan.paintbridge-vue'
const PANEL_ID = 'comfyps.vuePanel'
const HOST_FOCUS_LOG_PREFIXES = [
  'host:window:blur',
  'host:document:hidden',
  'trap:',
  'message:FOCUS_WEBVIEW',
  'panel:activate',
  'photoshop:hostFocusChanged',
  'webview:refocus',
]

let awaitingPanelKeyboardReturn = false

const focusTrapInput = document.createElement('input')
focusTrapInput.type = 'text'
focusTrapInput.tabIndex = -1
focusTrapInput.setAttribute('aria-hidden', 'true')
focusTrapInput.setAttribute('data-host-focus-trap', 'true')
focusTrapInput.autocomplete = 'off'
focusTrapInput.style.position = 'fixed'
focusTrapInput.style.top = '-1000px'
focusTrapInput.style.left = '-1000px'
focusTrapInput.style.width = '1px'
focusTrapInput.style.height = '1px'
focusTrapInput.style.opacity = '0'
focusTrapInput.style.pointerEvents = 'none'
document.body.appendChild(focusTrapInput)

function refocusWebview() {
  if (!webview?.focus) return

  focusLog('webview:refocus')
  try {
    webview.focus()
  } catch {
    // ignore focus failures
  }
}

function hostLog(stage, payload = {}) {
  if (!HOST_VERBOSE_LOGS) return
  try {
    console.log(`[HostDebug] ${stage}`, payload)
  } catch {
    console.log(`[HostDebug] ${stage}`)
  }
}

function focusLog(stage, payload = {}) {
  if (!HOST_FOCUS_DEBUG) return
  if (!HOST_FOCUS_LOG_PREFIXES.some((prefix) => stage.startsWith(prefix))) return
  try {
    console.log(`[FocusHost] ${stage}`, payload)
  } catch {
    console.log(`[FocusHost] ${stage}`)
  }
}

function getHostElementLabel(element) {
  if (!(element instanceof HTMLElement)) return 'unknown'
  return (
    element.getAttribute('name') ||
    element.getAttribute('placeholder') ||
    element.id ||
    element.tagName
  )
}

function getHostActiveElementSnapshot() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) {
    return {
      tag: String(active),
      label: 'unknown',
      isWebview: false,
      isHostInput: false,
    }
  }

  const tag = String(active.tagName || '').toUpperCase()
  const isHostInput =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active.isContentEditable

  return {
    tag,
    label: getHostElementLabel(active),
    isWebview: tag === 'WEBVIEW',
    isHostInput,
  }
}

function armAwaitingPanelKeyboardReturn(reason = 'unknown') {
  awaitingPanelKeyboardReturn = true
  focusLog('trap:armed', { reason })
}

function clearAwaitingPanelKeyboardReturn(reason = 'unknown') {
  if (!awaitingPanelKeyboardReturn) return
  awaitingPanelKeyboardReturn = false
  focusLog('trap:disarmed', { reason })
}

function focusHostTrap(reason = 'unknown') {
  focusLog('trap:focus-anchor', {
    reason,
    activeElement: getHostActiveElementSnapshot(),
  })
  try {
    focusTrapInput.focus({ preventScroll: true })
    focusTrapInput.select?.()
  } catch {
    // ignore focus trap failures
  }
}

function notifyWebviewActivated(reason = 'unknown') {
  const emit = (phase) => {
    focusLog('event:HOST_WEBVIEW_ACTIVATED', { reason, phase })
    postToWebView({
      type: HOST_WEBVIEW_ACTIVATED_EVENT,
      payload: {
        reason,
        phase,
        ts: Date.now(),
      },
    })
  }

  emit('immediate')
  setTimeout(() => emit('late-80'), 80)
  setTimeout(() => emit('late-180'), 180)
}

async function activateCurrentPanel(reason = 'unknown') {
  try {
    const uxp = require('uxp')
    const pluginManager = uxp?.pluginManager
    const plugins = pluginManager?.plugins
    if (!plugins || typeof plugins.values !== 'function') {
      focusLog('panel:activate:unsupported', { reason })
      return
    }

    const currentPlugin = Array.from(plugins).find((plugin) => plugin?.id === PLUGIN_ID)
    if (!currentPlugin?.showPanel) {
      focusLog('panel:activate:plugin-not-found', { reason, pluginId: PLUGIN_ID, panelId: PANEL_ID })
      return
    }

    await currentPlugin.showPanel(PANEL_ID)
    focusLog('panel:activate:showPanel:ok', { reason, pluginId: PLUGIN_ID, panelId: PANEL_ID })
  } catch (error) {
    focusLog('panel:activate:showPanel:error', {
      reason,
      pluginId: PLUGIN_ID,
      panelId: PANEL_ID,
      message: error?.message || String(error),
    })
  }
}

async function initPhotoshopHostFocusListener() {
  try {
    const photoshop = require('photoshop')
    const action = photoshop?.action
    if (!action?.addNotificationListener) {
      focusLog('photoshop:hostFocusChanged:unsupported')
      return
    }

    await action.addNotificationListener(['hostFocusChanged'], (eventName, descriptor) => {
      focusLog('photoshop:hostFocusChanged', { eventName, descriptor })
      focusLog('photoshop:hostFocusChanged:refocus-before-notify', { phase: 'immediate' })
      refocusWebview()
      setTimeout(() => {
        focusLog('photoshop:hostFocusChanged:refocus-before-notify', { phase: 'late-80' })
        refocusWebview()
      }, 80)
      setTimeout(() => {
        focusLog('photoshop:hostFocusChanged:refocus-before-notify', { phase: 'late-180' })
        refocusWebview()
      }, 180)
      notifyWebviewActivated('photoshop-hostFocusChanged')
    })
    focusLog('photoshop:hostFocusChanged:subscribed')
  } catch (error) {
    focusLog('photoshop:hostFocusChanged:error', {
      message: error?.message || String(error),
    })
  }
}

function postToWebView(message) {
  if (!webview) return
  webview.postMessage(typeof message === 'string' ? message : JSON.stringify(message))
}

const dispatcher = new window.TunanHostDispatcher(postToWebView)

webview.addEventListener('loadstop', () => {
  refocusWebview()
  postToWebView({ type: 'HOST_READY' })
})

webview.addEventListener('loaderror', (event) => {
  console.error('[Host] WebView loaderror:', event?.url, event?.code, event?.message)
})

window.addEventListener('focus', () => {
  focusLog('window:focus')
  notifyWebviewActivated('window-focus')
})
window.addEventListener('blur', () => {
  focusLog('host:window:blur')
  armAwaitingPanelKeyboardReturn('window-blur')
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    focusLog('host:document:hidden')
    armAwaitingPanelKeyboardReturn('document-hidden')
    return
  }
  notifyWebviewActivated('visibility-visible')
})
document.addEventListener(
  'keydown',
  (event) => {
    focusLog('keydown:capture', {
      key: event.key,
      code: event.code,
      ctrlKey: Boolean(event.ctrlKey),
      metaKey: Boolean(event.metaKey),
      altKey: Boolean(event.altKey),
      shiftKey: Boolean(event.shiftKey),
      activeElement: getHostActiveElementSnapshot(),
      target: getHostElementLabel(event.target),
    })
  },
  true,
)

initPhotoshopHostFocusListener()

async function handleWebViewMessage(event) {
  let parsedMessage = null
  try {
    parsedMessage = window.TunanHostProtocol.parseMessage(event.data)
    if (!parsedMessage) return
    if (parsedMessage.type === window.TunanHostProtocol.TYPES.FOCUS_STATE_SYNC) {
      const state = parsedMessage.payload?.state || 'unknown'
      if (state === 'window-blur') {
        armAwaitingPanelKeyboardReturn('focus-state-window-blur')
      } else if (state === 'keydown-captured') {
        clearAwaitingPanelKeyboardReturn('focus-state-keydown-captured')
      }
      postToWebView(window.TunanHostProtocol.createResponse(parsedMessage, { synced: true }))
      return
    }

    if (parsedMessage.type === window.TunanHostProtocol.TYPES.FOCUS_WEBVIEW) {
      const reason = parsedMessage.payload?.reason || 'unknown'
      let shouldNotifyImmediately = true
      focusLog('message:FOCUS_WEBVIEW', parsedMessage.payload || {})
      try {
        window.focus?.()
      } catch {
        // ignore host window focus failures
      }
      if (!['settings-input-pointerdown', 'text-input-pointerdown'].includes(reason)) {
        refocusWebview()
      } else {
        focusLog('message:FOCUS_WEBVIEW:activate-only', { reason })
        await activateCurrentPanel(reason)
        if (reason === 'text-input-pointerdown' && awaitingPanelKeyboardReturn) {
          focusLog('trap:sequence:start', { reason })
          shouldNotifyImmediately = false
          focusHostTrap(reason)
          setTimeout(() => {
            focusLog('trap:sequence:refocus-webview', { reason, phase: 'trap-60' })
            refocusWebview()
          }, 60)
          setTimeout(() => {
            focusLog('trap:sequence:notify', { reason, phase: 'trap-100' })
            notifyWebviewActivated(`${reason}-trap`)
          }, 100)
        } else if (reason === 'text-input-pointerdown') {
          focusLog('message:FOCUS_WEBVIEW:refocus-after-activate', { reason })
          refocusWebview()
        }
        setTimeout(() => {
          try {
            window.focus?.()
          } catch {
            // ignore host window focus failures
          }
        }, 36)
        setTimeout(() => {
          try {
            window.focus?.()
          } catch {
            // ignore host window focus failures
          }
        }, 120)
      }
      if (shouldNotifyImmediately) {
        notifyWebviewActivated(reason)
      }
      postToWebView(window.TunanHostProtocol.createResponse(parsedMessage, { focused: true }))
      return
    }

    const result = await dispatcher.dispatch(parsedMessage)
    postToWebView(window.TunanHostProtocol.createResponse(parsedMessage, result))
  } catch (error) {
    console.error('[Host] Error handling message:', error)
    postToWebView({
      type: 'HOST_ERROR',
      result: {
        error: error?.message || String(error),
        requestType: parsedMessage?.type || '',
        requestId: parsedMessage?.requestId || null,
      },
    })
  }
}

window.addEventListener('message', handleWebViewMessage)
