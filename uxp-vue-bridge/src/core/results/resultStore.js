import { ref } from 'vue'

function createEntry(image, meta = {}) {
  return {
    id: meta.id ?? `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    slotId: meta.slotId ?? `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    image,
    meta,
  }
}

function cloneMeta(meta) {
  if (!meta || typeof meta !== 'object') return {}
  try {
    return JSON.parse(JSON.stringify(meta))
  } catch {
    return {}
  }
}

function normalizePersistedEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const image = typeof entry.image === 'string' ? entry.image : ''
  if (!image) return null
  const meta = cloneMeta(entry.meta)
  const id = String(entry.id || meta.id || `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const slotId = String(entry.slotId || meta.slotId || id)
  return {
    id,
    slotId,
    image,
    meta,
  }
}

export function createResultStore(maxHistory = 10) {
  const mainImage = ref(null)
  const mainMeta = ref(null)
  const historyItems = ref([])
  const activeHistoryId = ref(null)

  function setMain(entry) {
    if (!entry?.image) return
    mainImage.value = entry.image
    mainMeta.value = entry.meta ?? null
  }

  function pushIncomingResult(image, meta = {}) {
    if (!image) return null

    const nextEntry = createEntry(image, meta)

    if (!mainImage.value) {
      setMain(nextEntry)
      activeHistoryId.value = null
      return nextEntry
    }

    historyItems.value.unshift(createEntry(mainImage.value, mainMeta.value ?? {}))
    historyItems.value = historyItems.value.slice(0, maxHistory)

    setMain(nextEntry)
    activeHistoryId.value = null
    return nextEntry
  }

  function swapWithHistory(itemId) {
    const index = historyItems.value.findIndex((item) => item.id === itemId)
    if (index === -1 || !mainImage.value) return null

    const selected = historyItems.value[index]
    const previousMain = createEntry(
      mainImage.value,
      {
        ...(mainMeta.value ?? {}),
        slotId: selected.slotId ?? selected.id,
      },
    )

    historyItems.value.splice(index, 1, previousMain)
    setMain(selected)
    activeHistoryId.value = selected.id
    return selected
  }

  function clearResults() {
    mainImage.value = null
    mainMeta.value = null
    historyItems.value = []
    activeHistoryId.value = null
  }

  function exportState() {
    const main =
      mainImage.value
        ? normalizePersistedEntry({
            image: mainImage.value,
            meta: mainMeta.value ?? {},
          })
        : null

    const history = historyItems.value
      .map((item) => normalizePersistedEntry(item))
      .filter(Boolean)
      .slice(0, maxHistory)

    return {
      main,
      history,
      activeHistoryId: activeHistoryId.value ?? null,
      updatedAt: Date.now(),
    }
  }

  function hydrateState(snapshot) {
    const nextMain = normalizePersistedEntry(snapshot?.main)
    const nextHistory = Array.isArray(snapshot?.history)
      ? snapshot.history.map((item) => normalizePersistedEntry(item)).filter(Boolean).slice(0, maxHistory)
      : []

    mainImage.value = nextMain?.image || null
    mainMeta.value = nextMain?.meta ?? null
    historyItems.value = nextHistory
    activeHistoryId.value = snapshot?.activeHistoryId ? String(snapshot.activeHistoryId) : null
  }

  return {
    mainImage,
    mainMeta,
    historyItems,
    activeHistoryId,
    pushIncomingResult,
    swapWithHistory,
    clearResults,
    exportState,
    hydrateState,
  }
}
