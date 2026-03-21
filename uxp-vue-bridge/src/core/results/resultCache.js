const DB_NAME = 'comfyps-result-cache'
const DB_VERSION = 1
const STORE_NAME = 'result_states'
const MAX_PERSISTED_IMAGE_CHARS_PER_ENTRY = 3 * 1024 * 1024
const MAX_PERSISTED_IMAGE_CHARS_TOTAL = 8 * 1024 * 1024
const MAX_PERSISTED_HISTORY_ITEMS = 4

let openDbPromise = null

function getIndexedDb() {
  if (typeof window === 'undefined') return null
  return window.indexedDB || null
}

function cloneMeta(meta) {
  if (!meta || typeof meta !== 'object') return {}
  try {
    return JSON.parse(JSON.stringify(meta))
  } catch {
    return {}
  }
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const image = typeof entry.image === 'string' ? entry.image : ''
  if (!image) return null
  const meta = cloneMeta(entry.meta)
  const id = String(entry.id || meta.id || `result-${Date.now()}`)
  const slotId = String(entry.slotId || meta.slotId || id)
  return { id, slotId, image, meta }
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      main: null,
      history: [],
      activeHistoryId: null,
      updatedAt: Date.now(),
    }
  }

  const main = normalizeEntry(snapshot.main)
  const history = Array.isArray(snapshot.history)
    ? snapshot.history.map(normalizeEntry).filter(Boolean)
    : []
  const activeHistoryId = snapshot.activeHistoryId ? String(snapshot.activeHistoryId) : null

  return {
    main,
    history,
    activeHistoryId,
    updatedAt: Number.isFinite(Number(snapshot.updatedAt)) ? Number(snapshot.updatedAt) : Date.now(),
  }
}

function getEntryImageSize(entry) {
  return typeof entry?.image === 'string' ? entry.image.length : 0
}

function pruneSnapshotForPersistence(snapshot) {
  const normalized = normalizeSnapshot(snapshot)
  let remainingBudget = MAX_PERSISTED_IMAGE_CHARS_TOTAL
  let main = null

  if (normalized.main) {
    const mainSize = getEntryImageSize(normalized.main)
    if (
      mainSize > 0 &&
      mainSize <= MAX_PERSISTED_IMAGE_CHARS_PER_ENTRY &&
      mainSize <= remainingBudget
    ) {
      main = normalized.main
      remainingBudget -= mainSize
    }
  }

  const history = []
  for (const entry of normalized.history) {
    if (history.length >= MAX_PERSISTED_HISTORY_ITEMS) {
      break
    }

    const entrySize = getEntryImageSize(entry)
    if (
      entrySize <= 0 ||
      entrySize > MAX_PERSISTED_IMAGE_CHARS_PER_ENTRY ||
      entrySize > remainingBudget
    ) {
      continue
    }

    history.push(entry)
    remainingBudget -= entrySize
  }

  const activeHistoryId = history.some((item) => item.id === normalized.activeHistoryId)
    ? normalized.activeHistoryId
    : null

  return {
    main,
    history,
    activeHistoryId,
    updatedAt: normalized.updatedAt,
  }
}

function openDatabase() {
  const indexedDb = getIndexedDb()
  if (!indexedDb) return Promise.resolve(null)
  if (openDbPromise) return openDbPromise

  openDbPromise = new Promise((resolve) => {
    try {
      const request = indexedDb.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'mode' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })

  return openDbPromise
}

function withStore(mode, txMode, executor) {
  return openDatabase().then((db) => {
    if (!db) return null
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(STORE_NAME, txMode)
        const store = transaction.objectStore(STORE_NAME)
        executor(store, resolve)
      } catch {
        resolve(null)
      }
    })
  })
}

export async function loadResultCache(mode) {
  const cacheMode = String(mode || '').trim()
  if (!cacheMode) return null

  const result = await withStore(cacheMode, 'readonly', (store, resolve) => {
    const request = store.get(cacheMode)
    request.onsuccess = () => resolve(normalizeSnapshot(request.result?.state))
    request.onerror = () => resolve(null)
  })

  return result || normalizeSnapshot(null)
}

export async function saveResultCache(mode, snapshot) {
  const cacheMode = String(mode || '').trim()
  if (!cacheMode) return false

  const payload = {
    mode: cacheMode,
    state: pruneSnapshotForPersistence(snapshot),
    savedAt: Date.now(),
  }

  const result = await withStore(cacheMode, 'readwrite', (store, resolve) => {
    const request = store.put(payload)
    request.onsuccess = () => resolve(true)
    request.onerror = () => resolve(false)
  })

  return result === true
}

export async function clearResultCache(mode) {
  const cacheMode = String(mode || '').trim()
  if (!cacheMode) return false

  const result = await withStore(cacheMode, 'readwrite', (store, resolve) => {
    const request = store.delete(cacheMode)
    request.onsuccess = () => resolve(true)
    request.onerror = () => resolve(false)
  })

  return result === true
}
