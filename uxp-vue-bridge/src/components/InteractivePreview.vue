<template>
  <div
    ref="viewportRef"
    class="interactive-preview"
    :class="{
      'is-zoomed': isZoomed,
      'is-dragging': isDragging,
    }"
    @wheel.prevent="handleWheel"
    @pointerdown="handlePointerDown"
    @dblclick="handleDoubleClick"
  >
    <button
      v-if="showResetPill"
      type="button"
      class="preview-reset-pill"
      title="复位视图"
      @pointerdown.stop
      @dblclick.stop
      @click.stop="resetView()"
    >
      复位 · {{ zoomLabel }}
    </button>

    <img
      ref="imageRef"
      :src="src"
      class="interactive-preview-image"
      :style="imageStyle"
      alt=""
      draggable="false"
      @load="handleImageLoad"
    />
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  src: { type: String, default: '' },
})

const emit = defineEmits(['activate'])

const MIN_SCALE = 1
const SOFT_MIN_SCALE = 0.9
const MAX_SCALE = 12
const WHEEL_ZOOM_SENSITIVITY = 0.0022
const OVERSCROLL_FACTOR = 0.32
const IDLE_DRAG_LIMIT = 34
const INERTIA_FRICTION = 0.92
const INERTIA_MIN_SPEED = 0.12
const SPRING_PULL = 0.12

const viewportRef = ref(null)
const imageRef = ref(null)
const viewportWidth = ref(0)
const viewportHeight = ref(0)
const naturalWidth = ref(0)
const naturalHeight = ref(0)
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isDragging = ref(false)
const isElasticDragging = ref(false)

let resizeObserver = null
let pointerId = null
let lastPointerX = 0
let lastPointerY = 0
let lastMoveAt = 0
let velocityX = 0
let velocityY = 0
let dragDistance = 0
let suppressActivateUntil = 0
let inertiaFrame = 0
let tweenFrame = 0
let wheelReboundTimer = 0

const isZoomed = computed(
  () =>
    scale.value > 1.001 ||
    Math.abs(translateX.value) > 0.5 ||
    Math.abs(translateY.value) > 0.5,
)

const hasRealZoom = computed(() => scale.value > 1.001)
const showResetPill = computed(() => hasRealZoom.value)
const zoomLabel = computed(() => `${Math.round(scale.value * 100)}%`)

const baseDisplaySize = computed(() => {
  if (!viewportWidth.value || !viewportHeight.value || !naturalWidth.value || !naturalHeight.value) {
    return { width: 0, height: 0 }
  }

  const fitScale = Math.min(viewportWidth.value / naturalWidth.value, viewportHeight.value / naturalHeight.value)
  return {
    width: naturalWidth.value * fitScale,
    height: naturalHeight.value * fitScale,
  }
})

const imageStyle = computed(() => ({
  width: `${baseDisplaySize.value.width}px`,
  height: `${baseDisplaySize.value.height}px`,
  transform: `translate(-50%, -50%) translate3d(${translateX.value}px, ${translateY.value}px, 0) scale(${scale.value})`,
}))

function cancelAnimations() {
  if (inertiaFrame) {
    cancelAnimationFrame(inertiaFrame)
    inertiaFrame = 0
  }
  if (tweenFrame) {
    cancelAnimationFrame(tweenFrame)
    tweenFrame = 0
  }
}

function clearWheelReboundTimer() {
  if (!wheelReboundTimer) return
  clearTimeout(wheelReboundTimer)
  wheelReboundTimer = 0
}

function normalizeWheelDelta(event, fallbackViewportHeight = 800) {
  let delta = Number(event?.deltaY || 0)
  const mode = Number(event?.deltaMode || 0)

  if (mode === 1) {
    delta *= 16
  } else if (mode === 2) {
    delta *= fallbackViewportHeight
  }

  return delta
}

