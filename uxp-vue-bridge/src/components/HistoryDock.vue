<template>
  <div class="history-wrapper" :style="{ bottom }">
    <div
      ref="historyContainerRef"
      class="history-container"
      :class="{ 'is-dragging': isDragging }"
      @mousedown="onDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onLeave"
      @scroll="onScroll"
      @wheel.prevent="onWheel"
    >
      <div class="history-track" :style="trackStyle">
        <div class="history" @click.self="emit('clear-active')">
          <div
            v-for="(entry, index) in displayEntries"
            :key="`slot-${entry.visualSlot}`"
            class="h-card"
            :class="{
              active: entry.item.id === activeSlot,
              'has-img': entry.item.image,
            }"
            :style="cardStyle(entry.item, index)"
            @click="onCardClick(entry.item)"
          >
            <div class="h-card-content" :style="cardContentStyle(entry.item, index)">
              <img
                v-if="entry.item.image"
                :src="entry.item.image"
                class="h-thumb"
                alt=""
                @dragstart.prevent
              />
              <span v-else class="h-num">{{ entry.item.text }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  activeSlot: {
    type: [String, Number, null],
    default: null,
  },
  bottom: {
    type: String,
    default: '93px',
  },
  historyItems: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['clear-active', 'select'])

const BASE_H = 38
const MIN_RATIO = 0.72
const MAX_RATIO = 1.58
const TRACK_SIDE_PADDING = 12
const BASE_GAP = 4
const FOCUS_RADIUS_PX = 94
const SLOT_WIDTH_GAIN = 18
const SLOT_HEIGHT_GAIN = 18
const CONTENT_SCALE_GAIN = 0.22
const POINTER_LERP = 0.24
const FOCUS_HOVER_PRIORITY_EPSILON = 0.08

const historyContainerRef = ref(null)
const containerWidth = ref(0)
const scrollLeft = ref(0)
const isDragging = ref(false)
const smoothPointerX = ref(null)

let pointerLocalX = null
let targetPointerX = null
let animationFrameId = null

let isPointerDown = false
let dragStartX = 0
let dragStartScroll = 0
let velocity = 0
let lastTime = 0
let lastX = 0
let momentumFrameId = null
let noClickUntil = 0

const displayEntries = computed(() => {
  const items = Array.isArray(props.historyItems) ? props.historyItems : []
  if (items.length <= 1) {
    return items.map((item, index) => ({ item, visualSlot: index }))
  }

  const placed = items.map((item, index) => {
    let visualSlot = 0

    if (index === 0) {
      visualSlot = 0
    } else {
      const ring = Math.ceil(index / 2)
      visualSlot = index % 2 === 1 ? ring : -ring
    }

    return { item, visualSlot }
  })

  return placed
    .sort((left, right) => left.visualSlot - right.visualSlot)
})

function baseWidth(item) {
  if (!item?.image) return BASE_H
  const imageWidth = Number(item?.meta?.imageWidth || item?.meta?.width || 0)
  const imageHeight = Number(item?.meta?.imageHeight || item?.meta?.height || 0)
  if (imageWidth > 0 && imageHeight > 0) {
    return Math.round(BASE_H * Math.min(MAX_RATIO, Math.max(MIN_RATIO, imageWidth / imageHeight)))
  }
  return BASE_H
}

const layoutMetrics = computed(() => {
  const items = displayEntries.value
  const widths = items.map((entry) => baseWidth(entry.item))
  const baseContentWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, widths.length - 1) * BASE_GAP +
    TRACK_SIDE_PADDING * 2
  const effectiveContainerWidth = Math.max(containerWidth.value, 0)
  const centeringOffset =
    effectiveContainerWidth > baseContentWidth
      ? Math.floor((effectiveContainerWidth - baseContentWidth) / 2)
      : 0

  const centers = []
  const slots = []
  let currentLeft = TRACK_SIDE_PADDING + centeringOffset
  for (const width of widths) {
    const left = currentLeft
    const center = left + width / 2
    const right = left + width
    centers.push(center)
    slots.push({ left, center, right, width })
    currentLeft += width + BASE_GAP
  }

  return {
    baseContentWidth,
    centers,
    slots,
    widths,
    contentWidth: Math.max(baseContentWidth + centeringOffset * 2, effectiveContainerWidth),
  }
})

function rawInfluenceForIndex(index, pointer, centers) {
  const center = centers[index]
  if (typeof center !== 'number') return 0

  const distance = Math.abs(pointer - center)
  if (distance >= FOCUS_RADIUS_PX) return 0

  return (Math.cos((distance / FOCUS_RADIUS_PX) * Math.PI) + 1) * 0.5
}

const hoveredFocusIndex = computed(() => {
  if (isDragging.value) return 0
  const pointer = smoothPointerX.value
  if (pointer == null) return -1

  const slots = layoutMetrics.value.slots
  return slots.findIndex((slot) => pointer >= slot.left && pointer <= slot.right)
})

