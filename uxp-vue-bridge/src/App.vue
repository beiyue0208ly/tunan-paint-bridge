<template>
  <div class="app">
    <SettingsPanel
      v-model:visible="showSettings"
      :active-tab="settingsActiveTab"
      :settings="settingsSnapshot"
      :connection-phase="connectionPhase"
      :actual-connection-endpoint-text="activeConnectionEndpointText"
      :detected-instances="detectedComfyInstances"
      :inactive-instances="inactiveDetectedComfyInstances"
      :shutting-down-instance-ids="shuttingDownInstanceIds"
      :frontend-target-options="frontendTargetOptions"
      :is-connected="isConnected"
      :is-connecting="isConnecting"
      :is-scanning-instances="isScanningComfyInstances"
      :connection-error="connectionError"
      :connection-status-text="connectionStatusText"
      :instance-scan-status-text="instanceScanStatusText"
      :selected-frontend-target="selectedFrontendTarget"
      :api-model-options="apiModelOptions"
      :api-models-loading="apiModelsLoading"
      :api-models-error="apiModelsError"
      :can-clear-result-history="hasAnyResultHistory"
      @clear-result-history="clearResultHistoryCache"
      @connect="handleConnect"
      @control-target-change="handleControlTargetChange"
      @disconnect="handleDisconnect"
      @scan-instances="handleScanInstances"
      @shutdown-instance="handleShutdownInstance"
      @fetch-api-models="fetchApiModels"
      @reset-api-models="clearApiModelListState"
      @mode-change="appMode = $event"
      @settings-change="handleSettingsChange"
    />

    <PromptPanel
      v-if="appMode === 'comfyui'"
      v-model:visible="showPromptPanel"
      v-model:positive="positivePrompt"
      v-model:negative="negativePrompt"
      v-model:steps="stepsValue"
      v-model:cfg="cfgScale"
      v-model:seed="seedValue"
      :is-linked="isConnected"
    />
    <WorkflowBrowser
      v-if="appMode === 'comfyui'"
      v-model:visible="showWorkflowBrowser"
      :items="savedWorkflows"
      @select="handleWorkflowLoad"
    />

    <section class="preview" :class="{ 'api-preview': appMode === 'api', 'api-preview-collapsed': appMode === 'api' && !referencePanelExpanded }">
      <div class="preview-topbar">
        <button
          v-if="appMode === 'comfyui'"
          class="floating-status floating-status-button"
          :class="`is-${connectionBadgePhase}`"
          :title="connectionActionTitle"
          @pointerdown.stop.prevent="handleConnectionBadgePointerDown"
          @click.stop.prevent="handleConnectionBadgeClickEvent"
        >
          <span
            class="conn-dot"
            :class="{
              live: connectionBadgePhase === 'connected',
              waiting: connectionBadgePhase === 'waiting' || connectionBadgePhase === 'connecting',
              failed: connectionBadgePhase === 'failed',
            }"
          ></span>
          <span class="conn-text">{{ connectionBadgeText }}</span>
        </button>
        <button
          v-else
          class="floating-status floating-status-button"
          :class="`is-${apiBadgePhase}`"
          :title="apiBadgeTitle"
          @click.stop.prevent="handleApiBadgeClick"
        >
          <span
            class="conn-dot"
            :class="{
              live: apiBadgePhase === 'connected',
              waiting: apiBadgePhase === 'waiting',
              failed: apiBadgePhase === 'failed',
            }"
          ></span>
          <span class="conn-text">{{ apiBadgeText }}</span>
        </button>

        <div
          v-if="appMode === 'comfyui' && showExecutionProgress"
          class="floating-progress"
          :class="[`is-${executionProgressStage}`, { 'is-indeterminate': isExecutionProgressIndeterminate }]"
        >
          <div class="floating-progress-track">
            <div
              v-if="!isExecutionProgressIndeterminate"
              class="floating-progress-fill"
              :style="{ width: `${executionProgressPercent}%` }"
            ></div>
            <div v-else class="floating-progress-preparing">
              <div class="floating-progress-preparing-sheen"></div>
            </div>
          </div>
          <span class="floating-progress-text">{{ executionProgressText }}</span>
        </div>
        <div
          v-else-if="appMode === 'api' && isApiTaskBusy"
          class="floating-progress is-indeterminate"
        >
          <div class="floating-progress-track">
            <div class="floating-progress-preparing">
              <div class="floating-progress-preparing-sheen"></div>
            </div>
          </div>
          <span class="floating-progress-text">{{ apiTaskHintText }}</span>
        </div>
        <div v-else class="floating-progress-spacer"></div>

        <button class="floating-settings" title="设置" @click.stop="openSettingsPanel()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
        </button>
      </div>

      <div v-if="!mainImage" class="preview-empty">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" class="preview-svg">
          <rect x="4" y="4" width="28" height="28" rx="2" stroke="currentColor" stroke-width="0.7" />
          <circle cx="13" cy="13" r="2.5" stroke="currentColor" stroke-width="0.7" />
          <path d="M4 26L12 18L19 25L24 20L32 26" stroke="currentColor" stroke-width="0.7" />
        </svg>
        <span class="preview-text">等待生成</span>
      </div>
      <InteractivePreview v-else :src="mainImage" class="preview-stage" @activate="sendToPS" />
    </section>

    <div v-if="appMode === 'comfyui'" class="param-row" :class="{ 'is-unlinked': !effectiveDenoiseLinked }">
      <label class="p-label">降噪</label>
      <div class="slider-wrap">
        <div class="slider-track">
          <div class="slider-fill" :class="{ 'is-linked': effectiveDenoiseLinked }" :style="{ width: denoiseVisualPosition }"></div>
        </div>
        <input type="range" class="slider-input" min="0" max="1000" step="1" :value="denoiseInt" @input="onDenoise" />
        <div class="slider-knob" :class="{ 'is-linked': effectiveDenoiseLinked }" :style="{ left: denoiseVisualPosition }"></div>
      </div>
      <span class="p-val">{{ denoiseDisplay }}</span>
    </div>

    <HistoryDock
      :history-items="historyItems"
      :active-slot="activeSlot"
      :bottom="appMode === 'api' ? apiHistoryBottom : '93px'"
      @select="handleHistoryDockSelect"
      @clear-active="clearHistoryActiveSlot"
    />

    <!-- API 模式：参考图区占位，不与其他区域重叠 -->
    <div v-if="appMode === 'api'" class="ref-overlay">
      <ReferenceImages v-model="referenceImages" v-model:expanded="referencePanelExpanded" />
    </div>

    <div v-if="taskErrorMessage" class="task-error-banner" :class="{ 'is-api': appMode === 'api' }">
      {{ taskErrorMessage }}
    </div>

    <!-- ComfyUI 模式底部栏 -->
    <div v-if="appMode === 'comfyui'" class="floating-bar">
      <button class="fb-btn fb-workflow-launch" @click="openWorkflowBrowser">工作流</button>

      <div class="fb-dropdown-wrap" ref="dropdownRef">
        <div class="fb-dropdown-trigger" :class="{ open: dropdownOpen, 'is-unlinked': !isConnected }" :title="isConnected ? currentWorkflow : '未同步'" @click="toggleDropdown">
          <span v-if="currentWorkflowModified" class="fb-status-dot unsaved"></span>
          <span class="fb-dropdown-text">{{ isConnected ? currentWorkflow : '未同步' }}</span>
          <svg v-if="isConnected" class="fb-caret" :class="{ open: dropdownOpen }" viewBox="0 0 8 5" width="7" height="4">
            <path d="M.5.5 4 4 7.5.5" stroke="currentColor" fill="none" stroke-width="1.2" />
          </svg>
        </div>

        <div class="fb-dropdown-menu" v-show="dropdownOpen && isConnected">
          <div
            v-for="wf in openedWorkflowTabs"
            :key="wf.id || wf.name"
            class="fb-dropdown-item"
            :class="{ selected: wf.id === currentWorkflowId }"
            @click="selectWorkflow(wf)"
          >
            <span v-if="wf.isModified" class="fb-status-dot unsaved"></span>
            <span class="fb-dropdown-item-text">{{ wf.name }}</span>
          </div>
        </div>
      </div>

      <div
        class="fb-action-split"
        :class="{ 'is-executing': isPrimaryActionBusy }"
        ref="actionMenuRef"
      >
        <button
          class="fb-btn fb-run-action"
          :class="[
            isPrimaryActionBusy ? 'fb-stop' : 'fb-primary',
            { 'fb-live-ready': isRealtimeArmed },
          ]"
          :disabled="!isPrimaryActionBusy && isPrimaryActionDisabled"
          :title="primaryActionDisplayTitle"
          @click="handleRunPrimaryAction"
        >
          <span
            class="fb-action-icon"
            :class="{
              'is-run': !isPrimaryActionBusy,
              'is-stop': isPrimaryActionBusy,
            }"
          >
            <svg v-if="!isPrimaryActionBusy" width="7" height="9" viewBox="0 0 7 9" fill="currentColor"><path d="M0 0v9l7-4.5z" /></svg>
            <StopSpinner v-else />
          </span>
          <span class="fb-action-label">{{ primaryActionDisplayLabel }}</span>
        </button>

        <button
          class="fb-btn fb-action-toggle"
          :class="{ open: actionMenuOpen }"
          :disabled="!canOpenActionMenu"
          title="运行菜单"
          @click.stop="toggleActionMenu"
        >
          <svg class="fb-split-caret" :class="{ open: actionMenuOpen }" viewBox="0 0 8 5" width="8" height="5">
            <path d="M.5.5 4 4 7.5.5" stroke="currentColor" fill="none" stroke-width="1.2" />
          </svg>
        </button>

        <div v-show="actionMenuOpen" class="fb-action-menu">
          <button
            class="fb-action-item"
            :disabled="!canSendOnly"
            @click="handleSendOnlyFromMenu"
          >
            仅发送图片
          </button>
          <button
            class="fb-action-item"
            :disabled="!canRunCurrentWorkflow"
            @click="handleRunOnlyFromMenu"
          >
            仅运行工作流
          </button>
          <button
            v-if="realtimeOn"
            class="fb-action-item"
            @click="handleDisableRealtimeFromMenu"
          >
            关闭实时
          </button>
        </div>
      </div>

      <button class="fb-btn fb-prompt-action" @click="showPromptPanel = !showPromptPanel">提示词</button>

      <div class="fb-toggle fb-realtime-toggle" @click="realtimeOn = !realtimeOn" :class="{ on: realtimeOn }">
        <div class="fb-toggle-track"><div class="fb-toggle-knob"></div></div>
        <span class="fb-toggle-text">实时</span>
      </div>
    </div>

    <!-- API 模式输入栏 -->
    <div v-else class="api-input-bar">
      <div
        class="api-canvas-toggle"
        :class="{ on: apiSendCanvas, disabled: isApiTaskBusy }"
        @click="!isApiTaskBusy && (apiSendCanvas = !apiSendCanvas)"
        :title="apiSendCanvas ? '✅ 开启：发送时会附带 PS 当前画布图像' : '❌ 关闭：仅发送描述文字和参考图'"
      >
        <div class="api-toggle-track"><div class="api-toggle-knob"></div></div>
        <span class="api-toggle-label">画布</span>
      </div>
      <textarea
        ref="apiPromptInputRef"
        v-model="apiPrompt"
        class="api-prompt-input"
        :class="{ 'is-busy': isApiTaskBusy }"
        :placeholder="isApiTaskBusy ? '正在处理当前请求...' : '描述你想要生成的图像... (Ctrl+Enter 发送)'"
        rows="1"
        :disabled="isApiTaskBusy"
        @keydown.ctrl.enter.prevent="sendApiRequest"
        @input="autoResizeTextarea"
      ></textarea>
      <button
        class="api-send-btn"
        :class="{ 'is-busy': isApiTaskBusy }"
        @click="isApiTaskBusy ? stopTask() : sendApiRequest()"
        :disabled="!isApiTaskBusy && !canSendApi"
        :title="isApiTaskBusy ? '停止当前请求' : '发送 (Ctrl+Enter)'"
      >
        <template v-if="isApiTaskBusy">
          <StopSpinner />
          <span class="api-send-btn-label">停止</span>
        </template>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import HistoryDock from './components/HistoryDock.vue'
