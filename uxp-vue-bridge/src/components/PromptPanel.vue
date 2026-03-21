<template>
  <Transition name="slide-up">
    <div v-if="visible" class="prompt-panel-overlay" @click.self="close">
      <div class="prompt-panel">
        <div class="panel-header">
          <div class="title">提示词模板 Prompts</div>
          <button class="close-btn" @click="close">&times;</button>
        </div>

        <div class="template-bar" :class="{ 'is-unlinked': !props.isLinked }">
          <div class="custom-dropdown" ref="dropdownRef">
            <button class="dropdown-header" @click="toggleDropdown">
              <span>{{ currentTemplateName }}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                :class="{ rotated: isDropdownOpen }"
              >
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>

            <Transition name="fade">
              <ul v-if="isDropdownOpen" class="dropdown-list">
                <li @click="chooseTemplate('')" :class="{ active: selectedTemplate === '' }">
                  选择快捷预设...
                </li>
                <li
                  v-for="(tpl, idx) in templates"
                  :key="tpl.name + idx"
                  @click="chooseTemplate(idx)"
                  :class="{ active: selectedTemplate === idx }"
                >
                  {{ tpl.name }}
                </li>
              </ul>
            </Transition>
          </div>

          <div class="template-actions">
            <button class="action-btn icon-btn margin-r" @click="showSaveDialog = true" title="保存当前预设">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
              </svg>
            </button>
            <button
              class="action-btn icon-btn danger"
              :disabled="selectedTemplate === ''"
              @click="deleteTemplate"
              title="删除当前预设"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>

        <div class="panel-body" :class="{ 'is-unlinked': !props.isLinked }">
          <div class="prompt-group positive-group">
            <div class="prompt-header">
              <label>正面提示词 (Positive)</label>
              <button class="clear-btn" @click="positive = ''">清空</button>
            </div>
            <textarea
              v-model="positive"
              class="prompt-input positive"
              placeholder="描述画面: 1girl, cyberpunk..."
            ></textarea>
          </div>

          <div class="prompt-group negative-group mt-3">
            <div class="prompt-header">
              <label>负面提示词 (Negative)</label>
              <button class="clear-btn" @click="negative = ''">清空</button>
            </div>
            <textarea
              v-model="negative"
              class="prompt-input negative"
              placeholder="排除元素: ugly, blurry..."
            ></textarea>
          </div>

          <div class="quick-params">
            <div class="param-item">
              <label>步数 (Steps)</label>
              <div class="param-control">
                <input type="range" v-model="steps" min="1" max="100" class="mini-slider" />
                <input type="number" v-model.number="steps" class="mini-number" />
              </div>
            </div>

            <div class="param-item">
              <label>引导 (CFG)</label>
              <div class="param-control">
                <input type="range" v-model="cfg" min="1" max="30" step="0.5" class="mini-slider" />
                <input type="number" v-model.number="cfg" class="mini-number" step="0.5" />
              </div>
            </div>

            <div class="param-item">
              <label>种子 (Seed)</label>
              <div class="seed-control">
                <input type="number" v-model.number="seed" class="mini-number seed-input" />
                <button class="random-btn" @click="seed = -1">-1</button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="showSaveDialog" class="save-dialog-overlay" @click.self="showSaveDialog = false">
          <div class="save-dialog">
            <h4>保存当前预设</h4>
            <input v-model="newTemplateName" type="text" placeholder="输入预设名称..." class="save-input" />
            <div class="save-actions">
              <button class="save-btn btn-cancel" @click="showSaveDialog = false">取消</button>
              <button class="save-btn btn-confirm" @click="saveTemplate">保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  isLinked: { type: Boolean, default: false },
  positive: { type: String, default: '' },
  negative: { type: String, default: 'ugly, blurry, deformed, bad anatomy, watermark, text' },
  steps: { type: Number, default: 20 },
  cfg: { type: Number, default: 7.0 },
  seed: { type: Number, default: -1 },
})

const emit = defineEmits([
  'update:visible',
  'update:positive',
  'update:negative',
  'update:steps',
  'update:cfg',
  'update:seed',
])

