<template>
  <div v-if="visible" class="settings-overlay" @click.self="close">
    <div class="settings-panel">
      <div class="settings-header">
        <h3>设置 Settings</h3>
        <button class="close-btn" @click="close">&times;</button>
      </div>

      <div class="mode-switch-section">
        <div class="mode-switch-group">
          <button
            class="mode-btn"
            :class="{ active: localSettings.appMode === 'comfyui' }"
            @click="localSettings.appMode = 'comfyui'"
          >
            ComfyUI
          </button>
          <button
            class="mode-btn"
            :class="{ active: localSettings.appMode === 'api' }"
            @click="localSettings.appMode = 'api'"
          >
            API
          </button>
        </div>
      </div>

      <div class="settings-tabs">
        <button class="tab-button" :class="{ active: currentTab === 'connection' }" @click="currentTab = 'connection'">连接</button>
        <button class="tab-button" :class="{ active: currentTab === 'layer' }" @click="currentTab = 'layer'">图层</button>
        <button class="tab-button" :class="{ active: currentTab === 'document' }" @click="currentTab = 'document'">文档</button>
        <button class="tab-button" :class="{ active: currentTab === 'interface' }" @click="currentTab = 'interface'">界面</button>
        <button class="tab-button" :class="{ active: currentTab === 'diagnostic' }" @click="currentTab = 'diagnostic'">诊断</button>
      </div>

      <div class="focus-recovery-note">
        若切回插件后输入无响应，请先点击面板标题栏，再回到当前输入框。
      </div>

      <div class="settings-content">
        <div v-show="currentTab === 'connection'" class="tab-pane">
          <template v-if="localSettings.appMode === 'comfyui'">
            <div class="setting-group">
              <label>主机地址 (Host)</label>
              <input v-model="localSettings.host" type="text" class="input-base" placeholder="例如 127.0.0.1" />
            </div>

            <div class="setting-group">
              <label>端口 (Port)</label>
              <input
                :value="portInput"
                type="text"
                inputmode="numeric"
                class="input-base"
                placeholder="8188"
                @input="handlePortInput"
                @blur="commitPortInput"
                @keydown.enter.prevent="commitPortInput"
                @click.stop
                @keydown.stop
              />
            </div>

            <div class="setting-group">
              <div class="setting-row-head">
                <label>本机实例</label>
                <button class="inline-action-btn" :disabled="props.isScanningInstances" @click="triggerInstanceScan">
                  {{ props.isScanningInstances ? '扫描中...' : '扫描本机' }}
                </button>
              </div>
              <div class="help-text">自动连接只会选择有活动前端的实例。下面的后台残留不会参与自动连接，但可以手动关闭。</div>
              <div v-if="props.instanceScanStatusText" class="scan-status-text">{{ props.instanceScanStatusText }}</div>
              <div v-if="props.detectedInstances.length" class="instance-section-title">活动中的 ComfyUI</div>
              <div v-if="props.detectedInstances.length" class="detected-instance-list">
                <button
                  v-for="instance in props.detectedInstances"
                  :key="instance.id || `${instance.host}:${instance.port}`"
                  class="detected-instance-item"
                  :class="{ selected: isDetectedInstanceSelected(instance), connected: isDetectedInstanceConnected(instance) }"
                  @click="connectDetectedInstance(instance)"
                >
                  <div class="detected-instance-main">
                    <span class="detected-instance-endpoint">{{ instance.host }}:{{ instance.port }}</span>
                    <span v-if="instance.bridgeVersion" class="detected-instance-version">v{{ instance.bridgeVersion }}</span>
                    <span class="detected-instance-subline">{{ instance.frontendLabel || '活动前端' }}</span>
                  </div>
                  <div class="detected-instance-badges">
                    <span class="instance-pill" :class="{ active: instance.hasActiveFrontend }">
                      {{ instance.hasActiveFrontend ? '活动前端' : '无前端' }}
                    </span>
                    <span v-if="isDetectedInstanceConnected(instance)" class="instance-pill connected">当前已连</span>
                    <span v-else-if="isDetectedInstanceSelected(instance)" class="instance-pill selected">准备连接</span>
                  </div>
                </button>
              </div>
              <div v-else-if="!props.inactiveInstances.length" class="muted-box compact-muted">
                还没发现活动中的 ComfyUI 前端。
              </div>
              <div v-if="props.inactiveInstances.length" class="instance-section-title">后台残留</div>
              <div v-if="props.inactiveInstances.length" class="inactive-instance-list">
                <div
                  v-for="instance in props.inactiveInstances"
                  :key="`inactive_${instance.id || `${instance.host}:${instance.port}`}`"
                  class="inactive-instance-item"
                  :class="{ connected: isDetectedInstanceConnected(instance) }"
                >
                  <div class="detected-instance-main">
                    <span class="detected-instance-endpoint">{{ instance.host }}:{{ instance.port }}</span>
                    <span v-if="instance.bridgeVersion" class="detected-instance-version">v{{ instance.bridgeVersion }}</span>
                    <span class="detected-instance-subline">{{ instance.frontendLabel || '无活动前端' }}</span>
                  </div>
                  <div class="detected-instance-badges">
                    <span class="instance-pill inactive">后台残留</span>
                    <span v-if="isDetectedInstanceConnected(instance)" class="instance-pill connected">当前已连</span>
                    <button
                      class="inline-action-btn danger compact"
                      :disabled="isDetectedInstanceShuttingDown(instance)"
                      @click.stop="shutdownInactiveInstance(instance)"
                    >
                      {{ isDetectedInstanceShuttingDown(instance) ? '关闭中...' : '关闭后端' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="setting-group checkbox-group">
              <input id="autoConnect" v-model="localSettings.autoConnect" type="checkbox" />
              <label for="autoConnect">启动时自动连接</label>
            </div>

            <div class="setting-group">
              <label>实时模式间隔 (秒)</label>
              <input
                :value="realtimeDebounceInput"
                type="text"
                inputmode="numeric"
                class="input-base"
                placeholder="2 - 60"
                @input="handleRealtimeDebounceInput"
                @blur="commitRealtimeDebounceInput"
                @keydown.enter.prevent="commitRealtimeDebounceInput"
                @click.stop
                @keydown.stop
              />
              <div class="help-text">实时模式下，两次自动发送之间的最短等待时间。</div>
            </div>

            <div class="setting-group">
              <label>实时模式灵敏度</label>
              <div class="sensitivity-control">
                <CustomSlider
                  v-model="localSettings.realtimeSensitivity"
                  :min="1"
                  :max="10"
                  :step="1"
                  :positions="realtimeSensitivityPositions"
                  :show-ticks="true"
                  :labeled-ticks="[1, 5, 10]"
                />
                <div class="sensitivity-labels">
                  <span>更稳定</span>
                  <span class="sensitivity-value">{{ localSettings.realtimeSensitivity }} 级</span>
                  <span>更灵敏</span>
                </div>
              </div>
            </div>

            <div class="setting-group">
              <label>实时模式动作</label>
              <CustomSelect v-model="localSettings.realtimeAction" :options="realtimeActionOptions" />
              <div class="help-text">决定实时模式触发时，是直接运行工作流，还是只发送到桥接器。</div>
            </div>

            <div class="connection-status">
              <span>状态：</span>
              <span :class="['status-text', isConnected ? 'connected' : 'disconnected']">
                {{ connectionStatusText }}
              </span>
            </div>

            <div v-if="props.actualConnectionEndpointText" class="connection-meta-text">
              当前实际连接：{{ props.actualConnectionEndpointText }}
            </div>

            <div class="setting-group">
              <label>控制端</label>
              <CustomSelect v-model="localSettings.controlFrontendTarget" :options="frontendTargetOptions" />
              <div class="help-text">选择当前由插件控制的 ComfyUI 前端。</div>
            </div>

            <div v-if="connectionError" class="connection-error">{{ connectionError }}</div>

            <div class="button-group">
              <button class="btn" :class="settingsConnectionButtonClass" @click="handleConnectionAction">
                {{ settingsConnectionButtonText }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="info-box">API 模式只保留卡片。Key、地址、模型都放进新建 / 编辑卡片弹层里，外层只负责切换。</div>

            <div class="api-toolbar">
              <div class="section-title">API 卡片</div>
              <button class="inline-action-btn" @click="openCreateApiProfileModal">新建卡片</button>
            </div>

            <div v-if="apiProfiles.length" class="api-card-list">
              <div
                v-for="profile in apiProfiles"
                :key="profile.id"
                class="api-card"
                :class="{ active: profile.id === localSettings.activeApiProfileId }"
                @click="activateApiProfile(profile.id)"
              >
                <div class="api-card-head">
                  <div>
                    <div class="api-card-title-row">
                      <span class="api-card-title">{{ profile.name }}</span>
                      <span v-if="profile.id === localSettings.activeApiProfileId" class="api-badge">当前</span>
                    </div>
                    <div class="api-card-meta">{{ getApiProviderLabel(profile.providerType) }}</div>
                  </div>

                  <div class="api-card-actions">
                    <button class="ghost-btn" @click.stop="openEditApiProfileModal(profile.id)">编辑</button>
                    <button class="ghost-btn danger" @click.stop="deleteApiProfile(profile.id)">删除</button>
                  </div>
                </div>

                <div class="api-card-url">{{ summarizeApiBaseUrl(profile.baseUrl) }}</div>

                <div class="api-card-model">
                  <div class="api-card-model-head">
                    <span>当前模型</span>
                    <span>{{ getSavedModelCount(profile) }} 个已保存</span>
                  </div>

                  <CustomSelect
                    v-if="getProfileModelOptions(profile).length"
                    :model-value="profile.activeModel"
                    :options="getProfileModelOptions(profile)"
                    @update:model-value="switchApiProfileModel(profile.id, $event)"
                    @click.stop
                  />
                  <div v-else class="muted-box">这张卡还没有模型，点编辑后先拉取并加入。</div>
                </div>
              </div>
            </div>

            <div v-else class="empty-box">
              <div class="empty-title">这里先保持空白</div>
              <div>先新建一张卡片，再在弹层里填写 API 地址、Key，并选择模型。</div>
            </div>
          </template>
        </div>

        <div v-show="currentTab === 'layer'" class="tab-pane">
          <div class="info-box">
            发送模式决定从 Photoshop 取哪一部分内容发送给外部引擎。
          </div>

          <div class="setting-group">
            <label>图层获取模式</label>
            <CustomSelect v-model="localSettings.captureMode" :options="captureModeOptions" />
          </div>

          <div v-if="localSettings.captureMode === 'current'" class="setting-group">
            <label>当前图层范围</label>
            <CustomSelect v-model="localSettings.layerBoundaryMode" :options="layerBoundaryOptions" />
            <div class="help-text">
              只发图层内容：只发送当前图层真正有内容的部分。<br />
              按整张画布：保持和当前画布一样大，其余区域透明。
            </div>
          </div>

          <div class="setting-group">
            <label>发送格式</label>
            <CustomSelect v-model="localSettings.imageFormat" :options="imageFormatOptions" />
            <div class="help-text">PNG 支持透明度，JPEG 文件更小。</div>
          </div>

          <div v-if="localSettings.imageFormat === 'jpg'" class="setting-group">
            <label>JPEG 质量 (1 - 100)</label>
            <input
              :value="jpegQualityInput"
              type="text"
              inputmode="numeric"
              class="input-base"
              placeholder="1 - 100"
              @input="handleJpegQualityInput"
              @blur="commitJpegQualityInput"
              @keydown.enter.prevent="commitJpegQualityInput"
              @click.stop
              @keydown.stop
            />
          </div>

          <div class="setting-group checkbox-group">
            <input id="useSelection" v-model="localSettings.useSelection" type="checkbox" />
            <label for="useSelection">智能选区</label>
          </div>

          <div v-if="localSettings.useSelection" class="setting-group">
            <label>选区发送方式</label>
            <CustomSelect v-model="localSettings.selectionSendMode" :options="selectionSendModeOptions" />
            <div class="help-text">
              矩形范围：更适合局部精修。<br />
              按选区形状：只发送选中的形状区域。
            </div>
          </div>

          <div v-if="localSettings.useSelection && localSettings.selectionSendMode === 'rect'" class="setting-group">
            <label>选区扩展</label>
            <CustomSelect v-model="selectionExpandPreset" :options="selectionExpandPresetOptions" />
            <input
              v-if="selectionExpandPreset === CUSTOM_SELECTION_EXPAND"
              :value="selectionExpandInput"
              type="text"
              inputmode="numeric"
              class="input-base custom-expand-input"
              placeholder="0 - 2048"
              @input="handleSelectionExpandInput"
              @blur="commitSelectionExpandInput"
              @keydown.enter.prevent="commitSelectionExpandInput"
              @click.stop
              @keydown.stop
            />
            <div class="help-text">只在矩形范围模式下生效，用于给选区外围增加参考内容。</div>
          </div>
        </div>

        <div v-show="currentTab === 'document'" class="tab-pane">
          <div class="info-box">
            文档设置决定发送前的尺寸处理，以及双击结果回到 Photoshop 时的导入方式。
          </div>

          <div class="setting-subtitle">发送尺寸与约束</div>

          <div class="setting-group">
            <label>API 参考图尺寸限制</label>
            <CustomSelect v-model="localSettings.apiReferenceSizeLimit" :options="apiReferenceSizeLimitOptions" />
            <div class="help-text">仅在 API 模式发送参考图时生效，会和下方的目标尺寸、对齐方式一起决定缩放结果。</div>
          </div>

          <div class="setting-group">
            <label>目标尺寸</label>
            <CustomSelect v-model="localSettings.sizeLimit" :options="sizeLimitOptions" />
            <div class="help-text">用于发送到 ComfyUI，以及 API 模式开启“发送画布”时的尺寸处理。</div>
          </div>

          <div v-if="localSettings.sizeLimit === 'custom'" class="setting-group">
            <label>自定义尺寸 (px)</label>
            <input
              :value="customSizeInput"
              type="text"
              inputmode="numeric"
              class="input-base"
              placeholder="256 - 4096"
              @input="handleCustomSizeInput"
              @blur="commitCustomSizeInput"
              @keydown.enter.prevent="commitCustomSizeInput"
              @click.stop
              @keydown.stop
            />
          </div>

          <div class="setting-group">
            <label>对齐方式</label>
            <div class="toggle-button-group">
              <button class="toggle-btn" :class="{ active: localSettings.edgeControl === 'long' }" @click="localSettings.edgeControl = 'long'">
                按长边
              </button>
              <button class="toggle-btn" :class="{ active: localSettings.edgeControl === 'short' }" @click="localSettings.edgeControl = 'short'">
                按短边
              </button>
            </div>
            <div class="help-text">按长边时，最长的一边对齐到目标尺寸；按短边时，最短的一边对齐到目标尺寸。</div>
          </div>

          <div class="setting-subtitle">回贴到 Photoshop</div>

          <div class="setting-group">
            <label>双击主图时导入为</label>
            <CustomSelect v-model="localSettings.returnLayerType" :options="returnLayerTypeOptions" />
          </div>

          <div class="setting-group">
            <label>返回图层命名</label>
            <CustomSelect v-model="localSettings.returnLayerNaming" :options="returnLayerNamingOptions" />
          </div>
        </div>

        <div v-show="currentTab === 'interface'" class="tab-pane">
          <div class="setting-group checkbox-group">
            <input id="showNotifications" v-model="localSettings.showNotifications" type="checkbox" />
            <label for="showNotifications">显示通知</label>
          </div>

          <div class="setting-group">
            <label>通知显示时长 (秒)</label>
            <input
              v-model="notificationDurationInput"
              type="text"
              inputmode="numeric"
              class="input-base"
              placeholder="1 - 10"
              @input="handleNotificationDurationInput"
              @blur="commitNotificationDurationInput"
              @keydown.enter.prevent="commitNotificationDurationInput"
              @click.stop
              @keydown.stop
            />
          </div>

          <div class="setting-subtitle">历史缓存</div>

          <div class="setting-group">
            <div class="help-text">
              API 和 ComfyUI 各自缓存最近 11 张结果。关闭 Photoshop 后重新打开，主图和历史图会自动恢复。
            </div>
            <button class="cache-clear-btn" :disabled="!props.canClearResultHistory" @click="emit('clear-result-history')">
              一键清空历史缓存
            </button>
          </div>

          <div class="danger-zone">
            <button class="btn-reset-large" @click="restoreDefaults">恢复默认设置</button>
          </div>
        </div>

        <div v-show="currentTab === 'diagnostic'" class="tab-pane diagnostic-pane">
          <div class="info-box">
            这里会记录最近的连接、传输、报错和运行事件。以后别人电脑出问题时，让他打开这里，点“复制诊断日志”直接发给你就行。
          </div>

          <div class="diagnostic-toolbar">
            <div class="diagnostic-meta">
              最近 {{ props.diagnosticEntries.length }} 条事件
            </div>
            <div class="diagnostic-actions">
              <button class="inline-action-btn primary" :disabled="!props.diagnosticSummaryText" @click="copyDiagnosticLogs">
                {{ diagnosticCopyStatus || '复制诊断日志' }}
              </button>
              <button class="inline-action-btn danger compact" :disabled="!props.diagnosticEntries.length" @click="emit('clear-diagnostic-logs')">
                清空日志
              </button>
            </div>
          </div>

          <textarea
            class="diagnostic-textarea"
            :value="props.diagnosticSummaryText"
            readonly
            spellcheck="false"
            @click.stop
            @keydown.stop
          ></textarea>
        </div>
      </div>

      <div class="settings-footer">
        <div class="credit-elegant">
          <div class="credit-main">MADE BY <span>图南绘画工作室</span></div>
          <div class="credit-sub">约稿 QQ: 76030821 | V {{ appVersion }}</div>
        </div>
      </div>

      <div v-if="apiEditorVisible" class="api-editor-overlay" @click.self="closeApiProfileModal">
        <div class="api-editor-modal">
          <div class="api-editor-header">
            <div>
              <div class="api-editor-kicker">API 卡片</div>
              <h4>{{ apiEditorMode === 'create' ? '新建卡片' : '编辑卡片' }}</h4>
            </div>
            <button class="close-btn" @click="closeApiProfileModal">&times;</button>
          </div>

          <div class="api-editor-body">
            <div class="setting-group">
              <label>卡片名称</label>
              <input
                ref="apiEditorNameInputRef"
                v-model="apiDraft.name"
                type="text"
                class="input-base"
                placeholder="例如：云雾绘图 / 鑫源备用"
                @click.stop
                @keydown.stop
              />
            </div>

            <div class="setting-group">
              <label>接口类型</label>
              <CustomSelect v-model="apiDraft.providerType" :options="providerTypeOptions" />
            </div>

            <div class="setting-group">
              <label>API Key</label>
              <div class="inline-row">
                <input
                  v-model="apiDraft.apiKey"
                  :type="apiDraftShowKey ? 'text' : 'password'"
                  class="input-base grow"
                  placeholder="填入当前服务商的 API Key"
                  @click.stop
                  @keydown.stop
                />
                <button class="inline-action-btn" @click="apiDraftShowKey = !apiDraftShowKey">{{ apiDraftShowKey ? '隐藏' : '显示' }}</button>
              </div>
            </div>

            <div class="setting-group">
              <label>Base URL</label>
              <input
                v-model="apiDraft.baseUrl"
                type="text"
                class="input-base"
                placeholder="例如：https://yunwu.ai"
                @click.stop
                @keydown.stop
              />
              <div class="help-text">如果你填的是根地址，我们会自动补到 /v1。</div>
            </div>

            <div class="setting-group">
              <label>模型管理</label>
              <div class="inline-row">
                <button class="inline-action-btn primary" @click="handleFetchApiModels">拉取模型</button>
                <span v-if="props.apiModelsLoading" class="inline-status">正在读取模型列表...</span>
              </div>
              <div v-if="apiFetchValidationError" class="error-text">{{ apiFetchValidationError }}</div>
              <div v-else-if="props.apiModelsError" class="error-text">{{ props.apiModelsError }}</div>
            </div>

            <div v-if="props.apiModelOptions.length" class="section-block compact-block">
              <div class="section-title-row">
                <div class="section-title">可添加模型</div>
                <div class="model-count-text">
                  {{ filteredApiModelCount }} / {{ props.apiModelOptions.length }}
                </div>
              </div>
              <div class="model-filter-row">
                <input
                  v-model="apiModelSearchQuery"
                  type="text"
                  class="input-base grow"
                  placeholder="搜索模型名或公司，例如 flux / qwen / image"
                  @click.stop
                  @keydown.stop
                />
                <button class="inline-action-btn" @click="apiModelShowAll = !apiModelShowAll">
                  {{ apiModelShowAll ? '仅图片候选' : '显示全部' }}
                </button>
              </div>
              <div v-if="groupedApiModelOptions.length" class="model-group-list">
                <div v-for="group in groupedApiModelOptions" :key="group.key" class="model-group-block">
                  <div class="model-group-title">{{ group.label }} <span>{{ group.items.length }}</span></div>
                  <div class="model-list">
                    <button
                      v-for="option in group.items"
                      :key="option.value"
                      class="model-chip"
                      :class="{ added: isDraftModelSaved(option), recommended: option.isImageLikely }"
                      @click="toggleDraftSavedModel(option)"
                    >
                      <span class="model-chip-body">
                        <span class="model-chip-text">{{ option.label }}</span>
                        <span v-if="getApiModelEndpointBadges(option).length" class="model-chip-badges">
                          <span
                            v-for="badge in getApiModelEndpointBadges(option)"
                            :key="badge.key"
                            class="endpoint-badge"
                            :class="badge.className"
                          >
                            {{ badge.label }}
                          </span>
                        </span>
                      </span>
                      <span>{{ isDraftModelSaved(option) ? '已添加' : '+' }}</span>
                    </button>
                  </div>
                </div>
              </div>
              <div v-else class="muted-box">
                没有匹配的模型，试试搜索别的关键词，或点“显示全部”。
              </div>
            </div>

            <div class="setting-group">
              <label>手动添加模型</label>
              <div class="inline-row">
                <input
                  v-model="manualModelInput"
                  type="text"
                  class="input-base grow"
                  placeholder="例如：qwen-image-max / gpt-image-1 / flux-kontext"
                  @keydown.enter.prevent="addManualModel"
                  @click.stop
                  @keydown.stop
                />
                <button class="inline-action-btn" @click="addManualModel">添加</button>
              </div>
            </div>

            <div class="section-block compact-block">
              <div class="section-title">已保存模型</div>
              <div v-if="apiDraft.savedModels.length" class="saved-model-list">
                <div
                  v-for="model in apiDraft.savedModels"
                  :key="getSavedModelId(model)"
                  class="saved-model-row"
                  :class="{ active: getSavedModelId(model) === apiDraft.activeModel }"
                >
                  <button class="saved-model-main" @click="setDraftActiveModel(model)">
                    <span class="saved-model-info">
                      <span class="saved-model-name">{{ getSavedModelLabel(model) }}</span>
                      <span v-if="getApiModelEndpointBadges(model).length" class="saved-model-badges">
                        <span
                          v-for="badge in getApiModelEndpointBadges(model)"
                          :key="badge.key"
                          class="endpoint-badge"
                          :class="badge.className"
                        >
                          {{ badge.label }}
                        </span>
                      </span>
                    </span>
                    <span v-if="getSavedModelId(model) === apiDraft.activeModel" class="api-badge">当前</span>
                  </button>
                  <button class="saved-model-remove" @click="removeDraftModel(model)">移除</button>
                </div>
              </div>
              <div v-else class="muted-box">先拉取或手动添加至少一个模型。</div>
            </div>

            <div v-if="apiSaveError" class="error-text">{{ apiSaveError }}</div>
          </div>

          <div class="api-editor-footer">
            <button class="ghost-btn" @click="closeApiProfileModal">取消</button>
            <button class="primary-btn" @click="saveApiProfile">保存卡片</button>
          </div>
        </div>
      </div>

      <div v-if="showConfirmDialog" class="custom-confirm-overlay" @click.self="showConfirmDialog = false">
        <div class="custom-confirm-box">
          <div class="confirm-icon">!</div>
          <h4>恢复默认设置</h4>
          <p>这会把当前面板里的所有设置恢复到默认值。</p>
          <div class="confirm-buttons">
            <button class="btn-cancel" @click="showConfirmDialog = false">取消</button>
            <button class="btn-danger" @click="executeRestore">确认恢复</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  createApiProfileDraft,
  DEFAULT_SETTINGS,
  normalizeApiSavedModels,
  normalizeSettingsSnapshot,
  resolveApiSavedModelEndpointType,
  resolveApiSavedModelId,
  resolveApiSavedModelLabel,
} from '../core/settings/bridgeSettings'
import CustomSelect from './CustomSelect.vue'
import CustomSlider from './CustomSlider.vue'

const appVersion = __APP_VERSION__

const props = defineProps({
  visible: { type: Boolean, default: false },
  activeTab: { type: String, default: 'connection' },
  settings: { type: Object, default: () => ({}) },
  isConnected: { type: Boolean, default: false },
  isConnecting: { type: Boolean, default: false },
  connectionPhase: { type: String, default: 'disconnected' },
  connectionError: { type: String, default: '' },
  connectionStatusText: { type: String, default: '未连接' },
  actualConnectionEndpointText: { type: String, default: '' },
  detectedInstances: { type: Array, default: () => [] },
  inactiveInstances: { type: Array, default: () => [] },
  shuttingDownInstanceIds: { type: Array, default: () => [] },
  isScanningInstances: { type: Boolean, default: false },
  instanceScanStatusText: { type: String, default: '' },
  frontendTargetOptions: { type: Array, default: () => [] },
  selectedFrontendTarget: { type: String, default: '' },
  apiModelOptions: { type: Array, default: () => [] },
  apiModelsLoading: { type: Boolean, default: false },
  apiModelsError: { type: String, default: '' },
  diagnosticEntries: { type: Array, default: () => [] },
  diagnosticSummaryText: { type: String, default: '' },
  canClearResultHistory: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:visible',
  'connect',
  'disconnect',
  'scan-instances',
  'shutdown-instance',
  'fetch-api-models',
  'reset-api-models',
  'mode-change',
  'control-target-change',
  'settings-change',
  'clear-diagnostic-logs',
  'clear-result-history',
])

const CUSTOM_SELECTION_EXPAND = 'custom'
const realtimeSensitivityPositions = [0, 12.5, 25, 37.5, 50, 60, 70, 80, 90, 100]
const apiProviderOptions = [
  { label: 'OpenAI 兼容图片', value: 'openai' },
]
const providerTypeOptions = [
  { label: 'OpenAI兼容图片', value: 'openai' },
]
const captureModeOptions = [
  { label: '合并可见', value: 'merged' },
  { label: '仅当前图层', value: 'current' },
]
const layerBoundaryOptions = [
  { label: '只发图层内容', value: 'content' },
  { label: '按整张画布', value: 'document' },
]
const imageFormatOptions = [
  { label: 'PNG (推荐)', value: 'png' },
  { label: 'JPEG', value: 'jpg' },
]
const selectionSendModeOptions = [
  { label: '矩形范围（推荐）', value: 'rect' },
  { label: '按选区形状', value: 'shape' },
]
const selectionExpandPresetOptions = [
  { label: '0 像素', value: '0' },
  { label: '16 像素', value: '16' },
  { label: '32 像素', value: '32' },
  { label: '64 像素', value: '64' },
  { label: '128 像素', value: '128' },
  { label: '自定义', value: CUSTOM_SELECTION_EXPAND },
]
const sizeLimitOptions = [
  { label: '保持当前大小', value: 'original' },
  { label: '512px', value: '512' },
  { label: '768px', value: '768' },
  { label: '1024px', value: '1024' },
  { label: '1280px', value: '1280' },
  { label: '1536px', value: '1536' },
  { label: '2048px', value: '2048' },
  { label: '自定义', value: 'custom' },
]
const apiReferenceSizeLimitOptions = sizeLimitOptions.filter((option) => option.value !== 'custom')
const returnLayerTypeOptions = [
  { label: '智能对象（推荐）', value: 'smartObject' },
  { label: '普通图层', value: 'pixelLayer' },
]
const returnLayerNamingOptions = [
  { label: '沿用来源图层名（推荐）', value: 'source' },
  { label: '细化_编号', value: 'sequence' },
  { label: '细化_时间', value: 'time' },
]
const realtimeActionOptions = [
  { label: '实时运行（推荐）', value: 'run' },
  { label: '实时发送到桥接器', value: 'send' },
]

const currentTab = ref('connection')
const localSettings = ref(normalizeSettingsSnapshot(props.settings || {}))
const showApiKey = ref(false)
const showConfirmDialog = ref(false)
const syncingFromProps = ref(false)
const syncingFrontendTarget = ref(false)
const apiEditorVisible = ref(false)
const apiEditorMode = ref('create')
const apiDraft = reactive(createApiProfileDraft())
const apiDraftShowKey = ref(false)
const manualModelInput = ref('')
const apiEditorNameInputRef = ref(null)
const apiFetchValidationError = ref('')
const apiSaveError = ref('')
const apiModelSearchQuery = ref('')
const apiModelShowAll = ref(false)
const lastFocusedSettingsInputRef = ref(null)
const FOCUS_DEBUG = false
const selectionExpandPreset = ref('64')
const portInput = ref(String(DEFAULT_SETTINGS.port))
const realtimeDebounceInput = ref(String(DEFAULT_SETTINGS.realtimeDebounce))
const customSizeInput = ref(String(DEFAULT_SETTINGS.customSizeValue))
const selectionExpandInput = ref(String(DEFAULT_SETTINGS.selectionExpandPx))
const jpegQualityInput = ref(String(DEFAULT_SETTINGS.jpegQuality))
const notificationDurationInput = ref(String(DEFAULT_SETTINGS.notificationDuration))
const diagnosticCopyStatus = ref('')
let diagnosticCopyTimer = null

const settingsConnectionButtonText = computed(() => {
  if (props.isConnected) return '断开连接'
  if (props.connectionPhase === 'connecting') return '连接中...'
  if (props.connectionPhase === 'waiting') return '等待 ComfyUI'
  if (props.connectionPhase === 'failed') return '重新连接'
  return '连接'
})

const settingsConnectionButtonClass = computed(() => {
  if (props.isConnected || props.connectionPhase === 'connecting' || props.connectionPhase === 'waiting') {
    return 'danger'
  }
  return 'primary'
})

const apiProfiles = computed(() => Array.isArray(localSettings.value.apiProfiles) ? localSettings.value.apiProfiles : [])
function focusLog(stage, payload = {}) {
  if (!FOCUS_DEBUG) return
  try {
    console.log(`[FocusSettings] ${stage}`, payload)
  } catch {
    console.log(`[FocusSettings] ${stage}`)
  }
}

function normalizeModelSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b(image|images)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesModelSearch(option, keyword) {
  if (!keyword) return true

  const haystack = [
    option.label,
    option.value,
    option.group,
    option.groupLabel,
    option.owner,
    ...(Array.isArray(option.supportedEndpointTypes) ? option.supportedEndpointTypes : []),
    option.endpointType,
  ]
    .filter(Boolean)
    .join(' ')

  const normalizedKeyword = normalizeModelSearchText(keyword)
  const normalizedHaystack = normalizeModelSearchText(haystack)
  if (!normalizedKeyword) return true
  if (normalizedHaystack.includes(normalizedKeyword)) return true

  const queryTokens = normalizedKeyword.split(' ').filter(Boolean)
  if (queryTokens.length === 0) return true
  const haystackTokens = normalizedHaystack.split(' ').filter(Boolean)
  if (haystackTokens.length === 0) return false

  let cursor = 0
  for (const token of queryTokens) {
    const nextIndex = haystackTokens.findIndex((item, index) => index >= cursor && item.includes(token))
    if (nextIndex < 0) {
      return false
    }
    cursor = nextIndex + 1
  }

  return true
}

const filteredApiModelOptions = computed(() => {
  const keyword = String(apiModelSearchQuery.value || '').trim().toLowerCase()
  return (props.apiModelOptions || []).filter((option) => {
    if (!apiModelShowAll.value && !option.isImageLikely) {
      return false
    }

    if (!keyword) {
      return true
    }

    return matchesModelSearch(option, keyword)
  })
})

const filteredApiModelCount = computed(() => filteredApiModelOptions.value.length)

const groupedApiModelOptions = computed(() => {
  const groups = new Map()
  for (const option of filteredApiModelOptions.value) {
    const key = String(option.group || option.groupLabel || '未分类')
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: key,
        items: [],
      })
    }
    groups.get(key).items.push(option)
  }

  return [...groups.values()].sort((left, right) => {
    if (left.label === '未分类') return 1
    if (right.label === '未分类') return -1
    return left.label.localeCompare(right.label)
  })
})

