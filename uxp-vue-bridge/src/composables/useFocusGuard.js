import { onBeforeUnmount, onMounted } from 'vue'
import { sendToHost, subscribeHostMessages } from '../core/bridge/webviewBridge'
import { HOST_EVENT_TYPES, HOST_MESSAGE_TYPES } from '../core/protocol/hostProtocol'

const FOCUS_GUARD_DEBUG = false
const FOCUS_HINT_DELAY_MS = 260
const FOCUS_GUARD_LOG_PREFIXES = [
  'window:blur',
  'window:focus',
  'remember:pointerdown',
  'remember:focusin',
  'keydown:capture',
  'hint:show',
]

export const FOCUS_GUARD_EVENTS = {
  SHOW_RECOVERY_HINT: 'TUNAN_FOCUS_SHOW_RECOVERY_HINT',
  HIDE_RECOVERY_HINT: 'TUNAN_FOCUS_HIDE_RECOVERY_HINT',
}

function dispatchFocusGuardEvent(type, detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }))
  } catch {
    // ignore custom event failures
  }
}

function showRecoveryHint(detail = {}) {
  dispatchFocusGuardEvent(FOCUS_GUARD_EVENTS.SHOW_RECOVERY_HINT, detail)
}

function hideRecoveryHint(detail = {}) {
  dispatchFocusGuardEvent(FOCUS_GUARD_EVENTS.HIDE_RECOVERY_HINT, detail)
}

function focusLog(stage, payload = {}) {
  if (!FOCUS_GUARD_DEBUG) return
  if (!FOCUS_GUARD_LOG_PREFIXES.some((prefix) => stage.startsWith(prefix))) return
  try {
    console.log(`[FocusGuard] ${stage}`, payload)
  } catch {
    console.log(`[FocusGuard] ${stage}`)
  }
}

function syncFocusStateToHost(state, payload = {}) {
  sendToHost(HOST_MESSAGE_TYPES.FOCUS_STATE_SYNC, {
    state,
    ...payload,
  })
}

function isTextInputTarget(target) {
  if (!(target instanceof HTMLElement)) return false

  if (target instanceof HTMLTextAreaElement) return true
  if (target.isContentEditable) return true

  if (target instanceof HTMLInputElement) {
    const type = String(target.type || 'text').toLowerCase()
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'hidden'].includes(type)
  }

  return false
}

function isApiPromptTarget(target) {
  return target instanceof HTMLElement && target.classList.contains('api-prompt-input')
}

function getTargetLabel(target) {
  if (!(target instanceof HTMLElement)) return 'unknown'
  return target.getAttribute('name') || target.getAttribute('placeholder') || target.id || target.tagName
}

function getActiveElementSnapshot() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return { tag: String(active), label: 'unknown' }
  return {
    tag: active.tagName,
    label: getTargetLabel(active),
    isTextInput: isTextInputTarget(active),
  }
}

function focusTextTarget(target) {
  if (!isTextInputTarget(target) || !target.isConnected) return
  target.focus({ preventScroll: true })
  if (typeof target.setSelectionRange === 'function') {
    const length = typeof target.value === 'string' ? target.value.length : 0
    target.setSelectionRange(length, length)
  }
}

function scheduleFocusRecovery(target, source = 'unknown', registerTimer = () => {}) {
  if (!isTextInputTarget(target)) return

  const run = (stage) => {
    focusLog(`recover:${source}:${stage}`, { target: getTargetLabel(target) })
    focusTextTarget(target)
  }

  const shortRecovery = isApiPromptTarget(target)
  run('immediate')
  requestAnimationFrame(() => run('raf'))
  registerTimer(setTimeout(() => run('24ms'), 24))
  if (!shortRecovery) {
    registerTimer(setTimeout(() => run('96ms'), 96))
    registerTimer(setTimeout(() => run('220ms'), 220))
    registerTimer(setTimeout(() => run('420ms'), 420))
  }
}