import InteractivePreview from './components/InteractivePreview.vue'
import PromptPanel from './components/PromptPanel.vue'
import ReferenceImages from './components/ReferenceImages.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StopSpinner from './components/StopSpinner.vue'
import WorkflowBrowser from './components/WorkflowBrowser.vue'
import { useBridgeApp } from './composables/useBridgeApp'
import { useFocusGuard } from './composables/useFocusGuard'

const {
  activeSlot,
  activeConnectionEndpointText,
  apiBadgePhase,
  apiBadgeText,
  apiBadgeTitle,
  apiHistoryBottom,
  apiModelOptions,
  apiModelsError,
  apiModelsLoading,
  apiPrompt,
  apiSendCanvas,
  apiTaskHintText,
  appMode,
  actionMenuOpen,
  actionMenuRef,
  autoResizeTextarea,
  canOpenActionMenu,
  executionProgressPercent,
  executionProgressStage,
  executionProgressText,
  showExecutionProgress,
  connectionActionTitle,
  connectionBadgeText,
  connectionBadgePhase,
  canRunCurrentWorkflow,
  canSendOnly,
  currentWorkflowModified,
  currentWorkflow,
  currentWorkflowId,
  connectionError,
  connectionPhase,
  connectionStatusText,
  detectedComfyInstances,
  inactiveDetectedComfyInstances,
  taskErrorMessage,
  cfgScale,
  denoiseDisplay,
  denoiseInt,
  denoiseValue,
  denoiseVisualPosition,
  dropdownOpen,
  dropdownRef,
  effectiveDenoiseLinked,
  clearApiModelListState,
  fetchApiModels,
  handleConnect,
  handleApiBadgeClick,
  handleConnectionBadgeClickEvent,
  handleConnectionBadgePointerDown,
  handleControlTargetChange,
  handleDisconnect,
  handleScanInstances,
  handleShutdownInstance,
  handleSettingsChange,
  handleDisableRealtimeFromMenu,
  handleRunFromMenu,
  handleRunOnlyFromMenu,
  handleRunPrimaryAction,
  handleSendOnlyFromMenu,
  handleWorkflowLoad,
  hasAnyResultHistory,
  frontendTargetOptions,
  historyItems,
  isConnected,
  isApiTaskBusy,
  isConnecting,
  isScanningComfyInstances,
  isExecutionProgressIndeterminate,
  isExecutionRunning,
  isPrimaryActionBusy,
  isPrimaryActionDisabled,
  isRealtimeArmed,
  shuttingDownInstanceIds,
  isTaskRunning,
  isTaskPending,
  mainImage,
  mainMeta,
  negativePrompt,
  onDenoise,
  openedWorkflowTabs,
  openWorkflowBrowser,
  primaryActionDisplayLabel,
  primaryActionDisplayTitle,
  positivePrompt,
  realtimeOn,
  realtimeActionMode,
  referenceImages,
  referencePanelExpanded,
  runWorkflow,
  savedWorkflows,
  selectHistoryItem,
  selectWorkflow,
  selectedFrontendTarget,
  sendApiRequest,
  sendToPS,
  seedValue,
  settingsSnapshot,
  settingsActiveTab,
  showPromptPanel,
  showSettings,
  showWorkflowBrowser,
  stepsValue,
  stopTask,
  clearResultHistoryCache,
  openSettingsPanel,
  toggleActionMenu,
  toggleDropdown,
  workflows,
  instanceScanStatusText,
} = useBridgeApp()
const canSendApi = computed(() => !isApiTaskBusy.value && Boolean(apiPrompt.value.trim()))