const apiModelPlaceholder = computed(() => {
  return '例如：qwen-image-max、gpt-image-1、flux-kontext'
})

const apiModelHint = computed(() => {
  if (props.apiModelsLoading) {
    return '正在读取当前 Key 可用的模型列表...'
  }
  if (props.apiModelsError) {
    return props.apiModelsError
  }
  if (props.apiModelOptions.length > 0) {
    return '已读取模型列表，直接点击选择即可。'
  }
  return '支持云雾、鑫源等 OpenAI 兼容图片接口；也可以手动填写模型名。'
})

function syncSelectionExpandPreset(value) {
  const currentValue = Number(value)
  if ([0, 16, 32, 64, 128].includes(currentValue)) {
    selectionExpandPreset.value = String(currentValue)
    selectionExpandInput.value = String(currentValue)
    return
  }

  selectionExpandPreset.value = CUSTOM_SELECTION_EXPAND
  selectionExpandInput.value = String(value ?? DEFAULT_SETTINGS.selectionExpandPx)
}

function sanitizeNumericInput(value) {
  return String(value ?? '').replace(/[^\d]/g, '')
}

function handlePortInput(event) {
  portInput.value = sanitizeNumericInput(event.target.value)
}

function commitPortInput() {
  const nextValue = Number(portInput.value)
  const normalizedValue = Number.isFinite(nextValue) && nextValue > 0
    ? String(Math.min(65535, Math.max(1, Math.round(nextValue))))
    : String(DEFAULT_SETTINGS.port)

  localSettings.value.port = normalizedValue
  portInput.value = normalizedValue
}