const positive = computed({
  get: () => props.positive ?? '',
  set: (value) => emit('update:positive', value),
})

const negative = computed({
  get: () => props.negative ?? 'ugly, blurry, deformed, bad anatomy, watermark, text',
  set: (value) => emit('update:negative', value),
})

const steps = computed({
  get: () => props.steps ?? 20,
  set: (value) => emit('update:steps', Number(value ?? 20)),
})

const cfg = computed({
  get: () => props.cfg ?? 7.0,
  set: (value) => emit('update:cfg', Number(value ?? 7)),
})

const seed = computed({
  get: () => props.seed ?? -1,
  set: (value) => emit('update:seed', Number(value ?? -1)),
})

const templates = ref([
  { name: '默认人像', pos: '1girl, masterpiece, best quality, ultra-detailed', neg: 'ugly, blurry, deformed', steps: 25, cfg: 7.0 },
  { name: '风景插画', pos: 'scenery, mountain, sunset, beautiful lighting', neg: 'lowres, bad lighting', steps: 20, cfg: 6.5 },
])

const selectedTemplate = ref('')
const isDropdownOpen = ref(false)
const showSaveDialog = ref(false)
const newTemplateName = ref('')
const dropdownRef = ref(null)

const currentTemplateName = computed(() => {
  if (selectedTemplate.value === '' || selectedTemplate.value == null) return '选择快捷预设'
  return templates.value[selectedTemplate.value]?.name || '选择快捷预设'
})

function toggleDropdown() {
  isDropdownOpen.value = !isDropdownOpen.value
}

function chooseTemplate(idx) {
  selectedTemplate.value = idx
  isDropdownOpen.value = false
  applyTemplate()
}

function close() {
  emit('update:visible', false)
  isDropdownOpen.value = false
}

function handleClickOutside(event) {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target)) {
    isDropdownOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)

  const savedTpl = localStorage.getItem('comfyps_prompt_templates')
  if (!savedTpl) return

  try {
    const parsed = JSON.parse(savedTpl)
    if (Array.isArray(parsed) && parsed.length) {
      templates.value = parsed
    }
  } catch {}
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})

watch(
  templates,
  (newVal) => {
    localStorage.setItem('comfyps_prompt_templates', JSON.stringify(newVal))
  },
  { deep: true }
)

function applyTemplate() {
  if (selectedTemplate.value === '') return
  const tpl = templates.value[selectedTemplate.value]
  if (!tpl) return

  if (tpl.pos) positive.value = tpl.pos
  if (tpl.neg) negative.value = tpl.neg
  if (tpl.steps) steps.value = tpl.steps
  if (tpl.cfg) cfg.value = tpl.cfg
}

function saveTemplate() {
  const name = newTemplateName.value.trim()
  if (!name) return

  templates.value.push({
    name,
    pos: positive.value,
    neg: negative.value,
    steps: steps.value,
    cfg: cfg.value,
  })

  selectedTemplate.value = templates.value.length - 1
  newTemplateName.value = ''
  showSaveDialog.value = false
}

function deleteTemplate() {
  if (selectedTemplate.value === '') return
  templates.value.splice(selectedTemplate.value, 1)
  selectedTemplate.value = ''
}
</script>

<style scoped>
.prompt-panel-overlay {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 64px;
  left: 0;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 0 14px 0 0;
  pointer-events: auto;
}

.prompt-panel {
  pointer-events: auto;
  width: 65%;
  min-width: 280px;
  max-width: 450px;
  margin-bottom: 2px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(36, 36, 36, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.5);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.title {
  font-size: 12px;
  font-weight: 600;
  color: #f3f3f3;
}

.close-btn {
  border: none;
  background: transparent;
  color: #aaa;
  font-size: 18px;
  cursor: pointer;
}

.close-btn:hover {
  color: #fff;
}

.template-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.template-bar.is-unlinked,
.panel-body.is-unlinked {
  opacity: 0.5;
  filter: grayscale(1);
}

.custom-dropdown {
  position: relative;
  flex: 1;
}

.dropdown-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: #e9e9e9;
  font-size: 12px;
  cursor: pointer;
}