export function useFocusGuard() {
  let lastFocusedTextInput = null
  let unsubscribeHostMessages = null
  let awaitingKeyboardRecovery = false
  let recoveryHintTimer = null
  const pendingRecoveryTimers = new Set()

  const clearPendingRecoveryTimers = () => {
    if (!pendingRecoveryTimers.size) return
    pendingRecoveryTimers.forEach((timerId) => clearTimeout(timerId))
    pendingRecoveryTimers.clear()
  }

  const registerRecoveryTimer = (timerId) => {
    pendingRecoveryTimers.add(timerId)
  }

  const clearRecoveryHintTimer = () => {
    if (!recoveryHintTimer) return
    clearTimeout(recoveryHintTimer)
    recoveryHintTimer = null
  }

  const armRecoveryHint = (target) => {
    clearRecoveryHintTimer()
    recoveryHintTimer = setTimeout(() => {
      focusLog('hint:show', {
        target: getTargetLabel(target),
        activeElement: getActiveElementSnapshot(),
      })
      showRecoveryHint({
        target: getTargetLabel(target),
        activeElement: getActiveElementSnapshot(),
      })
    }, FOCUS_HINT_DELAY_MS)
  }

  const rememberTarget = (target, source) => {
    if (!isTextInputTarget(target)) return
    lastFocusedTextInput = target
    focusLog(`remember:${source}`, { target: getTargetLabel(target) })
  }

  const handlePointerDownCapture = (event) => {
    const target = event?.target
    if (!isTextInputTarget(target)) {
      clearPendingRecoveryTimers()
      return
    }

    clearPendingRecoveryTimers()
    rememberTarget(target, 'pointerdown')

    try {
      window.focus?.()
    } catch {
      // ignore focus failures
    }

    sendToHost(HOST_MESSAGE_TYPES.FOCUS_WEBVIEW, {
      reason: 'text-input-pointerdown',
      target: getTargetLabel(target),
    })
    scheduleFocusRecovery(target, 'pointerdown', registerRecoveryTimer)
    if (awaitingKeyboardRecovery) {
      armRecoveryHint(target)
    } else {
      hideRecoveryHint({ reason: 'pointerdown-no-recovery-needed' })
    }
  }

  const handleFocusInCapture = (event) => {
    const target = event?.target
    if (!isTextInputTarget(target)) return
    rememberTarget(target, 'focusin')
  }

  const handleKeyDownCapture = (event) => {
    const activeElement = document.activeElement
    focusLog('keydown:capture', {
      key: event.key,
      activeElement: getActiveElementSnapshot(),
    })
    awaitingKeyboardRecovery = false
    clearRecoveryHintTimer()
    hideRecoveryHint({
      reason: 'keydown-captured',
      key: event.key,
      activeElement: getActiveElementSnapshot(),
    })
    syncFocusStateToHost('keydown-captured', {
      key: event.key,
      activeElement: getActiveElementSnapshot(),
    })
    if (!isTextInputTarget(activeElement)) return
    event.stopPropagation()
  }

  onMounted(() => {
    document.addEventListener('pointerdown', handlePointerDownCapture, true)
    document.addEventListener('focusin', handleFocusInCapture, true)
    document.addEventListener('keydown', handleKeyDownCapture, true)

    unsubscribeHostMessages = subscribeHostMessages((message) => {
      if (message.type !== HOST_EVENT_TYPES.WEBVIEW_ACTIVATED) return
      if (!isTextInputTarget(lastFocusedTextInput)) return
      focusLog('event:HOST_WEBVIEW_ACTIVATED', message.payload || {})
      clearPendingRecoveryTimers()
      scheduleFocusRecovery(lastFocusedTextInput, 'host-activated', registerRecoveryTimer)
    })

    window.addEventListener(
      'blur',
      () => {
        awaitingKeyboardRecovery = true
        clearRecoveryHintTimer()
        hideRecoveryHint({ reason: 'window-blur' })
        focusLog('window:blur', {
          activeElement: getActiveElementSnapshot(),
        })
        syncFocusStateToHost('window-blur', {
          activeElement: getActiveElementSnapshot(),
        })
      },
      true,
    )

    window.addEventListener(
      'focus',
      () => {
        focusLog('window:focus', {
          activeElement: getActiveElementSnapshot(),
        })
      },
      true,
    )
  })

  onBeforeUnmount(() => {
    clearRecoveryHintTimer()
    clearPendingRecoveryTimers()
    document.removeEventListener('pointerdown', handlePointerDownCapture, true)
    document.removeEventListener('focusin', handleFocusInCapture, true)
    document.removeEventListener('keydown', handleKeyDownCapture, true)
    unsubscribeHostMessages?.()
  })
}