function handleRealtimeDebounceInput(event) {
  realtimeDebounceInput.value = sanitizeNumericInput(event.target.value)
}

function commitRealtimeDebounceInput() {
  const nextValue = Number(realtimeDebounceInput.value)
  const normalizedValue = Number.isFinite(nextValue) && nextValue > 0
    ? Math.min(60, Math.max(2, Math.round(nextValue)))
    : DEFAULT_SETTINGS.realtimeDebounce

  localSettings.value.realtimeDebounce = normalizedValue
  realtimeDebounceInput.value = String(normalizedValue)
}

function handleCustomSizeInput(event) {
  customSizeInput.value = sanitizeNumericInput(event.target.value)
}

function commitCustomSizeInput() {
  const nextValue = Number(customSizeInput.value)
  const normalizedValue = Number.isFinite(nextValue) && nextValue > 0
    ? Math.min(4096, Math.max(256, Math.round(nextValue)))
    : DEFAULT_SETTINGS.customSizeValue

  localSettings.value.customSizeValue = normalizedValue
  customSizeInput.value = String(normalizedValue)
}

function handleSelectionExpandInput(event) {
  selectionExpandInput.value = sanitizeNumericInput(event.target.value)
}

function commitSelectionExpandInput() {
  const nextValue = Number(selectionExpandInput.value)
  const normalizedValue = Number.isFinite(nextValue) && nextValue >= 0
    ? Math.min(2048, Math.max(0, Math.round(nextValue)))
    : DEFAULT_SETTINGS.selectionExpandPx

  localSettings.value.selectionExpandPx = normalizedValue
  selectionExpandInput.value = String(normalizedValue)
}