function resolveElasticScale(rawScale) {
  const clamped = Math.max(SOFT_MIN_SCALE, Math.min(MIN_SCALE, rawScale))
  if (clamped >= MIN_SCALE) return MIN_SCALE

  const overscrollRange = MIN_SCALE - SOFT_MIN_SCALE
  if (overscrollRange <= 0) return MIN_SCALE

  const overscrollRatio = (MIN_SCALE - clamped) / overscrollRange
  const dampedRatio = Math.sqrt(Math.max(0, Math.min(1, overscrollRatio)))
  return MIN_SCALE - dampedRatio * overscrollRange
}

function getViewportMetrics() {
  return {
    width: viewportWidth.value,
    height: viewportHeight.value,
  }
}

function getBaseFitSize(nextScale = scale.value) {
  const { width: currentViewportWidth, height: currentViewportHeight } = getViewportMetrics()
  if (!currentViewportWidth || !currentViewportHeight || !naturalWidth.value || !naturalHeight.value) {
    return { width: 0, height: 0 }
  }

  const fitScale = Math.min(currentViewportWidth / naturalWidth.value, currentViewportHeight / naturalHeight.value)
  return {
    width: naturalWidth.value * fitScale * nextScale,
    height: naturalHeight.value * fitScale * nextScale,
  }
}

function getPanLimits(nextScale = scale.value) {
  if (nextScale <= 1.001) {
    return {
      x: IDLE_DRAG_LIMIT,
      y: IDLE_DRAG_LIMIT,
    }
  }

  const { width: currentViewportWidth, height: currentViewportHeight } = getViewportMetrics()
  const size = getBaseFitSize(nextScale)
  return {
    x: Math.max(0, (size.width - currentViewportWidth) * 0.5),
    y: Math.max(0, (size.height - currentViewportHeight) * 0.5),
  }
}

function clampPan(nextX, nextY, nextScale = scale.value) {
  const limits = getPanLimits(nextScale)
  return {
    x: Math.max(-limits.x, Math.min(limits.x, nextX)),
    y: Math.max(-limits.y, Math.min(limits.y, nextY)),
  }
}

function applyRubberBand(value, limit) {
  if (limit <= 0) return 0
  if (value > limit) {
    return limit + (value - limit) * OVERSCROLL_FACTOR
  }
  if (value < -limit) {
    return -limit + (value + limit) * OVERSCROLL_FACTOR
  }
  return value
}

function commitPan(nextX, nextY, nextScale = scale.value) {
  translateX.value = nextX
  translateY.value = nextY
  scale.value = nextScale
}

function softlyConstrainPan(nextX, nextY, nextScale = scale.value) {
  const limits = getPanLimits(nextScale)
  commitPan(
    applyRubberBand(nextX, limits.x),
    applyRubberBand(nextY, limits.y),
    nextScale,
  )
}

function animateTo(targetScale, targetX, targetY, duration = 180) {
  cancelAnimations()

  const startScale = scale.value
  const startX = translateX.value
  const startY = translateY.value
  const startedAt = performance.now()

  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)

    scale.value = startScale + (targetScale - startScale) * eased
    translateX.value = startX + (targetX - startX) * eased
    translateY.value = startY + (targetY - startY) * eased

    if (progress < 1) {
      tweenFrame = requestAnimationFrame(step)
      return
    }

    tweenFrame = 0
    scale.value = targetScale
    translateX.value = targetX
    translateY.value = targetY
  }

  tweenFrame = requestAnimationFrame(step)
}

function settleIntoBounds(animated = true) {
  const clamped = clampPan(translateX.value, translateY.value, scale.value)
  const shouldResetScale = scale.value <= 1.001

  if (shouldResetScale) {
    if (animated) {
      animateTo(1, 0, 0, 180)
    } else {
      commitPan(0, 0, 1)
    }
    return
  }

  if (animated) {
    animateTo(scale.value, clamped.x, clamped.y, 180)
  } else {
    commitPan(clamped.x, clamped.y, scale.value)
  }
}

