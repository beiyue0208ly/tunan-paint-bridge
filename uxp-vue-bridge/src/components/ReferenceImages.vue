<template>
  <div
    ref="rootRef"
    class="ref-images"
    :class="{ expanded: isExpanded, 'is-drag-over': isDragOver, 'is-full': isAtLimit }"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <div v-if="!isExpanded" class="ref-collapsed" @click="isExpanded = true">
      <span class="ref-collapsed-text">
        参考图{{ modelValue.length > 0 ? ' (' + modelValue.length + ')' : '' }}
      </span>
      <svg class="ref-caret" width="8" height="5" viewBox="0 0 8 5">
        <path d="M.5.5 4 4 7.5.5" stroke="currentColor" fill="none" stroke-width="1.2" />
      </svg>
    </div>

    <div v-else class="ref-row-expanded">
      <span class="ref-side-label">参考图</span>

      <div class="ref-box" :class="{ 'is-drag-over': isDragOver, 'is-full': isAtLimit }" @click.self="handleBoxBackdropClick">
        <div class="ref-cards" @click.stop>
          <div
            v-for="(img, idx) in modelValue"
            :key="img.id"
            class="ref-card"
            @mouseenter="hoverIdx = idx"
            @mouseleave="hoverIdx = -1"
          >
            <img :src="img.data" class="ref-thumb" alt="" />
            <button class="ref-remove" @click.stop="removeImage(idx)" title="移除">
              <svg width="6" height="6" viewBox="0 0 10 10" fill="currentColor">
                <path d="M1.5.4.4 1.5 3.9 5 .4 8.5 1.5 9.6 5 6.1l3.5 3.5 1.1-1.1L6.1 5 9.6 1.5 8.5.4 5 3.9z" />
              </svg>
            </button>
            <Transition name="preview-pop">
              <div v-if="hoverIdx === idx" class="ref-preview">
                <img :src="img.data" class="ref-preview-img" alt="" />
              </div>
            </Transition>
          </div>

          <button
            v-if="!isAtLimit"
            type="button"
            class="ref-add-card"
            title="上传参考图"
            @click.stop="uploadLocal"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.35">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
          </button>
        </div>

        <Transition name="fade">
          <div v-if="isDragOver && !isAtLimit" class="ref-drop-indicator">
            拖到这里导入参考图
          </div>
        </Transition>
      </div>

      <div class="ref-side-tools">
        <span class="ref-side-hint">上传</span>
        <span class="ref-side-count">{{ modelValue.length }}/3</span>
      </div>
    </div>

    <input ref="fileInput" type="file" accept="image/*" multiple style="display:none" @change="handleFileUpload" />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  expanded: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'update:expanded'])

const hoverIdx = ref(-1)
const fileInput = ref(null)
const rootRef = ref(null)
const isDragOver = ref(false)
const dragDepth = ref(0)

const MAX_IMAGES = 3
let nextId = 1

const isAtLimit = computed(() => props.modelValue.length >= MAX_IMAGES)

const isExpanded = computed({
  get: () => props.expanded,
  set: (value) => {
    if (!value) {
      hoverIdx.value = -1
      isDragOver.value = false
      dragDepth.value = 0
    }
    emit('update:expanded', value)
  },
})

function handleBoxBackdropClick() {
  if (isDragOver.value) return
  isExpanded.value = false
}

function removeImage(idx) {
  const updated = [...props.modelValue]
  updated.splice(idx, 1)
  emit('update:modelValue', updated)
}

function uploadLocal() {
  if (isAtLimit.value) return
  fileInput.value?.click()
}

function hasImageFiles(fileList) {
  return Array.from(fileList || []).some((file) => String(file?.type || '').startsWith('image/'))
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('参考图加载失败'))
    reader.readAsDataURL(file)
  })
}

async function appendFiles(fileList) {
  const remaining = Math.max(0, MAX_IMAGES - props.modelValue.length)
  if (!remaining) return

  const imageFiles = Array.from(fileList || [])
    .filter((file) => String(file?.type || '').startsWith('image/'))
    .slice(0, remaining)

  if (!imageFiles.length) return

  const nextImages = []
  for (const file of imageFiles) {
    try {
      const data = await readFileAsDataUrl(file)
      if (data) {
        nextImages.push({ id: nextId++, data })
      }
    } catch {
      // Ignore an individual bad file and continue with the rest.
    }
  }

  if (!nextImages.length) return

  emit('update:modelValue', [...props.modelValue, ...nextImages])
  isExpanded.value = true
}