function handleJpegQualityInput(event) {
  jpegQualityInput.value = sanitizeNumericInput(event.target.value)
}

function commitJpegQualityInput() {
  const nextValue = Number(jpegQualityInput.value)
  const normalizedValue = Number.isFinite(nextValue) && nextValue > 0
    ? Math.min(100, Math.max(1, Math.round(nextValue)))
    : DEFAULT_SETTINGS.jpegQuality

  localSettings.value.jpegQuality = normalizedValue
  jpegQualityInput.value = String(normalizedValue)
}

function handleNotificationDurationInput(event) {
  const rawValue = typeof event === 'string' ? event : event?.target?.value
  notificationDurationInput.value = sanitizeNumericInput(rawValue)
}

function commitNotificationDurationInput() {
  const nextValue = Number(notificationDurationInput.value)
  const normalizedValue = Number.isFinite(nextValue) && nextValue > 0
    ? Math.min(10, Math.max(1, Math.round(nextValue)))
    : DEFAULT_SETTINGS.notificationDuration

  localSettings.value.notificationDuration = normalizedValue
  notificationDurationInput.value = String(normalizedValue)
}

watch(
  () => localSettings.value.appMode,
  (newMode) => {
    emit('mode-change', newMode)
  },
)

watch(
  () => localSettings.value.selectionExpandPx,
  (nextValue) => {
    syncSelectionExpandPreset(nextValue)
  },
  { immediate: true },
)