const influenceByIndex = computed(() => {
  if (isDragging.value) {
    return displayEntries.value.map(() => 0)
  }

  const pointer = smoothPointerX.value
  if (pointer == null) {
    return displayEntries.value.map(() => 0)
  }

  const centers = layoutMetrics.value.centers
  const influences = centers.map((_, index) => rawInfluenceForIndex(index, pointer, centers))
  const focusIndex = hoveredFocusIndex.value

  if (focusIndex >= 0) {
    let strongestOther = 0
    for (let index = 0; index < influences.length; index += 1) {
      if (index === focusIndex) continue
      strongestOther = Math.max(strongestOther, influences[index] || 0)
    }

    influences[focusIndex] = Math.max(
      influences[focusIndex] || 0,
      Math.min(1, strongestOther + FOCUS_HOVER_PRIORITY_EPSILON),
    )
  }

  return influences
})

function metricsForItem(item, index) {
  const baseW = baseWidth(item)
  const influence = index >= 0 ? influenceByIndex.value[index] || 0 : 0
  const slotWidth = baseW + SLOT_WIDTH_GAIN * influence
  const slotHeight = BASE_H + SLOT_HEIGHT_GAIN * influence
  const contentScale = 1 + CONTENT_SCALE_GAIN * influence
  const isActive = item.id === props.activeSlot

  return {
    influence,
    isActive,
    slotWidth,
    slotHeight,
    contentScale,
    zIndex: 6 + Math.round(influence * 20) + (isActive ? 2 : 0),
    opacity: isActive ? 1 : Number((0.72 + 0.28 * influence).toFixed(3)),
  }
}

function cardStyle(item, index) {
  const metrics = metricsForItem(item, index)
  return {
    width: `${metrics.slotWidth.toFixed(3)}px`,
    height: `${metrics.slotHeight.toFixed(3)}px`,
    opacity: String(metrics.opacity),
    zIndex: String(metrics.zIndex),
  }
}

function cardContentStyle(item, index) {
  const metrics = metricsForItem(item, index)
  return {
    transform: `scale(${metrics.contentScale})`,
  }
}

const trackStyle = computed(() => ({
  minWidth: `${layoutMetrics.value.contentWidth}px`,
}))

function syncPointerTargetFromLocalX() {
  if (!historyContainerRef.value || pointerLocalX == null) return
  targetPointerX = pointerLocalX + historyContainerRef.value.scrollLeft
  startPointerAnimation()
}

function startPointerAnimation() {
  if (!animationFrameId) {
    animationFrameId = requestAnimationFrame(stepPointerAnimation)
  }
}

function stepPointerAnimation() {
  animationFrameId = null

  if (targetPointerX == null) {
    if (smoothPointerX.value == null) return
    smoothPointerX.value = null
    return
  }

  const current = smoothPointerX.value == null ? targetPointerX : smoothPointerX.value
  const next = current + (targetPointerX - current) * POINTER_LERP
  smoothPointerX.value = Math.abs(targetPointerX - next) < 0.1 ? targetPointerX : next

  if (smoothPointerX.value !== targetPointerX) {
    animationFrameId = requestAnimationFrame(stepPointerAnimation)
  }
}

function updateContainerWidth() {
  containerWidth.value = historyContainerRef.value?.clientWidth || 0
}

function onMove(event) {
  if (!historyContainerRef.value) return

  const rect = historyContainerRef.value.getBoundingClientRect()
  pointerLocalX = event.clientX - rect.left

  if (!isDragging.value) {
    syncPointerTargetFromLocalX()
  }

  if (!isPointerDown) return

  const currentX = event.pageX - historyContainerRef.value.offsetLeft
  const walk = (currentX - dragStartX) * 1.5

  if (!isDragging.value && Math.abs(walk) > 6) {
    isDragging.value = true
    smoothPointerX.value = null
  }

  if (!isDragging.value) return

  event.preventDefault()
  historyContainerRef.value.scrollLeft = dragStartScroll - walk
  scrollLeft.value = historyContainerRef.value.scrollLeft

  const now = performance.now()
  const deltaTime = now - lastTime
  if (deltaTime > 0) {
    velocity = (event.pageX - lastX) / deltaTime
  }
  lastX = event.pageX
  lastTime = now
}

function onDown(event) {
  if (!historyContainerRef.value) return
  isPointerDown = true
  isDragging.value = false
  dragStartX = event.pageX - historyContainerRef.value.offsetLeft
  dragStartScroll = historyContainerRef.value.scrollLeft
  lastX = event.pageX
  lastTime = performance.now()
  velocity = 0
  if (momentumFrameId) cancelAnimationFrame(momentumFrameId)
}

