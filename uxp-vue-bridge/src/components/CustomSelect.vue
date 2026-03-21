<template>
  <div ref="rootRef" class="custom-select" :tabindex="0" @blur="open = false">
    <div class="selected" :class="{ open }" @click="open = !open">
      {{ selectedLabel }}
      <svg class="arrow" :class="{ up: open }" viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </div>
    <Transition name="fade">
      <div ref="itemsRef" class="items" :class="{ compact: compactMenu, upward: openUpward }" v-show="open">
        <div 
          v-for="option in options" 
          :key="option.value"
          :ref="option.value === modelValue ? setActiveItemRef : undefined"
          class="item"
          :class="{ active: option.value === modelValue }"
          @click="select(option)"
        >
          {{ option.label }}
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'

const props = defineProps({
  modelValue: {
    type: [String, Number],
    required: true
  },
  options: {
    type: Array, // Array of { label: String, value: Any }
    required: true
  },
  maxVisibleItems: {
    type: Number,
    default: 6
  }
})

const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const openUpward = ref(false)
const rootRef = ref(null)
const itemsRef = ref(null)
const activeItemRef = ref(null)
const compactMenu = computed(() => props.options.length <= props.maxVisibleItems)

const selectedLabel = computed(() => {
  const found = props.options.find(o => o.value === props.modelValue)
  return found ? found.label : (props.options[0]?.label || '')
})

function select(option) {
  emit('update:modelValue', option.value)
  open.value = false
}

function setActiveItemRef(el) {
  activeItemRef.value = el || null
}

function findScrollParent(element) {
  let current = element?.parentElement || null
  while (current) {
    const { overflowY } = window.getComputedStyle(current)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

function updateOpenDirection() {
  const root = rootRef.value
  if (!root) return

  const scrollParent = findScrollParent(root)
  const rootRect = root.getBoundingClientRect()

  if (!scrollParent) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
    openUpward.value = viewportHeight - rootRect.bottom < 220 && rootRect.top > viewportHeight / 3
    return
  }

  const parentRect = scrollParent.getBoundingClientRect()
  const spaceBelow = parentRect.bottom - rootRect.bottom
  const spaceAbove = rootRect.top - parentRect.top
  openUpward.value = spaceBelow < 220 && spaceAbove > spaceBelow
}

watch(open, async (isOpen) => {
  if (!isOpen) return

  await nextTick()
  updateOpenDirection()
  await nextTick()

  if (activeItemRef.value) {
    activeItemRef.value.scrollIntoView({ block: 'nearest' })
  }
})
</script>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
  outline: none;
  font-size: 12px;
  color: #e0e0e0;
}

.selected {
  background: var(--bg-input, #1e1e1e);
  border: 1px solid var(--border-color, #444);
  border-radius: 4px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: border-color 0.2s;
}

.selected:hover {
  border-color: #555;
}

.selected.open {
  border-color: #528BFF;
}

.arrow {
  transition: transform 0.2s;
}
.arrow.up {
  transform: rotate(180deg);
}

.items {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  overflow: hidden;
  z-index: 100;
  max-height: 200px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}

.items.upward {
  top: auto;
  bottom: calc(100% + 4px);
}

.items.compact {
  max-height: none;
  overflow-y: visible;
}

.item {
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
  transition: background 0.2s;
  color: #ccc;
}

.item:hover {
  background: #3a3a3a;
  color: #fff;
}

.item.active {
  background: rgba(82, 139, 255, 0.2);
  color: #528BFF;
  font-weight: 500;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}
</style>
