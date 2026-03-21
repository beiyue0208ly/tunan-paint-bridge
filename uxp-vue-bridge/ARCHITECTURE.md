# UXP 架构说明

这份文档只回答两件事：

1. 现在这套 UXP 插件到底怎么分层
2. 以后要改功能，应该先去哪里动

---

## 1. 总体结构

当前插件是一个双层结构：

```text
Vue WebView
  ├─ UI 组件
  ├─ 页面组合逻辑
  ├─ 状态存储
  └─ host 消息桥

UXP Host
  ├─ host.js 入口
  ├─ dispatcher 调度
  └─ services 具体能力
     ├─ Photoshop
     ├─ ComfyUI
     ├─ API
     ├─ Workflow
     └─ Task
```

核心原则：

- WebView 负责“界面和状态”
- Host 负责“真正执行”
- 协议层负责“消息名统一”

---

## 2. WebView 侧怎么分

### [src/App.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/App.vue)

只负责顶层布局和组件拼装。

这里应该看到的是：

- 预览区
- 历史图
- ComfyUI 底栏
- API 输入栏
- 设置面板

不应该把复杂业务继续堆回这里。

### [src/composables/useBridgeApp.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/composables/useBridgeApp.js)

这是当前前端真正的页面控制器。

它负责：

- 模式切换
- 连接状态
- 任务状态
- 发送 ComfyUI / API 请求
- 结果进入哪个 result store
- 顶部状态灯和等待文案
- 历史缓存的读写节奏

如果一个功能同时牵涉多个组件，大概率先看这里。

### [src/components](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components)

这里放纯组件。

关键组件：

- [InteractivePreview.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/InteractivePreview.vue)
  - 主图查看器，负责缩放、拖动、复位和双击触发
- [ReferenceImages.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/ReferenceImages.vue)
  - API 参考图区，本地上传和拖拽上传
- [SettingsPanel.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/SettingsPanel.vue)
  - 所有设置和 API 卡片编辑
- [HistoryDock.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/HistoryDock.vue)
  - 主图 / 历史图切换
- [PromptPanel.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/PromptPanel.vue)
  - ComfyUI 提示词和参数面板

### 状态和基础能力

#### [src/core/results/resultStore.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/results/resultStore.js)

管理单个模式下的：

- 主图
- 历史图
- 当前激活历史项

#### [src/core/results/resultCache.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/results/resultCache.js)

管理历史缓存。

当前策略：

- API 和 ComfyUI 分开缓存
- 每组最多 11 张
- 用 IndexedDB 存，不额外重压缩图片

#### [src/core/settings/bridgeSettings.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/settings/bridgeSettings.js)

这里统一定义：

- 默认设置
- 设置归一化
- API 卡片结构
- 模型 endpoint 类型推断

以后凡是“设置项加字段”，先改这里。

#### [src/core/protocol/hostProtocol.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/protocol/hostProtocol.js)

WebView 侧消息协议。

所有新的 host 消息，都要在这里先命名，再去改 host 侧对应协议。

#### [src/core/bridge/webviewBridge.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/bridge/webviewBridge.js)

只做两件事：

- `sendToHost`
- `subscribeHostMessages`

不要在这里继续塞业务。

---

## 3. Host 侧怎么分

### [public/host.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host.js)

这是宿主入口。

它现在应该只承担：

- 找到 `webview`
- 接收 WebView 消息
- 做少量宿主级别处理
  - 焦点守卫
  - 面板激活
  - WebView ready
- 把大部分命令交给 dispatcher

这里不应该再放一套完整的业务 UI。

注意：

- 早期存在过一套 host 原生 API 卡片编辑弹层
- 现在已经废弃
- 统一只保留 WebView 设置面板编辑

### [public/host/dispatcher.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/dispatcher.js)

这是调度层。

它负责：

- 读取和持久化设置
- 识别消息类型
- 把任务分发给对应服务
- 准备标准化 payload

如果你在想“某个消息到底该进哪个 service”，先看这里。

### [public/host/services](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services)

#### [tunan-photoshop-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/tunan-photoshop-service.js)

负责：

- 从 Photoshop 采图
- 发送画布 / 图层 / 选区
- 结果图导回 Photoshop
- 实时模式需要的基线和比对准备

#### [tunan-capture-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/tunan-capture-service.js)