useFocusGuard()

function handleHistoryDockSelect(item) {
  selectHistoryItem(item)
}

function clearHistoryActiveSlot() {
  activeSlot.value = null
}

</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 500px;
  min-height: 760px;
  padding: 8px 8px 0;
  gap: 5px;
  position: relative;
  cursor: default;
  overflow: hidden;
}

button,
select,
input[type='range'],
.fb-toggle,
.fb-toggle *,
.floating-settings,
.floating-settings * {
  cursor: pointer !important;
}

.preview {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin-bottom: 8px;
  background: var(--c-canvas);
  border: 1px solid var(--c-border);
  border-radius: var(--r);
  overflow: hidden;
  cursor: default;
  transition: border-color 0.2s;
}

.preview:hover {
  border-color: var(--c-border-h);
}

.preview.api-preview {
  align-items: flex-end;
  margin-bottom: 2px;
  padding: 0 10px 212px;
}

.preview.api-preview.api-preview-collapsed {
  margin-bottom: -4px;
  padding: 0 10px 198px;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 1;
  cursor: default;
}

.preview-svg {
  color: var(--c-t3);
  opacity: 0.35;
  cursor: default;
}

.preview-text {
  font-size: 11px;
  color: var(--c-t3);
  letter-spacing: 2px;
  font-weight: 300;
  cursor: default;
}

