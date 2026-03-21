<template>
  <Transition name="slide-up-left">
    <div v-if="visible" class="workflow-browser-overlay" @click.self="close">
      <div class="workflow-browser">
        <div class="browser-header">
          <div class="search-box">
            <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input v-model="searchQuery" type="text" placeholder="搜索本地工作流..." class="search-input" />
            <button v-if="searchQuery" class="clear-search" @click="searchQuery = ''">&times;</button>
          </div>
        </div>

        <div class="browser-body">
          <div v-if="filteredWorkflows.length === 0" class="empty-state">
            <span>未找到匹配的工作流</span>
          </div>

          <div v-else class="workflow-list">
            <div
              v-for="wf in filteredWorkflows"
              :key="wf.id || wf.name"
              class="workflow-item"
              @click="handleSelect(wf)"
            >
              <span class="status-dot" :class="{ active: wf.isOpen }"></span>
              <div class="wf-copy">
                <span class="wf-name">{{ displayName(wf) }}</span>
                <span v-if="workflowHint(wf)" class="wf-hint">{{ workflowHint(wf) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:visible', 'select'])

const searchQuery = ref('')
const duplicateNameCounts = computed(() => {
  const counts = new Map()

  for (const workflow of props.items) {
    const key = displayName(workflow).toLowerCase()
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  return counts
})

const filteredWorkflows = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return props.items

  return props.items.filter((wf) => {
    const candidates = [
      displayName(wf),
      String(wf?.filename || ''),
      String(wf?.path || ''),
    ]
    return candidates.some((item) => item.toLowerCase().includes(query))
  })
})

function displayName(wf) {
  return (wf?.name || '').replace(/\.json$/i, '')
}

function workflowHint(wf) {
  const nameKey = displayName(wf).toLowerCase()
  if ((duplicateNameCounts.value.get(nameKey) || 0) <= 1) {
    return ''
  }

  const normalizedPath = String(wf?.path || '').replace(/\\/g, '/')
  const pathParts = normalizedPath.split('/').filter(Boolean)
  if (pathParts.length >= 2) {
    return pathParts.slice(-2).join('/')
  }

  return String(wf?.filename || normalizedPath || '')
}

function close() {
  emit('update:visible', false)
}

function handleSelect(wf) {
  emit('select', wf)
  close()
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      searchQuery.value = ''
    }
  },
)
</script>

<style scoped>
.workflow-browser-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 64px;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 0 0 0 14px;
  pointer-events: auto;
}

.workflow-browser {
  pointer-events: auto;
  width: 45%;
  min-width: 220px;
  max-width: 300px;
  height: 60%;
  max-height: 400px;
  background: rgba(36, 36, 36, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin-bottom: 2px;
}

.slide-up-left-enter-active,
.slide-up-left-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-left-enter-from,
.slide-up-left-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.98);
}

.browser-header {
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  background: rgba(0, 0, 0, 0.2);
}

.search-box {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 4px 8px;
  gap: 6px;
  transition: border-color 0.2s;
}

.search-box:focus-within {
  border-color: var(--c-blue, #528BFF);
}

.search-icon {
  color: var(--c-t3, #888);
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  color: #eee;
  font-size: 12px;
  outline: none;
  min-width: 0;
}

.search-input::placeholder {
  color: #666;
}

.clear-search {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.clear-search:hover {
  color: #fff;
}

.browser-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.browser-body::-webkit-scrollbar {
  width: 6px;
}

.browser-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.browser-body::-webkit-scrollbar-track {
  background: transparent;
}

.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100px;
  color: var(--c-t3, #888);
  font-size: 12px;
}

.workflow-list {
  display: flex;
  flex-direction: column;
}

.workflow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.workflow-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}

.status-dot.active {
  background: var(--c-blue, #528BFF);
  box-shadow: 0 0 6px var(--c-blue, #528BFF);
}

.wf-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wf-name {
  font-size: 12px;
  color: var(--c-t1, #ddd);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-hint {
  font-size: 10px;
  color: var(--c-t3, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
