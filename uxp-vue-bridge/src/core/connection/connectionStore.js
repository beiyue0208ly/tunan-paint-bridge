import { ref } from 'vue'

export function createConnectionStore() {
  const isConnected = ref(false)
  const connectionMeta = ref({
    host: '127.0.0.1',
    port: 8188,
    mode: 'comfyui',
  })

  function setConnected(connected, meta = {}) {
    isConnected.value = connected
    connectionMeta.value = {
      ...connectionMeta.value,
      ...meta,
    }
  }

  return {
    isConnected,
    connectionMeta,
    setConnected,
  }
}