.preview-stage {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.preview-swap-enter-active,
.preview-swap-leave-active {
  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.preview-swap-enter-from,
.preview-swap-leave-to {
  opacity: 0;
  transform: scale(0.985);
}

.preview.api-preview .preview-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  margin-bottom: 0;
  text-align: center;
}

.preview-topbar {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.preview-topbar > * {
  pointer-events: auto;
}

.floating-status,
.floating-settings {
  position: absolute;
  top: 8px;
  z-index: 10;
  display: flex;
  align-items: center;
  background: rgba(20, 20, 20, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.preview-topbar .floating-status,
.preview-topbar .floating-settings {
  position: static;
  top: auto;
  left: auto;
  right: auto;
}

.floating-status {
  left: 8px;
  height: 24px;
  padding: 0 10px;
  border-radius: 12px;
  gap: 6px;
}

.floating-status-button {
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: background 0.2s ease, border-color 0.2s ease, opacity 0.2s ease;
}

.floating-status-button,
.floating-status-button * {
  cursor: pointer !important;
}

.floating-status-button:hover {
  background: rgba(34, 34, 34, 0.82);
  border-color: rgba(255, 255, 255, 0.14);
}

.floating-status-button.is-connected {
  border-color: rgba(56, 200, 118, 0.22);
}

.floating-status-button.is-connecting,
.floating-status-button.is-waiting {
  border-color: rgba(96, 150, 255, 0.24);
}

.floating-status-button.is-failed {
  border-color: rgba(224, 108, 117, 0.24);
}

.conn-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--c-t3);
  transition: all 0.4s;
}

.conn-dot.live {
  background: var(--c-green);
  box-shadow: 0 0 8px var(--c-green-glow), 0 0 2px var(--c-green);
}

.conn-dot.waiting {
  background: #5f9cff;
  box-shadow: 0 0 8px rgba(95, 156, 255, 0.45);
}

.conn-dot.failed {
  background: #d97278;
  box-shadow: 0 0 8px rgba(217, 114, 120, 0.4);
}

.conn-text {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.85);
  font-weight: 500;
}

.floating-progress {
  min-width: 0;
  flex: 1;
  height: 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 9px;
  background: rgba(20, 20, 20, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.floating-progress-spacer {
  flex: 1;
  min-width: 0;
  height: 26px;
}

.floating-progress-track {
  position: relative;
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.floating-progress-fill {
  position: relative;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(92, 158, 255, 0.92), rgba(72, 201, 176, 0.92));
  box-shadow: 0 0 10px rgba(92, 158, 255, 0.28);
  transition: width 0.42s cubic-bezier(0.22, 1, 0.36, 1);
}

.floating-progress.is-complete .floating-progress-fill {
  transition-duration: 0.28s;
}

.floating-progress-preparing {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background:
    linear-gradient(90deg, rgba(92, 158, 255, 0.04), rgba(72, 201, 176, 0.07), rgba(92, 158, 255, 0.04));
}

.floating-progress-preparing-sheen {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 34%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    rgba(92, 158, 255, 0),
    rgba(92, 158, 255, 0.18),
    rgba(72, 201, 176, 0.32),
    rgba(92, 158, 255, 0)
  );
  filter: blur(1px);
  animation: floating-progress-sheen 1.55s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

.floating-progress-text {
  flex-shrink: 0;
  min-width: 58px;
  text-align: right;
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  font-variant-numeric: tabular-nums;
}

@keyframes floating-progress-sheen {
  0% {
    transform: translateX(-115%);
  }
  100% {
    transform: translateX(235%);
  }
}

.floating-settings {
  right: 8px;
  width: 26px;
  height: 26px;
  padding: 0;
  justify-content: center;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.82);
  background: rgba(20, 20, 20, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.floating-settings:hover {
  background: rgba(34, 34, 34, 0.9);
  color: rgba(255, 255, 255, 0.96);
  border-color: rgba(255, 255, 255, 0.2);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.param-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 20px;
  flex-shrink: 0;
  transition: all 0.3s ease;
}

.p-label {
  font-size: 10px;
  color: var(--c-t2);
  font-weight: 500;
  min-width: 22px;
}

.slider-wrap {
  flex: 1;
  position: relative;
  height: 14px;
  display: flex;
  align-items: center;
  --slider-knob-size: 10px;
}

.slider-track {
  width: 100%;
  height: 2px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 1px;
  overflow: hidden;
}

.slider-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--c-blue), var(--c-blue-h));
  border-radius: 1px;
  transition: background 0.18s ease, box-shadow 0.18s ease;
}

.slider-fill.is-linked {
  background: linear-gradient(90deg, #3975f2, #5eb1ff);
  box-shadow: 0 0 8px rgba(57, 117, 242, 0.8);
}

.slider-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
  margin: 0;
}

.slider-input::-webkit-slider-runnable-track {
  height: 14px;
  background: transparent;
}

.slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--slider-knob-size);
  height: var(--slider-knob-size);
  background: transparent;
  border-radius: 2px;
  border: none;
  box-shadow: none;
  cursor: pointer;
  transition: none;
}