function startInertia(initialVX, initialVY) {
  cancelAnimations()
  let nextVX = initialVX
  let nextVY = initialVY

  const tick = () => {
    let nextX = translateX.value + nextVX
    let nextY = translateY.value + nextVY
    const limits = getPanLimits()

    if (nextX > limits.x || nextX < -limits.x) {
      const boundX = Math.max(-limits.x, Math.min(limits.x, nextX))
      nextVX += (boundX - nextX) * SPRING_PULL
      nextX = boundX + (nextX - boundX) * 0.24
      nextVX *= 0.7
    }

    if (nextY > limits.y || nextY < -limits.y) {
      const boundY = Math.max(-limits.y, Math.min(limits.y, nextY))
      nextVY += (boundY - nextY) * SPRING_PULL
      nextY = boundY + (nextY - boundY) * 0.24
      nextVY *= 0.7
    }

    translateX.value = nextX
    translateY.value = nextY

    nextVX *= INERTIA_FRICTION
    nextVY *= INERTIA_FRICTION

    const clamped = clampPan(nextX, nextY)
    const withinBounds =
      Math.abs(nextX - clamped.x) < 0.5 &&
      Math.abs(nextY - clamped.y) < 0.5
    const slowEnough =
      Math.abs(nextVX) < INERTIA_MIN_SPEED &&
      Math.abs(nextVY) < INERTIA_MIN_SPEED

    if (slowEnough && withinBounds) {
      inertiaFrame = 0
      settleIntoBounds(false)
      return
    }

    if (slowEnough) {
      inertiaFrame = 0
      settleIntoBounds(true)
      return
    }

    inertiaFrame = requestAnimationFrame(tick)
  }

  inertiaFrame = requestAnimationFrame(tick)
}

function resetView(animated = true) {
  clearWheelReboundTimer()
  if (animated) {
    animateTo(1, 0, 0, 200)
  } else {
    cancelAnimations()
    commitPan(0, 0, 1)
  }
}

function scheduleWheelRebound() {
  clearWheelReboundTimer()
  wheelReboundTimer = setTimeout(() => {
    wheelReboundTimer = 0
    if (scale.value < 1) {
      animateTo(1, 0, 0, 240)
    }
  }, 70)
}

function handleImageLoad() {
  const image = imageRef.value
  naturalWidth.value = image?.naturalWidth || 0
  naturalHeight.value = image?.naturalHeight || 0
  nextTick(() => {
    resetView(false)
  })
}

function handleWheel(event) {
  if (!naturalWidth.value || !naturalHeight.value) return

  cancelAnimations()
  clearWheelReboundTimer()

  const viewport = viewportRef.value
  if (!viewport) return

  const rect = viewport.getBoundingClientRect()
  const normalizedDeltaY = normalizeWheelDelta(event, rect.height)
  const pointerX = event.clientX - rect.left - rect.width * 0.5
  const pointerY = event.clientY - rect.top - rect.height * 0.5
  const zoomFactor = Math.exp(-normalizedDeltaY * WHEEL_ZOOM_SENSITIVITY)
  const rawNextScale = Math.max(SOFT_MIN_SCALE, Math.min(MAX_SCALE, scale.value * zoomFactor))
  const nextScale = rawNextScale < MIN_SCALE ? resolveElasticScale(rawNextScale) : rawNextScale

  if (Math.abs(nextScale - scale.value) < 0.001) {
    if (scale.value < MIN_SCALE) {
      scheduleWheelRebound()
    }
    return
  }

  if (nextScale < MIN_SCALE) {
    commitPan(0, 0, nextScale)
    scheduleWheelRebound()
    return
  }

  const ratio = nextScale / scale.value
  const nextX = pointerX - (pointerX - translateX.value) * ratio
  const nextY = pointerY - (pointerY - translateY.value) * ratio
  const clamped = clampPan(nextX, nextY, nextScale)

  commitPan(clamped.x, clamped.y, nextScale)
}