function onUp() {
  if (!isPointerDown) return

  const wasDragging = isDragging.value
  isPointerDown = false
  isDragging.value = false

  if (!wasDragging) {
    velocity = 0
    syncPointerTargetFromLocalX()
    return
  }

  noClickUntil = Date.now() + 120
  let currentVelocity = velocity * 15
  lastTime = performance.now()

  const applyMomentum = (time) => {
    if (!historyContainerRef.value) return
    const deltaTime = time - lastTime
    lastTime = time

    if (Math.abs(currentVelocity) > 0.5) {
      historyContainerRef.value.scrollLeft -= currentVelocity * (deltaTime / 16.6)
      scrollLeft.value = historyContainerRef.value.scrollLeft
      if (pointerLocalX != null) {
        targetPointerX = pointerLocalX + historyContainerRef.value.scrollLeft
        startPointerAnimation()
      }
      currentVelocity *= 0.92
      momentumFrameId = requestAnimationFrame(applyMomentum)
    } else if (pointerLocalX != null) {
      syncPointerTargetFromLocalX()
    }
  }

  if (Math.abs(velocity) > 0.1) {
    momentumFrameId = requestAnimationFrame(applyMomentum)
  } else if (pointerLocalX != null) {
    syncPointerTargetFromLocalX()
  }
}

function onLeave() {
  pointerLocalX = null
  targetPointerX = null
  smoothPointerX.value = null
  onUp()
}

function onScroll() {
  scrollLeft.value = historyContainerRef.value?.scrollLeft || 0
  if (!isDragging.value && pointerLocalX != null) {
    syncPointerTargetFromLocalX()
  }
}

function onCardClick(item) {
  if (Date.now() < noClickUntil) return
  emit('select', item)
}

function onWheel(event) {
  if (momentumFrameId) cancelAnimationFrame(momentumFrameId)
  if (!historyContainerRef.value) return

  historyContainerRef.value.scrollBy({
    left: event.deltaY > 0 ? 100 : -100,
    behavior: 'smooth',
  })
}

let resizeObserver = null

onMounted(() => {
  updateContainerWidth()
  if (typeof ResizeObserver !== 'undefined' && historyContainerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateContainerWidth()
      if (!isDragging.value && pointerLocalX != null) {
        syncPointerTargetFromLocalX()
      }
    })
    resizeObserver.observe(historyContainerRef.value)
  }
})

watch(displayEntries, () => {
  updateContainerWidth()
  if (!isDragging.value && pointerLocalX != null) {
    syncPointerTargetFromLocalX()
  }
}, { flush: 'post' })

onUnmounted(() => {
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
  if (momentumFrameId) cancelAnimationFrame(momentumFrameId)
  resizeObserver?.disconnect?.()
})
</script>

<style scoped>
.history-wrapper {
  display: flex;
  flex-direction: column;
  position: absolute;
  left: 8px;
  right: 8px;
  z-index: 20;
  pointer-events: none;
  transition: bottom 0.3s ease;
}

.history-container {
  height: 72px;
  margin-top: -12px;
  overflow-x: auto;
  overflow-y: hidden;
  width: 100%;
  pointer-events: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  user-select: none;
  cursor: grab;
}

.history-container::-webkit-scrollbar {
  display: none;
}

.history-container:active,
.history-container.is-dragging {
  cursor: grabbing;
}

.history-container.is-dragging .h-card,
.history-container.is-dragging .h-card-content,
.history-container.is-dragging .h-thumb,
.history-container.is-dragging .h-num {
  pointer-events: none;
}

.history-track {
  height: 100%;
}

.history {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-width: 100%;
  height: 72px;
  padding: 0 12px 4px;
  position: relative;
  z-index: 11;
}

.list-enter-active,
.list-leave-active {
  transition: none;
}

.list-move {
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.list-enter-from,
.list-leave-to {
  opacity: 1;
  width: auto !important;
  transform: none;
  margin: 0 2px;
}

.h-card {
  min-width: 38px;
  margin: 0 2px;
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  position: relative;
  transition:
    width 0.12s linear,
    height 0.12s linear,
    opacity 0.12s linear;
}

.h-card::after {
  content: '';
  position: absolute;
  top: -14px;
  bottom: -14px;
  left: -10px;
  right: -10px;
}

.h-card-content {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: rgba(22, 24, 30, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--r);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
  transform-origin: center bottom;
  transition:
    transform 0.12s linear,
    background 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.h-card.active .h-card-content {
  background: rgba(31, 47, 73, 0.92);
  border-color: rgba(104, 171, 255, 0.9);
  box-shadow:
    0 0 0 1px rgba(104, 171, 255, 0.28),
    0 0 10px var(--c-blue-glow),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.h-card.has-img {
  overflow: visible;
}

.h-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 10px;
  color: var(--c-t3);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  transition:
    color 0.18s ease,
    font-size 0.12s linear;
}

.h-card.active .h-num {
  color: var(--c-blue);
  font-weight: 700;
}

.h-thumb {
  height: 100%;
  width: auto;
  max-width: 100%;
  object-fit: contain;
  border-radius: 3px;
  display: block;
}
</style>
