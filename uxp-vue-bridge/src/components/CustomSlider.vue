<template>
  <div class="custom-slider">
    <div class="slider-track-area" ref="slider" @mousedown="onMouseDown">
      <div class="track"></div>
      <div class="fill" :style="{ width: displayPercent + '%' }"></div>
      <div class="thumb" :style="{ left: displayPercent + '%' }"></div>
    </div>
    <div v-if="showTicks" class="ticks">
      <button
        v-for="entry in positionEntries"
        :key="entry.value"
        type="button"
        class="tick"
        :class="{ active: activeValue === entry.value }"
        :style="getTickStyle(entry.position)"
        @mousedown.stop.prevent="selectValue(entry.value)"
      >
        <span class="tick-line"></span>
        <span v-if="showTickLabel(entry.value)" class="tick-label">{{ entry.value }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 1 },
  max: { type: Number, default: 9 },
  step: { type: Number, default: 1 },
  positions: { type: Array, default: () => [] },
  showTicks: { type: Boolean, default: false },
  labeledTicks: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:modelValue'])
const slider = ref(null)
const dragPercent = ref(null)
const dragValue = ref(null)

const values = computed(() => {
  const result = []
  const safeStep = props.step > 0 ? props.step : 1
  for (let value = props.min; value <= props.max; value += safeStep) {
    result.push(value)
  }
  if (!result.includes(props.max)) {
    result.push(props.max)
  }
  return result
})

const positionEntries = computed(() => {
  const valueList = values.value
  if (
    Array.isArray(props.positions) &&
    props.positions.length === valueList.length &&
    props.positions.every((position) => Number.isFinite(Number(position)))
  ) {
    return valueList.map((value, index) => ({
      value,
      position: Number(props.positions[index]),
    }))
  }

  const span = props.max - props.min || 1
  return valueList.map((value) => ({
    value,
    position: ((value - props.min) / span) * 100,
  }))
})

const percent = computed(() => {
  const entry = positionEntries.value.find((item) => item.value === props.modelValue)
  return entry ? entry.position : 0
})

const displayPercent = computed(() => (dragPercent.value == null ? percent.value : dragPercent.value))
const activeValue = computed(() => (dragValue.value == null ? props.modelValue : dragValue.value))

let isDragging = false

function updateValue(clientX) {
  if (!slider.value) return
  const rect = slider.value.getBoundingClientRect()
  let p = (clientX - rect.left) / rect.width
  p = Math.max(0, Math.min(1, p))

  const targetPercent = p * 100
  if (positionEntries.value.length) {
    let nearest = positionEntries.value[0]
    for (const entry of positionEntries.value) {
      if (Math.abs(entry.position - targetPercent) < Math.abs(nearest.position - targetPercent)) {
        nearest = entry
      }
    }
    const snapThreshold = 3
    dragPercent.value = Math.abs(nearest.position - targetPercent) <= snapThreshold
      ? nearest.position
      : targetPercent
    dragValue.value = nearest.value
    emit('update:modelValue', nearest.value)
    return
  }

  let val = p * (props.max - props.min) + props.min
  if (props.step > 0) {
    val = Math.round(val / props.step) * props.step
  }
  dragPercent.value = targetPercent
  dragValue.value = val
  emit('update:modelValue', val)
}

function selectValue(value) {
  dragPercent.value = null
  dragValue.value = null
  emit('update:modelValue', value)
}

function showTickLabel(value) {
  return Array.isArray(props.labeledTicks) && props.labeledTicks.includes(value)
}

function getTickStyle(position) {
  if (position <= 0) {
    return { left: '0%', transform: 'translateX(0)' }
  }
  if (position >= 100) {
    return { left: '100%', transform: 'translateX(-100%)' }
  }
  return { left: `${position}%`, transform: 'translateX(-50%)' }
}

function onMouseDown(e) {
  isDragging = true
  updateValue(e.clientX)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e) {
  if (!isDragging) return
  updateValue(e.clientX)
}

function onMouseUp() {
  isDragging = false
  dragPercent.value = null
  dragValue.value = null
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
}

onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
})
</script>

<style scoped>
.custom-slider {
  width: 100%;
}

.slider-track-area {
  position: relative;
  width: 100%;
  height: 24px; /* hit area */
  display: flex;
  align-items: center;
  cursor: pointer;
}

.track {
  width: 100%;
  height: 4px;
  background: #333;
  border-radius: 2px;
}

.fill {
  position: absolute;
  height: 4px;
  background: #528BFF;
  border-radius: 2px;
  pointer-events: none;
}

.thumb {
  position: absolute;
  width: 16px;
  height: 16px;
  background: #528BFF;
  border-radius: 50%;
  transform: translateX(-50%);
  box-shadow: 0 2px 4px rgba(0,0,0,0.5);
  pointer-events: none;
  transition: transform 0.1s;
}

.slider-track-area:active .thumb {
  transform: translateX(-50%) scale(1.2);
}

.ticks {
  position: relative;
  height: 22px;
  margin-top: 4px;
}

.tick {
  position: absolute;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: #767676;
  cursor: pointer;
}

.tick-line {
  width: 2px;
  height: 8px;
  border-radius: 999px;
  background: #454545;
}

.tick-label {
  font-size: 10px;
  line-height: 1;
}

.tick.active .tick-line {
  background: #528BFF;
  height: 10px;
}

.tick.active .tick-label {
  color: #528BFF;
}
</style>