function handlePointerDown(event) {
  if (event.button !== 0) {
    return
  }

  const viewport = viewportRef.value
  if (!viewport) return

  cancelAnimations()
  clearWheelReboundTimer()
  pointerId = event.pointerId
  isDragging.value = true
  isElasticDragging.value = !isZoomed.value
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  lastMoveAt = performance.now()
  velocityX = 0
  velocityY = 0
  dragDistance = 0
  viewport.setPointerCapture?.(pointerId)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
}

function handlePointerMove(event) {
  if (!isDragging.value || event.pointerId !== pointerId) {
    return
  }

  const now = performance.now()
  const dx = event.clientX - lastPointerX
  const dy = event.clientY - lastPointerY
  const dt = Math.max(1, now - lastMoveAt)

  dragDistance += Math.abs(dx) + Math.abs(dy)
  velocityX = (dx / dt) * 16.67
  velocityY = (dy / dt) * 16.67
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  lastMoveAt = now

  const multiplier = isElasticDragging.value ? 0.9 : 1
  softlyConstrainPan(translateX.value + dx * multiplier, translateY.value + dy * multiplier)
}

function handlePointerUp(event) {
  if (event.pointerId !== pointerId) {
    return
  }

  const viewport = viewportRef.value
  viewport?.releasePointerCapture?.(pointerId)
  pointerId = null
  isDragging.value = false
  const wasElasticDragging = isElasticDragging.value
  isElasticDragging.value = false
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerUp)

  if (dragDistance > 6) {
    suppressActivateUntil = performance.now() + 260
  }

  if (wasElasticDragging) {
    settleIntoBounds(true)
    return
  }

  if (Math.abs(velocityX) > INERTIA_MIN_SPEED || Math.abs(velocityY) > INERTIA_MIN_SPEED) {
    startInertia(velocityX, velocityY)
    return
  }

  settleIntoBounds(true)
}

function handleDoubleClick() {
  if (performance.now() < suppressActivateUntil) {
    return
  }
  emit('activate')
}

watch(
  () => props.src,
  () => {
    naturalWidth.value = 0
    naturalHeight.value = 0
    suppressActivateUntil = 0
    resetView(false)
  },
)

onMounted(() => {
  const updateViewportMetrics = () => {
    const viewport = viewportRef.value
    viewportWidth.value = viewport?.clientWidth || 0
    viewportHeight.value = viewport?.clientHeight || 0
  }

  resizeObserver = new ResizeObserver(() => {
    updateViewportMetrics()
    if (!naturalWidth.value || !naturalHeight.value) return
    settleIntoBounds(false)
  })

  if (viewportRef.value) {
    updateViewportMetrics()
    resizeObserver.observe(viewportRef.value)
  }
})

onBeforeUnmount(() => {
  cancelAnimations()
  clearWheelReboundTimer()
  resizeObserver?.disconnect()
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerUp)
})
</script>

<style scoped>
.interactive-preview {
  position: absolute;
  inset: 0;
  overflow: hidden;
  z-index: 1;
  user-select: none;
  touch-action: none;
  cursor: default;
}

.interactive-preview.is-zoomed {
  cursor: grab;
}

.interactive-preview.is-dragging {
  cursor: grabbing;
}

.interactive-preview-image {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  max-height: none;
  transform-origin: center center;
  will-change: transform;
  user-select: none;
  pointer-events: none;
}

.preview-reset-pill {
  position: absolute;
  top: 44px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 12;
  height: 24px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(18, 18, 18, 0.72);
  color: rgba(255, 255, 255, 0.9);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.26);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
  cursor: pointer;
}

.preview-reset-pill:hover {
  background: rgba(34, 34, 34, 0.82);
  border-color: rgba(255, 255, 255, 0.18);
  transform: translateX(-50%) translateY(-1px);
}
</style>