.dropdown-header:hover {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
}

.dropdown-header svg {
  transition: transform 0.2s ease;
}

.dropdown-header svg.rotated {
  transform: rotate(180deg);
}

.dropdown-list {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  max-height: 220px;
  margin: 0;
  padding: 6px;
  overflow: auto;
  list-style: none;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(28, 28, 28, 0.98);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  z-index: 5;
}

.dropdown-list li {
  padding: 8px 10px;
  border-radius: 6px;
  color: #ddd;
  font-size: 12px;
  cursor: pointer;
}

.dropdown-list li:hover,
.dropdown-list li.active {
  background: rgba(82, 139, 255, 0.16);
  color: #fff;
}

.template-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #d6d6d6;
  cursor: pointer;
}

.action-btn:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.action-btn.danger:hover:not(:disabled) {
  border-color: rgba(255, 98, 98, 0.35);
  color: #ff8f8f;
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
}

.prompt-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(0, 0, 0, 0.15);
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.04);
  transition: all 0.2s ease;
}

.prompt-group:hover {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.2);
}

.prompt-group:focus-within {
  background: rgba(0, 0, 0, 0.25);
}

.prompt-group.positive-group:focus-within {
  border-color: rgba(74, 222, 128, 0.4);
  box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.15), 0 4px 12px rgba(74, 222, 128, 0.05);
}

.prompt-group.negative-group:focus-within {
  border-color: rgba(248, 113, 113, 0.4);
  box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.15), 0 4px 12px rgba(248, 113, 113, 0.05);
}

.prompt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.prompt-group.positive-group .prompt-header label {
  color: #4ade80;
}

.prompt-group.negative-group .prompt-header label {
  color: #f87171;
}

.prompt-header label,
.param-item label {
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.prompt-group.positive-group .prompt-header label::before {
  content: "";
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4ade80;
  box-shadow: 0 0 4px #4ade80;
}

.prompt-group.negative-group .prompt-header label::before {
  content: "";
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f87171;
  box-shadow: 0 0 4px #f87171;
}

.clear-btn,
.random-btn {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #cfcfcf;
  cursor: pointer;
}

.clear-btn {
  padding: 4px 8px;
  font-size: 10px;
}

.clear-btn:hover,
.random-btn:hover {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
}

.prompt-input,
.mini-number,
.save-input {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #f1f1f1;
}

.prompt-input {
  min-height: 90px;
  padding: 8px 0 0 0;
  border: none;
  background: transparent;
  resize: none;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
}

.prompt-input:focus,
.mini-number:focus,
.save-input:focus {
  outline: none;
}

.prompt-input::placeholder {
  color: rgba(255, 255, 255, 0.2);
}

.prompt-input::-webkit-scrollbar {
  width: 6px;
}
.prompt-input::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 4px;
}

.mini-number:focus,
.save-input:focus {
  border-color: rgba(82, 139, 255, 0.45);
  box-shadow: 0 0 0 1px rgba(82, 139, 255, 0.2);
}

.quick-params {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.param-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.param-control,
.seed-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini-slider {
  flex: 1;
}

.mini-number {
  width: 72px;
  padding: 6px 8px;
  font-size: 11px;
}

.seed-input {
  flex: 1;
}

.random-btn {
  min-width: 44px;
  padding: 6px 10px;
  font-size: 11px;
}

.save-dialog-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.38);
}

.save-dialog {
  width: 260px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(28, 28, 28, 0.98);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}

.save-dialog h4 {
  margin: 0 0 12px;
  color: #f2f2f2;
  font-size: 13px;
}

.save-input {
  padding: 8px 10px;
  font-size: 12px;
}

.save-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.save-btn {
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
}

.btn-cancel {
  background: transparent;
  color: #aaa;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.btn-cancel:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.btn-confirm {
  background: var(--c-blue, #528bff);
  color: #fff;
}

.btn-confirm:hover {
  background: #3975f2;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.25s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