.slider-knob {
  position: absolute;
  top: 50%;
  width: var(--slider-knob-size);
  height: var(--slider-knob-size);
  left: 0;
  transform: translate(-50%, -50%);
  background: var(--c-t1);
  border-radius: 2px;
  box-shadow: 0 0 0 2px var(--c-bg), 0 1px 3px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  transition: background 0.18s ease, box-shadow 0.18s ease;
}

.slider-knob.is-linked {
  background: #5eb1ff;
  box-shadow: 0 0 0 2px var(--c-bg), 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 8px rgba(57, 117, 242, 0.45);
  animation: slider-knob-breathe 3.2s ease-in-out infinite;
}

@keyframes slider-knob-breathe {
  0%, 100% {
    transform: translate(-50%, -50%) scale(1);
    box-shadow: 0 0 0 2px var(--c-bg), 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 8px rgba(57, 117, 242, 0.28);
  }
  50% {
    transform: translate(-50%, -50%) scale(1.08);
    box-shadow: 0 0 0 2px var(--c-bg), 0 1px 3px rgba(0, 0, 0, 0.5), 0 0 12px rgba(57, 117, 242, 0.46);
  }
}

.p-val {
  font-size: 11px;
  color: var(--c-blue);
  font-weight: 600;
  min-width: 28px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.param-row.is-unlinked {
  opacity: 0.5;
  filter: grayscale(1);
}

.param-row.is-unlinked:hover {
  opacity: 0.9;
}

.param-row.is-unlinked .slider-fill {
  background: rgba(255, 255, 255, 0.4);
}

.param-row.is-unlinked .p-val {
  color: var(--c-t2);
}

.task-error-banner {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 94px;
  z-index: 19;
  padding: 8px 10px;
  border: 1px solid rgba(214, 72, 72, 0.45);
  border-radius: 8px;
  background: rgba(56, 20, 20, 0.92);
  color: #ffd0d0;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
}

.task-error-banner.is-api {
  background: rgba(88, 36, 40, 0.72);
  border-color: rgba(232, 126, 134, 0.42);
}

/* --- API 模式主图限制在 3/4 高度 --- */
.floating-bar {
  position: relative;
  z-index: 30;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 48px;
  margin: 6px 14px 10px;
  min-width: 0;
  padding: 0 8px;
  background: rgba(30, 30, 30, 0.75);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  box-shadow: 0 -2px 16px rgba(0, 0, 0, 0.35), 0 0 1px rgba(255, 255, 255, 0.05);
  overflow: visible;
}

.fb-btn {
  height: 30px;
  padding: 0 10px;
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-t2);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  transition:
    background 0.22s ease,
    border-color 0.22s ease,
    color 0.22s ease,
    box-shadow 0.22s ease,
    transform 0.22s ease,
    opacity 0.22s ease;
}