watch(selectionExpandPreset, (nextValue) => {
  if (nextValue === CUSTOM_SELECTION_EXPAND) return
  localSettings.value.selectionExpandPx = Number(nextValue)
})

watch(
  () => localSettings.value.controlFrontendTarget,
  (newTarget, oldTarget) => {
    if (newTarget === oldTarget) return
    if (syncingFrontendTarget.value) return
    emit('control-target-change', newTarget)
  },
)

watch(
  () => props.selectedFrontendTarget,
  (nextTarget) => {
    if (localSettings.value.controlFrontendTarget === (nextTarget || '')) return
    syncingFrontendTarget.value = true
    localSettings.value.controlFrontendTarget = nextTarget || ''
    queueMicrotask(() => {
      syncingFrontendTarget.value = false
    })
  },
)

watch(
  () => props.activeTab,
  (nextTab) => {
    if (['connection', 'layer', 'document', 'interface', 'diagnostic'].includes(nextTab)) {
      currentTab.value = nextTab
    }
  },
  { immediate: true },
)

function syncInputMirrors() {
  portInput.value = String(localSettings.value.port)
  realtimeDebounceInput.value = String(localSettings.value.realtimeDebounce)
  customSizeInput.value = String(localSettings.value.customSizeValue)
  syncSelectionExpandPreset(localSettings.value.selectionExpandPx)
  jpegQualityInput.value = String(localSettings.value.jpegQuality)
  notificationDurationInput.value = String(localSettings.value.notificationDuration)
}

onMounted(() => {
  localSettings.value = normalizeSettingsSnapshot(props.settings || {})
  syncInputMirrors()
})

watch(
  () => props.settings,
  (nextSettings) => {
    syncingFromProps.value = true
    localSettings.value = normalizeSettingsSnapshot(nextSettings || {})
    syncInputMirrors()
    queueMicrotask(() => {
      syncingFromProps.value = false
    })
  },
  { deep: true, immediate: true },
)

watch(
  localSettings,
  (newVal) => {
    if (syncingFromProps.value) return
    emit('settings-change', normalizeSettingsSnapshot(JSON.parse(JSON.stringify(newVal))))
  },
  { deep: true },
)

function close() {
  focusLog('panel:close')
  lastFocusedSettingsInputRef.value = null
  emit('update:visible', false)
}

function setDiagnosticCopyStatus(message = '') {
  diagnosticCopyStatus.value = message
  if (diagnosticCopyTimer) {
    clearTimeout(diagnosticCopyTimer)
    diagnosticCopyTimer = null
  }
  if (!message) return
  diagnosticCopyTimer = setTimeout(() => {
    diagnosticCopyTimer = null
    diagnosticCopyStatus.value = ''
  }, 1800)
}

async function copyDiagnosticLogs() {
  const text = String(props.diagnosticSummaryText || '').trim()
  if (!text) return

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', 'readonly')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      textarea.style.pointerEvents = 'none'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setDiagnosticCopyStatus('已复制')
  } catch {
    setDiagnosticCopyStatus('复制失败')
  }
}

function isRestorableSettingsInput(target) {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'TEXTAREA') return true
  if (target.tagName !== 'INPUT') return false

  const type = String(target.getAttribute('type') || 'text').toLowerCase()
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type)
}

function focusSettingsInput(target) {
  if (!(target instanceof HTMLElement) || !target.isConnected) return
  if (!isRestorableSettingsInput(target)) return

  focusLog('input:focus', {
    name: target.getAttribute('name') || target.getAttribute('placeholder') || target.id || target.tagName,
  })
  target.focus({ preventScroll: true })
  if (typeof target.setSelectionRange === 'function') {
    const valueLength = typeof target.value === 'string' ? target.value.length : 0
    target.setSelectionRange(valueLength, valueLength)
  }
}

function scheduleSettingsInputFocus(target, source = 'unknown') {
  if (!isRestorableSettingsInput(target)) return

  const focusOnce = (stage) => {
    focusLog(`focus-retry:${source}:${stage}`, {
      target: target.getAttribute?.('name') || target.getAttribute?.('placeholder') || target.id || target.tagName,
    })
    focusSettingsInput(target)
  }

  focusOnce('immediate')
  requestAnimationFrame(() => focusOnce('raf'))
  setTimeout(() => focusOnce('24ms'), 24)
  setTimeout(() => focusOnce('96ms'), 96)
  setTimeout(() => focusOnce('220ms'), 220)
  setTimeout(() => focusOnce('420ms'), 420)
}

function handleSettingsPanelPointerDown(event) {
  const target = event?.target
  if (!isRestorableSettingsInput(target)) return

  const targetName = target.getAttribute?.('name') || target.getAttribute?.('placeholder') || target.id || target.tagName
  focusLog('input:pointerdown:local-focus', {
    target: targetName,
  })
  try {
    window.focus?.()
  } catch {
    // ignore window focus failures
  }
  sendToHost(HOST_MESSAGE_TYPES.FOCUS_WEBVIEW, {
    reason: 'settings-input-pointerdown',
    target: targetName,
  })
  lastFocusedSettingsInputRef.value = target
  scheduleSettingsInputFocus(target, 'pointerdown')
}

function handleSettingsPanelFocusIn(event) {
  const target = event?.target
  if (!isRestorableSettingsInput(target)) return
  focusLog('input:focusin', {
    name: target.getAttribute('name') || target.getAttribute('placeholder') || target.id || target.tagName,
  })
  lastFocusedSettingsInputRef.value = target
}

function handleSettingsPanelFocusOut(event) {
  const target = event?.target
  if (!isRestorableSettingsInput(target)) return
  focusLog('input:focusout', {
    name: target.getAttribute('name') || target.getAttribute('placeholder') || target.id || target.tagName,
  })
}

function resolveSettingsRestoreTarget() {
  const rememberedTarget = lastFocusedSettingsInputRef.value
  if (rememberedTarget && rememberedTarget.isConnected && isRestorableSettingsInput(rememberedTarget)) {
    return rememberedTarget
  }

  if (apiEditorVisible.value && apiEditorNameInputRef.value) {
    return apiEditorNameInputRef.value
  }

  return null
}

