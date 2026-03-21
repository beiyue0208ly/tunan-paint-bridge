import { createHostMessage, normalizeHostMessage } from '../protocol/hostProtocol'

export function sendToHost(type, payload = {}) {
  if (!window.uxpHost?.postMessage) {
    return false
  }

  window.uxpHost.postMessage(createHostMessage(type, payload))
  return true
}

export function subscribeHostMessages(handler) {
  const listener = (event) => {
    const message = normalizeHostMessage(event.data)
    if (!message) return
    handler(message, event)
  }

  window.addEventListener('message', listener)

  return () => {
    window.removeEventListener('message', listener)
  }
}