.fb-run-action,
.fb-run-action *,
.fb-action-toggle,
.fb-action-toggle *,
.fb-dropdown-trigger,
.fb-dropdown-trigger *,
.fb-workflow-launch,
.fb-workflow-launch *,
.fb-prompt-action,
.fb-prompt-action * {
  cursor: pointer !important;
}

.fb-btn:disabled,
.fb-btn:disabled * {
  cursor: not-allowed !important;
}

.fb-dropdown-trigger.is-unlinked,
.fb-dropdown-trigger.is-unlinked * {
  cursor: not-allowed !important;
}

.fb-workflow-launch {
  flex: 0 0 56px;
}

.fb-action-split {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 0;
  flex: 0 0 auto;
}

.fb-btn:hover {
  color: var(--c-t1);
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--c-border-h);
}

.fb-btn:active {
  background: rgba(255, 255, 255, 0.08);
}

.fb-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: transparent;
  color: var(--c-t3);
  border-color: var(--c-border);
  box-shadow: none;
}

.fb-btn:disabled:hover {
  background: transparent;
  color: var(--c-t3);
  border-color: var(--c-border);
}

.fb-primary {
  background: var(--c-blue);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
  padding: 0 16px;
  box-shadow: 0 1px 4px rgba(45, 127, 249, 0.2);
}

.fb-primary:hover {
  background: var(--c-blue-h);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 2px 8px rgba(45, 127, 249, 0.3);
}

.fb-primary:active {
  background: #2570e0;
  box-shadow: none;
}

.fb-stop {
  background: linear-gradient(180deg, rgba(109, 38, 38, 0.96), rgba(88, 28, 28, 0.96));
  border-color: rgba(234, 105, 105, 0.26);
  color: #fff5f4;
  font-weight: 600;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 6px 16px rgba(50, 10, 10, 0.18);
}