function restoreSettingsTextFocus() {
  const target = resolveSettingsRestoreTarget()
  if (!target) return

  focusLog('restore:begin', {
    apiEditorVisible: apiEditorVisible.value,
    target: target.getAttribute?.('name') || target.getAttribute?.('placeholder') || target.id || target.tagName,
  })
  nextTick(() => {
    focusLog('restore:nextTick')
    scheduleSettingsInputFocus(target, 'restore')
  })
}

function getApiProviderLabel(providerType) {
  return providerType === 'openai' ? 'OpenAI兼容图片' : providerType
}

function summarizeApiBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim()
  return normalized || '尚未填写 Base URL'
}

function getSavedModelId(model) {
  return resolveApiSavedModelId(model)
}

function getSavedModelLabel(model) {
  return resolveApiSavedModelLabel(model) || resolveApiSavedModelId(model)
}

function getApiModelEndpointBadges(model) {
  const rawTypes = Array.isArray(model?.supportedEndpointTypes)
    ? model.supportedEndpointTypes
    : [
        model?.endpointType ||
        model?.endpoint_type ||
        resolveApiSavedModelEndpointType(model) ||
        '',
      ]

  const uniqueTypes = [...new Set(rawTypes.map((item) => String(item || '').trim()).filter(Boolean))]

  return uniqueTypes.map((type) => {
    if (type === 'gemini') {
      return { key: type, label: 'Gemini', className: 'is-gemini' }
    }
    if (type === 'openai') {
      return { key: type, label: 'Chat', className: 'is-openai' }
    }
    if (type === 'image-generation') {
      return { key: type, label: '图片', className: 'is-image' }
    }
    return { key: type, label: type, className: 'is-default' }
  })
}

function createDraftSavedModel(option) {
  const id = resolveApiSavedModelId(option)
  if (!id) return null

  return {
    id,
    label: resolveApiSavedModelLabel(option) || id,
    owner: String(option?.owner || '').trim(),
    group: String(option?.group || '').trim(),
    groupLabel: String(option?.groupLabel || option?.group || '').trim(),
    score: Number(option?.score || 0),
    isImageLikely: option?.isImageLikely !== undefined ? Boolean(option.isImageLikely) : true,
    supportedEndpointTypes: Array.isArray(option?.supportedEndpointTypes)
      ? option.supportedEndpointTypes.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    endpointType: String(
      option?.endpointType ||
      option?.endpoint_type ||
      resolveApiSavedModelEndpointType(option) ||
      '',
    ).trim(),
  }
}

function getProfileModelOptions(profile) {
  const models = Array.isArray(profile?.savedModels) ? profile.savedModels : []
  return models
    .map((model) => {
      const id = getSavedModelId(model)
      if (!id) return null
      return {
        label: getSavedModelLabel(model),
        value: id,
      }
    })
    .filter(Boolean)
}

function getSavedModelCount(profile) {
  return Array.isArray(profile?.savedModels) ? profile.savedModels.length : 0
}

function switchApiProfileModel(profileId, model) {
  const profile = apiProfiles.value.find((item) => item.id === profileId)
  if (!profile) return
  const modelId = getSavedModelId(model) || String(model || '').trim()
  if (!modelId) return
  profile.activeModel = modelId
  profile.model = modelId
  profile.savedModels = normalizeApiSavedModels(profile.savedModels, modelId)
  activateApiProfile(profileId)
}

function activateApiProfile(profileId) {
  localSettings.value.activeApiProfileId = profileId
}

function resetApiDraft(profile = null) {
  const draft = createApiProfileDraft(profile || {})
  for (const [key, value] of Object.entries(draft)) {
    apiDraft[key] = Array.isArray(value) ? [...value] : value
  }
  if (!Array.isArray(apiDraft.savedModels)) apiDraft.savedModels = []
  manualModelInput.value = ''
  apiDraftShowKey.value = false
  apiFetchValidationError.value = ''
  apiSaveError.value = ''
  apiModelSearchQuery.value = ''
  apiModelShowAll.value = false
}

function openCreateApiProfileModal() {
  focusLog('editor:open-create')
  apiEditorMode.value = 'create'
  resetApiDraft({
    name: '',
    providerType: 'openai',
    savedModels: [],
    activeModel: '',
  })
  apiEditorVisible.value = true
  emit('reset-api-models')
}

function openEditApiProfileModal(profileId) {
  const profile = apiProfiles.value.find((item) => item.id === profileId)
  if (!profile) return
  focusLog('editor:open-edit', { profileId })
  apiEditorMode.value = 'edit'
  resetApiDraft(profile)
  apiEditorVisible.value = true
  emit('reset-api-models')
}

function closeApiProfileModal() {
  apiEditorVisible.value = false
  apiFetchValidationError.value = ''
  apiSaveError.value = ''
  manualModelInput.value = ''
  apiModelSearchQuery.value = ''
  apiModelShowAll.value = false
  if (lastFocusedSettingsInputRef.value && !lastFocusedSettingsInputRef.value.isConnected) {
    lastFocusedSettingsInputRef.value = null
  }
  emit('reset-api-models')
}

function buildDraftSettingsOverride() {
  const draftProfile = createApiProfileDraft(apiDraft)
  draftProfile.savedModels = normalizeApiSavedModels(apiDraft.savedModels, apiDraft.activeModel)
  draftProfile.activeModel = getSavedModelId(apiDraft.activeModel || draftProfile.activeModel) || ''
  draftProfile.model = draftProfile.activeModel
  return normalizeSettingsSnapshot({
    ...normalizeSettingsSnapshot(JSON.parse(JSON.stringify(localSettings.value))),
    apiProfiles: [draftProfile],
    activeApiProfileId: draftProfile.id,
    apiProvider: draftProfile.providerType,
    apiKey: draftProfile.apiKey,
    apiBaseUrl: draftProfile.baseUrl,
    apiModel: draftProfile.activeModel,
  })
}

function handleFetchApiModels() {
  apiFetchValidationError.value = ''
  if (!String(apiDraft.apiKey || '').trim()) {
    apiFetchValidationError.value = '请先填写 API Key'
    return
  }
  if (!String(apiDraft.baseUrl || '').trim()) {
    apiFetchValidationError.value = '请先填写 Base URL'
    return
  }
  emit('fetch-api-models', buildDraftSettingsOverride())
}

function isDraftModelSaved(model) {
  const modelId = getSavedModelId(model) || String(model || '').trim()
  if (!modelId) return false
  return Array.isArray(apiDraft.savedModels) && apiDraft.savedModels.some((item) => getSavedModelId(item) === modelId)
}

function toggleDraftSavedModel(model) {
  const normalized = createDraftSavedModel(model)
  const normalizedId = getSavedModelId(normalized)
  if (!normalizedId) return
  if (!Array.isArray(apiDraft.savedModels)) apiDraft.savedModels = []
  if (apiDraft.savedModels.some((item) => getSavedModelId(item) === normalizedId)) {
    removeDraftModel(normalized)
    return
  }
  apiDraft.savedModels = normalizeApiSavedModels([...apiDraft.savedModels, normalized], apiDraft.activeModel)
  if (!apiDraft.activeModel) apiDraft.activeModel = normalizedId
}

function addManualModel() {
  const normalized = String(manualModelInput.value || '').trim()
  if (!normalized) return
  if (!Array.isArray(apiDraft.savedModels)) apiDraft.savedModels = []
  apiDraft.savedModels = normalizeApiSavedModels(
    [
      ...apiDraft.savedModels,
      {
        id: normalized,
        label: normalized,
      },
    ],
    apiDraft.activeModel,
  )
  if (!apiDraft.activeModel) apiDraft.activeModel = normalized
  manualModelInput.value = ''
}

function setDraftActiveModel(model) {
  const modelId = getSavedModelId(model)
  if (!modelId) return
  apiDraft.activeModel = modelId
}

function removeDraftModel(model) {
  const modelId = getSavedModelId(model) || String(model || '').trim()
  if (!modelId) return
  const savedModels = Array.isArray(apiDraft.savedModels) ? apiDraft.savedModels : []
  apiDraft.savedModels = savedModels.filter((item) => getSavedModelId(item) !== modelId)
  if (apiDraft.activeModel === modelId) apiDraft.activeModel = getSavedModelId(apiDraft.savedModels[0]) || ''
}