async function handleFileUpload(event) {
  await appendFiles(event.target.files)
  event.target.value = ''
}

function handleDragEnter(event) {
  if (isAtLimit.value || !hasImageFiles(event.dataTransfer?.files)) return
  dragDepth.value += 1
  isDragOver.value = true
  isExpanded.value = true
}

function handleDragOver(event) {
  if (isAtLimit.value || !hasImageFiles(event.dataTransfer?.files)) return
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  isDragOver.value = true
}

function handleDragLeave() {
  if (dragDepth.value > 0) {
    dragDepth.value -= 1
  }
  if (dragDepth.value === 0) {
    isDragOver.value = false
  }
}

async function handleDrop(event) {
  dragDepth.value = 0
  isDragOver.value = false
  await appendFiles(event.dataTransfer?.files)
}

function addImageFromData(base64Data) {
  if (!base64Data || isAtLimit.value) return
  emit('update:modelValue', [...props.modelValue, { id: nextId++, data: base64Data }])
}

defineExpose({ addImageFromData })
</script>

<style scoped>
.ref-images {
  flex-shrink: 0;
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 12px;
  transition: min-height 0.18s ease;
}

.ref-images.expanded {
  min-height: 70px;
}

.ref-images.is-drag-over .ref-collapsed {
  background: rgba(59, 130, 246, 0.12);
  color: rgba(221, 234, 255, 0.95);
}

.ref-collapsed {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 12px;
  padding: 0 14px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
}

.ref-collapsed:hover {
  background: rgba(255, 255, 255, 0.05);
}

.ref-collapsed-text {
  font-size: 10px;
  line-height: 1;
  color: var(--c-t3, #666);
  font-weight: 500;
  white-space: nowrap;
}

.ref-caret {
  color: var(--c-t3, #666);
  transition: transform 0.2s;
}

.ref-row-expanded {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ref-side-label {
  position: absolute;
  right: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  line-height: 1.1;
  color: var(--c-t3, #666);
  font-weight: 500;
  white-space: nowrap;
}

.ref-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 260px;
  padding: 3px 5px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.ref-box:hover {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.045);
}

.ref-box.is-drag-over {
  border-color: rgba(88, 150, 255, 0.75);
  background: rgba(52, 120, 255, 0.12);
  box-shadow: 0 0 0 1px rgba(88, 150, 255, 0.16);
}

.ref-cards {
  display: flex;
  gap: 10px;
  align-items: center;
  cursor: default;
}

.ref-side-tools {
  position: absolute;
  left: calc(100% + 12px);
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ref-side-hint {
  color: var(--c-t3, #666);
  font-size: 10px;
  line-height: 1.1;
  white-space: nowrap;
}

.ref-side-count {
  font-size: 9px;
  line-height: 1.1;
  color: var(--c-t3, #555);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ref-card {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--c-surface, #222);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.ref-card:hover {
  border-color: rgba(255, 255, 255, 0.2);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.ref-preview {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  background: #1a1a1a;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 3px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

.ref-preview-img {
  display: block;
  max-width: 180px;
  max-height: 140px;
  width: auto;
  height: auto;
  border-radius: 4px;
  object-fit: contain;
}

.preview-pop-enter-active {
  transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.preview-pop-leave-active {
  transition: all 0.1s ease;
}

.preview-pop-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(4px) scale(0.9);
}

.preview-pop-leave-to {
  opacity: 0;
  transform: translateX(-50%) scale(0.95);
}

.ref-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ref-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  background: rgba(0, 0, 0, 0.75);
  border: none;
  border-radius: 50%;
  color: #bbb;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.ref-card:hover .ref-remove {
  opacity: 1;
}

.ref-remove:hover {
  background: rgba(244, 67, 54, 0.85);
  color: #fff;
}

.ref-add-card {
  width: 64px;
  height: 64px;
  border-radius: 7px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  position: relative;
  transition: all 0.15s;
  flex-shrink: 0;
  background: transparent;
  color: inherit;
  padding: 0;
}

.ref-add-card:hover {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.04);
}

.ref-drop-indicator {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px dashed rgba(112, 166, 255, 0.72);
  background: rgba(44, 96, 186, 0.12);
  color: rgba(221, 234, 255, 0.95);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  pointer-events: none;
  z-index: 5;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