.fb-stop:hover {
  background: linear-gradient(180deg, rgba(122, 42, 42, 0.98), rgba(96, 30, 30, 0.98));
  border-color: rgba(242, 126, 126, 0.34);
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 8px 18px rgba(60, 12, 12, 0.22);
  transform: translateY(-1px);
}

.fb-stop:active {
  background: linear-gradient(180deg, rgba(98, 34, 34, 0.98), rgba(76, 24, 24, 0.98));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 4px 12px rgba(60, 12, 12, 0.18);
  transform: translateY(0) scale(0.985);
}

.fb-action-icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 16px;
  border-radius: 999px;
}

.fb-action-icon.is-run {
  width: auto;
  height: auto;
  border-radius: 0;
}

.fb-action-icon.is-pending {
  color: currentColor;
}

.fb-action-icon.is-stop {
  width: 16px;
  height: 16px;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.fb-action-label {
  min-width: 0;
}

.fb-action-split .fb-run-action {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  min-width: 88px;
  position: relative;
}

.fb-action-split .fb-run-action.fb-live-ready::after {
  content: '';
  position: absolute;
  top: 5px;
  right: 7px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #48a8ff;
  box-shadow: 0 0 8px rgba(72, 168, 255, 0.45);
  animation: fb-live-dot-pulse 1.8s ease-in-out infinite;
}

.fb-action-split .fb-run-action.fb-live-ready:disabled {
  opacity: 1;
  color: #bcd8ff;
  background: rgba(45, 127, 249, 0.12);
  border-color: rgba(45, 127, 249, 0.3);
  box-shadow: inset 0 0 0 1px rgba(45, 127, 249, 0.08);
}

.fb-action-split .fb-run-action.fb-live-ready:disabled:hover {
  color: #bcd8ff;
  background: rgba(45, 127, 249, 0.12);
  border-color: rgba(45, 127, 249, 0.3);
}

.fb-action-toggle {
  width: 26px;
  min-width: 26px;
  padding: 0;
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  justify-content: center;
}

.fb-action-toggle.open {
  color: var(--c-t1);
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--c-border-h);
}

.fb-action-toggle.fb-stop,
.fb-action-toggle.fb-pending,
.fb-action-toggle.fb-primary {
  background: transparent;
  color: inherit;
  box-shadow: none;
}

.fb-split-caret {
  transition: transform 0.18s ease;
}

.fb-split-caret.open {
  transform: rotate(180deg);
}

.fb-action-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 170px;
  padding: 4px;
  background: #2a2a2a;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  z-index: 110;
}

.fb-action-item {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--c-t2);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
}

.fb-action-item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--c-t1);
}

.fb-action-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.fb-dropdown-wrap {
  flex: 1 1 132px;
  min-width: 112px;
  position: relative;
}

.fb-dropdown-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 28px 0 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  cursor: pointer;
  position: relative;
  transition: all 0.3s ease;
}

.fb-dropdown-trigger.is-unlinked {
  opacity: 0.5;
  cursor: not-allowed;
  border-style: dashed;
  border-color: rgba(255, 255, 255, 0.2);
}

.fb-dropdown-trigger.open {
  border-color: var(--c-blue);
  background: rgba(255, 255, 255, 0.06);
}

.fb-dropdown-trigger:hover:not(.open) {
  border-color: var(--c-border-h);
  background: rgba(255, 255, 255, 0.06);
}

.fb-dropdown-text {
  flex: 1;
  font-size: 11px;
  color: var(--c-t1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fb-caret {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--c-t3);
  transition: transform 0.2s;
}

.fb-caret.open {
  transform: translateY(-50%) rotate(180deg);
}

.fb-dropdown-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: #2a2a2a;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  padding: 3px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  z-index: 100;
}

.fb-dropdown-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--c-t2);
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fb-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.fb-status-dot.unsaved {
  background: #e9b35d;
  box-shadow: 0 0 6px rgba(233, 179, 93, 0.35);
}

.fb-dropdown-item-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fb-dropdown-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--c-t1);
}

.fb-dropdown-item.selected {
  color: var(--c-blue);
  font-weight: 600;
}

.fb-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  flex: 0 0 64px;
  height: 30px;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  transition: all 0.15s;
  overflow: hidden;
}

.fb-prompt-action {
  flex: 0 0 58px;
}

.fb-realtime-toggle {
  min-width: 70px;
  gap: 6px;
  padding: 0 9px;
}

.fb-toggle:hover {
  border-color: var(--c-border-h);
  background: rgba(255, 255, 255, 0.06);
}

.fb-toggle.on {
  border-color: var(--c-blue);
  background: rgba(45, 127, 249, 0.08);
}