function saveApiProfile() {
  apiSaveError.value = ''
  const name = String(apiDraft.name || '').trim()
  const apiKey = String(apiDraft.apiKey || '').trim()
  const baseUrl = String(apiDraft.baseUrl || '').trim()
  const savedModels = normalizeApiSavedModels(apiDraft.savedModels, apiDraft.activeModel)
  const activeModel = getSavedModelId(apiDraft.activeModel) || getSavedModelId(savedModels[0]) || ''

  if (!name) {
    apiSaveError.value = '请先填写卡片名称'
    return
  }
  if (!apiKey) {
    apiSaveError.value = '请先填写 API Key'
    return
  }
  if (!baseUrl) {
    apiSaveError.value = '请先填写 Base URL'
    return
  }
  if (!activeModel) {
    apiSaveError.value = '请至少添加并选择一个模型'
    return
  }

  const nextProfile = createApiProfileDraft({ ...apiDraft, name, apiKey, baseUrl, savedModels, activeModel })
  nextProfile.savedModels = savedModels
  nextProfile.activeModel = activeModel
  nextProfile.model = activeModel

  const profiles = [...apiProfiles.value]
  const existingIndex = profiles.findIndex((item) => item.id === nextProfile.id)
  if (existingIndex >= 0) profiles.splice(existingIndex, 1, nextProfile)
  else profiles.unshift(nextProfile)

  localSettings.value.apiProfiles = profiles
  localSettings.value.activeApiProfileId = nextProfile.id
  closeApiProfileModal()
}

function deleteApiProfile(profileId) {
  const profiles = apiProfiles.value.filter((item) => item.id !== profileId)
  localSettings.value.apiProfiles = profiles
  if (localSettings.value.activeApiProfileId === profileId) {
    localSettings.value.activeApiProfileId = profiles[0]?.id || ''
  }
}

function saveAndConnect() {
  commitPortInput()
  emit('connect', {
    host: localSettings.value.host,
    port: localSettings.value.port,
    controlFrontendTarget: localSettings.value.controlFrontendTarget,
  })
}

function disconnectNow() {
  emit('disconnect', {
    host: localSettings.value.host,
    port: localSettings.value.port,
    controlFrontendTarget: localSettings.value.controlFrontendTarget,
  })
}

function triggerInstanceScan() {
  commitPortInput()
  emit('scan-instances', {
    host: localSettings.value.host,
    port: localSettings.value.port,
    controlFrontendTarget: localSettings.value.controlFrontendTarget,
  })
}

function selectDetectedInstance(instance) {
  if (!instance) return
  localSettings.value.host = String(instance.host || localSettings.value.host || '').trim() || localSettings.value.host
  localSettings.value.port = String(instance.port || localSettings.value.port || '').trim() || localSettings.value.port
  portInput.value = String(localSettings.value.port || '')
}

function connectDetectedInstance(instance) {
  if (!instance) return
  selectDetectedInstance(instance)
  saveAndConnect()
}

function shutdownInactiveInstance(instance) {
  if (!instance) return
  emit('shutdown-instance', {
    host: String(instance.host || '').trim(),
    port: String(instance.port || '').trim(),
  })
}

function isDetectedInstanceSelected(instance) {
  return (
    String(instance?.host || '').trim() === String(localSettings.value.host || '').trim() &&
    String(instance?.port || '').trim() === String(localSettings.value.port || '').trim()
  )
}

function isDetectedInstanceConnected(instance) {
  return `${String(instance?.host || '').trim()}:${String(instance?.port || '').trim()}` === String(props.actualConnectionEndpointText || '').trim()
}

function isDetectedInstanceShuttingDown(instance) {
  const instanceId = `${String(instance?.host || '').trim()}:${String(instance?.port || '').trim()}`
  return props.shuttingDownInstanceIds.includes(instanceId)
}

function handleConnectionAction() {
  commitPortInput()
  if (props.isConnected || props.connectionPhase === 'connecting' || props.connectionPhase === 'waiting') {
    disconnectNow()
    return
  }

  saveAndConnect()
}

function restoreDefaults() {
  showConfirmDialog.value = true
}

function executeRestore() {
  localSettings.value = normalizeSettingsSnapshot(DEFAULT_SETTINGS)
  syncInputMirrors()
  showConfirmDialog.value = false
}

watch(apiEditorVisible, async (nextVisible) => {
  if (!nextVisible) return
  focusLog('editor:initial-focus')
  await nextTick()
  if (apiEditorNameInputRef.value) {
    lastFocusedSettingsInputRef.value = apiEditorNameInputRef.value
    apiEditorNameInputRef.value.focus({ preventScroll: true })
    if (typeof apiEditorNameInputRef.value.setSelectionRange === 'function') {
      const length = apiEditorNameInputRef.value.value?.length || 0
      apiEditorNameInputRef.value.setSelectionRange(length, length)
    }
  }
})

onBeforeUnmount(() => {
  if (diagnosticCopyTimer) {
    clearTimeout(diagnosticCopyTimer)
    diagnosticCopyTimer = null
  }
})

</script>

<style scoped>
.settings-overlay {
  position: absolute;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}