负责：

- 选区边界
- layer / document / selection 范围计算
- `placement` 元数据

`placement` 很关键。  
ComfyUI 和 API 的“原位导回 Photoshop”都靠它。

#### [comfy-engine.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/comfy-engine.js)

负责：

- ComfyUI WebSocket
- HTTP 兜底
- 进度同步
- 连接生命周期

#### [api-engine.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/api-engine.js)

负责：

- API 卡片配置解析
- endpoint 选择
- 参考图 / 主图请求体组装
- 返回图解析
- placement 回传给结果 meta

当前 API 语义约定：

- 打开“画布”时：
  - 当前画布 / 选区图 = 主图
  - 参考图区图片 = 参考图
- 不打开“画布”时：
  - 第一张参考图 = 主参考
  - 后续参考图 = 辅助参考

#### [workflow-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/workflow-service.js)

负责：

- 已保存工作流列表
- 已打开标签页同步
- 当前工作流状态

#### [task-center.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/task-center.js)

负责：

- 任务标识
- 停止 / 重跑的基础状态

---

## 4. 两条主链怎么走

### ComfyUI 模式

```text
UI 发送
  -> useBridgeApp
  -> dispatcher.prepareRunPayload
  -> photoshop capture
  -> comfy-engine
  -> ComfyUI 返回图片
  -> resultStore
  -> 主图 / 历史图显示
  -> 双击回 PS
```

### API 模式

```text
UI 发送
  -> useBridgeApp
  -> dispatcher.prepareApiPayload
  -> Photoshop / 参考图整理
  -> api-engine
  -> API 返回图片
  -> resultStore
  -> 历史缓存
  -> 双击回 PS
```

---

## 5. 为什么 API 和 ComfyUI 都能“原位回 Photoshop”

因为两边现在都走同一个原则：

- 发送前先记住这次图像对应的 `placement`
- 返回后把 `placement` 放进结果 meta
- 双击时复用同一套 `ADD_IMAGE_TO_PS`

所以它不是“按图猜位置”，而是“按发送时记住的位置贴回去”。

---

## 6. 焦点系统为什么单独说

UXP WebView 焦点问题不是普通输入框问题，而是宿主层限制。

当前策略是：

- [src/composables/useFocusGuard.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/composables/useFocusGuard.js)
  - 统一文本输入守卫
  - 与 host 语义化同步焦点状态
- [public/host.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host.js)
  - 负责 WebView 激活、focus trap 和面板激活

重要结论：

- 这条问题已经被验证到宿主边界
- 当前做法是“尽量恢复 + 设置面板提示”
- 不要再轻易在别的组件里各写一套焦点补丁

---

## 7. 以后加功能，先看这里

### 想加新的设置项

先改：

- [bridgeSettings.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/settings/bridgeSettings.js)
- [SettingsPanel.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/SettingsPanel.vue)
- 需要持久化时再看 [dispatcher.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/dispatcher.js)

### 想加新的 host 消息

先改：

- [src/core/protocol/hostProtocol.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/protocol/hostProtocol.js)
- [public/host/protocol.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/protocol.js)

再改：

- [useBridgeApp.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/composables/useBridgeApp.js)
- [host.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host.js) 或具体 service

### 想加新的结果图行为

先看：

- [InteractivePreview.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/InteractivePreview.vue)
- [resultStore.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/results/resultStore.js)
- [resultCache.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/results/resultCache.js)

### 想改 API 发图规则

先看：

- [api-engine.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/api-engine.js)
- [tunan-photoshop-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/tunan-photoshop-service.js)
- [ReferenceImages.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components/ReferenceImages.vue)

---

## 8. 当前已知维护建议

### 推荐继续保持

- ComfyUI 和 API 两套结果缓存分开
- 主图查看器保持独立组件
- API 卡片只保留 WebView 内编辑

### 暂时不要做

- 不要重建 host 原生 API 编辑弹层
- 不要把 host 服务逻辑重新塞回 `host.js`
- 不要让 `App.vue` 再次承担结果缓存或请求组装

---

## 9. 一句话总结

现在这套结构的核心是：

**WebView 负责界面和状态，Host 负责执行，placement 负责原位回贴，协议层负责把两边保持一致。**

以后新功能只要顺着这四条走，代码就不会再乱回去。