.fb-toggle-track {
  width: 28px;
  height: 16px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  position: relative;
  transition: all 0.25s;
  overflow: hidden;
  flex: 0 0 auto;
}

.fb-toggle.on .fb-toggle-track {
  background: var(--c-blue-glow);
}

.fb-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: var(--c-t3);
  border-radius: 50%;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.fb-toggle.on .fb-toggle-knob {
  left: 14px;
  background: var(--c-blue);
  box-shadow: 0 0 8px rgba(72, 168, 255, 0.35);
}

.fb-toggle-text {
  font-size: 10px;
  color: var(--c-t3);
  font-weight: 500;
  transition: color 0.2s;
  white-space: nowrap;
  flex-shrink: 0;
}

.fb-toggle.on .fb-toggle-text {
  color: var(--c-blue);
}

@keyframes fb-live-dot-pulse {
  0%, 100% {
    transform: scale(1);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.12);
    opacity: 1;
  }
}

/* --- API 模式底部区 --- */
.ref-overlay {
  position: relative;
  z-index: 22;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  margin: 10px 0 0;
  pointer-events: auto;
}

.api-input-bar {
  position: relative;
  z-index: 30;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: auto;
  margin: 6px 14px 10px;
  padding: 8px 10px;
  background: rgba(30, 30, 30, 0.75);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  box-shadow: 0 -2px 16px rgba(0, 0, 0, 0.35), 0 0 1px rgba(255, 255, 255, 0.05);
}

.api-prompt-input {
  flex: 1;
  min-height: 28px;
  max-height: 80px;
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-t1);
  font-family: inherit;
  font-size: 11px;
  line-height: 1.4;
  resize: none;
  outline: none;
  overflow-y: auto;
  transition: border-color 0.2s;
}

.api-prompt-input:focus {
  border-color: var(--c-blue);
  background: rgba(255, 255, 255, 0.06);
}

.api-prompt-input.is-busy {
  opacity: 0.72;
}

.api-prompt-input::placeholder {
  color: var(--c-t3);
}

.api-send-btn {
  flex-shrink: 0;
  min-width: 38px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  background: var(--c-blue);
  border: none;
  border-radius: 5px;
  color: #fff;
  cursor: pointer;
  transition: box-shadow 0.16s ease, transform 0.12s ease, opacity 0.16s ease;
  box-shadow: 0 1px 4px rgba(45, 127, 249, 0.2);
}

.api-send-btn,
.api-send-btn * {
  cursor: pointer;
}

.api-send-btn-label,
.api-send-btn svg,
.api-send-btn :deep(.stop-spinner) {
  user-select: none;
  pointer-events: none;
  cursor: inherit;
}

.api-send-btn.is-busy {
  min-width: 82px;
  background: linear-gradient(135deg, #2d7ff9, #1d5fbd);
  box-shadow: 0 1px 6px rgba(45, 127, 249, 0.22);
}

.api-send-btn-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.api-send-btn:hover:not(:disabled) {
  background: var(--c-blue-h);
  box-shadow: 0 2px 8px rgba(45, 127, 249, 0.3);
}

.api-send-btn.is-busy:hover:not(:disabled) {
  background: linear-gradient(135deg, #2d7ff9, #1d5fbd);
  box-shadow: 0 2px 9px rgba(45, 127, 249, 0.28);
  filter: brightness(1.03);
}

/* --- 画布开关 --- */
.api-canvas-toggle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 3px 4px;
  border-radius: 4px;
  transition: background 0.15s;
}

.api-canvas-toggle:hover {
  background: rgba(255, 255, 255, 0.05);
}

.api-canvas-toggle.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.api-toggle-track {
  width: 28px;
  height: 14px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  position: relative;
  transition: all 0.25s;
}

.api-canvas-toggle.on .api-toggle-track {
  background: rgba(45, 127, 249, 0.25);
}

.api-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  background: var(--c-t3);
  border-radius: 50%;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.api-canvas-toggle.on .api-toggle-knob {
  left: 16px;
  background: var(--c-blue);
  box-shadow: 0 0 6px rgba(45, 127, 249, 0.4);
}

.api-toggle-label {
  font-size: 9px;
  color: var(--c-t3);
  font-weight: 500;
  line-height: 1;
  transition: color 0.2s;
  letter-spacing: 0.5px;
}

.api-canvas-toggle.on .api-toggle-label {
  color: var(--c-blue);
}

.api-send-btn:active:not(:disabled) {
  background: #2570e0;
}

.api-send-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

</style>