.settings-panel {
  width: 90%;
  max-width: 420px;
  height: 76vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-color, #444);
  border-radius: 10px;
  background: var(--bg-card, #2c2c2c);
  color: var(--text-color, #e0e0e0);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
}

.settings-header,
.mode-switch-section,
.settings-footer {
  flex-shrink: 0;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #444);
  background: var(--bg-header, #242424);
}

.settings-footer {
  border-top: 1px solid var(--border-color, #444);
  border-bottom: none;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.close-btn {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.mode-switch-group,
.toggle-button-group {
  display: flex;
  overflow: hidden;
  border: 1px solid #444;
  border-radius: 6px;
}

.mode-btn,
.toggle-btn {
  flex: 1;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: #d0d0d0;
  cursor: pointer;
  font-size: 12px;
}

.mode-btn.active,
.toggle-btn.active {
  background: #528bff;
  color: #fff;
}

.settings-tabs {
  flex-shrink: 0;
  display: flex;
  gap: 6px;
  padding: 10px 16px 0;
  background: var(--bg-card, #2c2c2c);
}

.focus-recovery-note {
  flex-shrink: 0;
  margin: 10px 16px 0;
  padding: 8px 10px;
  border-left: 2px solid rgba(255, 191, 105, 0.55);
  border-radius: 6px;
  background: rgba(255, 191, 105, 0.08);
  color: #e7c58b;
  font-size: 11px;
  line-height: 1.45;
}

.tab-button {
  flex: 1;
  padding: 10px 0 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #c8c8c8;
  cursor: pointer;
  font-size: 12px;
}

.tab-button.active {
  color: #fff;
  border-bottom-color: #528bff;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 16px;
}

.tab-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.setting-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.setting-subtitle {
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #9fbaff;
}

.setting-group label {
  font-size: 12px;
  color: #d8d8d8;
}

.checkbox-group {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.checkbox-group label {
  cursor: pointer;
}

.input-base {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #444;
  border-radius: 6px;
  background: #202020;
  color: #e0e0e0;
  box-sizing: border-box;
  font: inherit;
  line-height: 1.35;
}

.input-base:focus {
  outline: none;
  border-color: #528bff;
}

.custom-expand-input {
  margin-top: 8px;
}

.help-text,
.info-box,
.connection-status,
.connection-error {
  font-size: 11px;
  line-height: 1.5;
}

.help-text {
  color: #a9a9a9;
}

.help-error {
  color: #ff9696;
}

.info-box {
  padding: 10px 12px;
  border-left: 2px solid #528bff;
  border-radius: 6px;
  background: rgba(82, 139, 255, 0.08);
  color: #cfcfcf;
}

.sensitivity-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sensitivity-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #9f9f9f;
}

.sensitivity-value {
  color: #528bff;
}

.connection-status {
  color: #bdbdbd;
}

.status-text.connected {
  color: #5dd39e;
}

.status-text.disconnected {
  color: #d36d6d;
}

.connection-error {
  color: #ff8f8f;
}

.connection-meta-text,
.scan-status-text {
  font-size: 11px;
  line-height: 1.5;
  color: #aeb7c7;
}

.instance-section-title {
  margin: 10px 0 8px;
  font-size: 11px;
  font-weight: 700;
  color: #dbe5ff;
}

.detected-instance-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.inactive-instance-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.detected-instance-item {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #444;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  color: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
}

.detected-instance-item:hover {
  border-color: rgba(82, 139, 255, 0.42);
  background: rgba(82, 139, 255, 0.08);
  transform: translateY(-1px);
}

.detected-instance-item.selected {
  border-color: rgba(82, 139, 255, 0.7);
  background: rgba(82, 139, 255, 0.14);
}

.detected-instance-item.connected {
  border-color: rgba(93, 211, 158, 0.38);
  background: rgba(93, 211, 158, 0.08);
}

.inactive-instance-item {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.inactive-instance-item.connected {
  border-color: rgba(93, 211, 158, 0.3);
  background: rgba(93, 211, 158, 0.06);
}

.detected-instance-main,
.detected-instance-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.detected-instance-main {
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.detected-instance-endpoint {
  font-size: 12px;
  font-weight: 700;
  color: #f0f4ff;
}

.detected-instance-version {
  font-size: 10px;
  color: #93a8d6;
}

.detected-instance-subline {
  font-size: 10px;
  color: #aeb7c7;
}

.detected-instance-badges {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.instance-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.74);
  font-size: 10px;
  font-weight: 600;
}

.instance-pill.connected {
  border-color: rgba(93, 211, 158, 0.3);
  background: rgba(93, 211, 158, 0.12);
  color: #9fe2be;
}

.instance-pill.active {
  border-color: rgba(82, 139, 255, 0.28);
  background: rgba(82, 139, 255, 0.12);
  color: #b7ceff;
}

.instance-pill.inactive {
  border-color: rgba(255, 204, 120, 0.22);
  background: rgba(255, 204, 120, 0.1);
  color: #ffd89b;
}

.instance-pill.selected {
  border-color: rgba(82, 139, 255, 0.32);
  background: rgba(82, 139, 255, 0.14);
  color: #b7ceff;
}

.compact-muted {
  margin-top: 8px;
}

.button-group {
  display: flex;
}

.btn {
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
}

.btn.primary {
  background: #528bff;
  color: #fff;
}

.btn.danger {
  background: #5a2b2b;
  color: #ffd5d5;
}

.api-key-wrap {
  display: flex;
  gap: 8px;
}

.api-key-toggle {
  flex-shrink: 0;
  padding: 0 12px;
  border: 1px solid #444;
  border-radius: 6px;
  background: #242424;
  color: #e0e0e0;
  cursor: pointer;
}

.inline-action-btn {
  flex-shrink: 0;
  min-width: 76px;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid #444;
  border-radius: 6px;
  background: #242424;
  color: #e0e0e0;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  line-height: 1;
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
}

.inline-action-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.inline-action-btn.primary {
  background: #528bff;
  color: #fff;
  border-color: transparent;
}

.inline-action-btn.danger {
  border-color: rgba(255, 120, 120, 0.3);
  background: rgba(138, 45, 45, 0.9);
  color: #ffd3d3;
}

.inline-action-btn.compact {
  min-width: 72px;
  min-height: 28px;
  padding: 0 8px;
}

.primary-btn {
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: #528bff;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  line-height: 1;
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  cursor: pointer;
}

.primary-btn:hover {
  background: #6696ff;
}

.api-toolbar,
.api-card-head,
.api-card-title-row,
.api-card-model-head,
.inline-row,
.api-editor-header,
.api-editor-footer,
.api-card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.api-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.api-card {
  padding: 14px;
  border: 1px solid #444;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
  cursor: pointer;
}

.api-card.active {
  border-color: rgba(82, 139, 255, 0.7);
  background: rgba(82, 139, 255, 0.08);
}

.api-card:hover {
  transform: translateY(-1px);
}

.api-card-title {
  font-size: 14px;
  font-weight: 700;
  color: #fff;
}

.api-card-meta,
.api-card-url,
.inline-status {
  font-size: 11px;
  color: #a9a9a9;
  line-height: 1.5;
}

.api-card-url {
  margin-top: 8px;
}

.api-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: rgba(82, 139, 255, 0.16);
  color: #9fbeff;
  font-size: 10px;
  font-weight: 700;
}

.api-card-actions {
  margin-left: auto;
}

.api-card-model {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.muted-box,
.empty-box {
  padding: 12px;
  border: 1px solid #444;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.025);
  color: #a6a6a6;
  font-size: 12px;
  line-height: 1.5;
}

.empty-box {
  text-align: center;
  border-style: dashed;
}

.empty-title {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 700;
  color: #ededed;
}

.api-editor-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.42);
  z-index: 20;
}

.api-editor-modal {
  width: min(420px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #444;
  border-radius: 10px;
  background: var(--bg-card, #2c2c2c);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
}

.api-editor-header,
.api-editor-footer {
  padding: 14px 16px;
}

.api-editor-header {
  border-bottom: 1px solid #444;
}

.api-editor-footer {
  border-top: 1px solid #444;
}

.api-editor-footer {
  justify-content: flex-end;
}

.api-editor-footer .ghost-btn,
.api-editor-footer .primary-btn {
  min-width: 96px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.api-editor-footer .primary-btn {
  background: #528bff;
  color: #fff;
}

.api-editor-footer .primary-btn:hover {
  background: #6696ff;
}

.api-editor-header h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.api-editor-kicker {
  margin-bottom: 4px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #9aa7be;
}

.api-editor-body {
  padding: 16px;
  overflow-y: auto;
}

.compact-block {
  margin-top: 14px;
}

.grow {
  flex: 1;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.model-count-text {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.48);
}

.model-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.model-group-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}

.model-group-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.68);
}

.model-group-title span {
  color: rgba(255, 255, 255, 0.42);
}

.model-list,
.saved-model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.model-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid #444;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  color: #ececec;
  cursor: pointer;
  font-size: 12px;
}

.model-chip.added {
  border-color: rgba(82, 139, 255, 0.6);
  background: rgba(82, 139, 255, 0.12);
}

.model-chip-body,
.saved-model-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.model-chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-chip-badges,
.saved-model-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.endpoint-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.72);
  font-size: 10px;
  line-height: 1;
}

.endpoint-badge.is-image {
  border-color: rgba(94, 201, 124, 0.28);
  background: rgba(94, 201, 124, 0.12);
  color: #9fe1b0;
}

.endpoint-badge.is-gemini {
  border-color: rgba(111, 170, 255, 0.28);
  background: rgba(111, 170, 255, 0.12);
  color: #b7d4ff;
}

.endpoint-badge.is-openai {
  border-color: rgba(255, 199, 94, 0.28);
  background: rgba(255, 199, 94, 0.12);
  color: #ffd792;
}

.saved-model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px;
  border: 1px solid #444;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
}

.saved-model-row.active {
  border-color: rgba(82, 139, 255, 0.6);
  background: rgba(82, 139, 255, 0.08);
}

.saved-model-main,
.saved-model-remove,
.ghost-btn {
  border: 0;
  background: transparent;
  color: #ececec;
  cursor: pointer;
}

.saved-model-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  text-align: left;
}

.saved-model-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-model-remove {
  min-height: 28px;
  padding: 0 8px;
  color: #ffb0b0;
}

.ghost-btn {
  min-height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  line-height: 1;
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
}

.ghost-btn.danger {
  color: #ffb1b1;
}

.cache-clear-btn {
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(82, 120, 186, 0.42);
  border-radius: 6px;
  background: rgba(38, 64, 110, 0.18);
  color: #d8e7ff;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, opacity 0.18s ease;
}

.cache-clear-btn:hover:not(:disabled) {
  background: rgba(47, 77, 130, 0.26);
  border-color: rgba(98, 146, 225, 0.55);
}

.cache-clear-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.danger-zone {
  margin-top: 8px;
}

.btn-reset-large {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #6b4545;
  border-radius: 6px;
  background: rgba(107, 69, 69, 0.12);
  color: #ffb1b1;
  cursor: pointer;
}

.credit-elegant {
  text-align: center;
  line-height: 1.6;
}

.credit-main {
  font-size: 11px;
  color: #aaa;
}

.credit-main span {
  color: #fff;
}

.credit-sub {
  font-size: 10px;
  color: #888;
}

.custom-confirm-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.custom-confirm-box {
  width: 280px;
  padding: 18px;
  border: 1px solid #444;
  border-radius: 10px;
  background: #262626;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  text-align: center;
}

.confirm-icon {
  width: 34px;
  height: 34px;
  margin: 0 auto 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 176, 64, 0.14);
  color: #ffb040;
  font-weight: 700;
}

.custom-confirm-box h4 {
  margin: 0 0 8px;
}

.custom-confirm-box p {
  margin: 0;
  font-size: 12px;
  color: #c0c0c0;
  line-height: 1.6;
}

.confirm-buttons {
  margin-top: 14px;
  display: flex;
  gap: 8px;
}

.btn-cancel,
.btn-danger {
  flex: 1;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.btn-cancel {
  border: 1px solid #444;
  background: transparent;
  color: #d0d0d0;
}

.btn-danger {
  border: none;
  background: #b84d4d;
  color: #fff;
}

.diagnostic-pane {
  gap: 10px;
}

.diagnostic-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.diagnostic-meta {
  font-size: 11px;
  color: #b8b8b8;
}

.diagnostic-actions {
  display: flex;
  gap: 8px;
}

.diagnostic-textarea {
  width: 100%;
  min-height: 260px;
  resize: vertical;
  border: 1px solid #4b4b4b;
  border-radius: 8px;
  padding: 10px;
  background: #171717;
  color: #dcdcdc;
  font-size: 11px;
  line-height: 1.5;
  font-family: 'Consolas', 'SFMono-Regular', monospace;
  box-sizing: border-box;
}
</style>

