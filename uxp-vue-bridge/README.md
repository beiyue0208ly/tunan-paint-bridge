# ComfyPS Bridge UXP

`uxp-vue-bridge` 是当前仍在维护的 Photoshop UXP 插件实现。  
它负责把 Photoshop、ComfyUI 和通用图像 API 串成一个可用的绘画工作台。

## 当前状态

这套 UXP 侧已经完成了主链闭环：

- ComfyUI 模式：连接、发送、工作流切换、历史图、双击原位回 Photoshop
- API 模式：卡片配置、模型拉取、画布发送、参考图、历史缓存、双击原位回 Photoshop
- 通用体验：结果缓存、主图缩放拖动、失败提示、参考图拖拽上传

如果要继续开发，请默认：

- 只改 `uxp-vue-bridge`
- 不再使用旧的 `archive/uxp-plugin-legacy`

## 开发入口

### 前端 WebView

- [src/App.vue](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/App.vue)
- [src/composables/useBridgeApp.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/composables/useBridgeApp.js)

这里负责：

- Vue 界面
- 交互状态
- 主图 / 历史图 / 设置面板
- 向 host 发送命令

### Host 原生层

- [public/host.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host.js)
- [public/host/dispatcher.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/dispatcher.js)
- [public/host/services](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services)

这里负责：

- Photoshop API 调用
- ComfyUI 连接
- API 请求
- 回图导回 Photoshop

## 目录说明

### WebView 侧

- [src/components](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components)
  - 纯 UI 组件
- [src/composables](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/composables)
  - 页面级组合逻辑
- [src/core/bridge](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/bridge)
  - WebView 和 host 通信封装
- [src/core/protocol](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/protocol)
  - 消息类型定义
- [src/core/results](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/results)
  - 主图、历史图、缓存
- [src/core/settings](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/settings)
  - 设置归一化和 API 卡片数据结构
- [src/core/tasks](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/tasks)
  - 当前任务状态
- [src/core/workflows](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/core/workflows)
  - ComfyUI 工作流状态

### Host 侧

- [public/host/services/tunan-photoshop-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/tunan-photoshop-service.js)
  - Photoshop 图像采集、回贴、实时基线
- [public/host/services/tunan-capture-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/tunan-capture-service.js)
  - 选区、图层、发送范围和 placement
- [public/host/services/comfy-engine.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/comfy-engine.js)
  - ComfyUI WebSocket / HTTP
- [public/host/services/api-engine.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/api-engine.js)
  - API 模式请求组装和图片解析
- [public/host/services/workflow-service.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/workflow-service.js)
  - 工作流列表和标签页同步
- [public/host/services/task-center.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services/task-center.js)
  - 任务编号和停止控制

## 运行和构建

在 [uxp-vue-bridge](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge) 下执行：

```powershell
npm install
npm run dev
```

打包用于 Photoshop 测试：

```powershell
npm run build
```

构建产物会进入：

- [dist](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/dist)

## 维护约定

### 1. 新功能放哪里

- 改界面：先看 [src/components](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/components)
- 改页面逻辑：先看 [src/composables/useBridgeApp.js](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/src/composables/useBridgeApp.js)
- 改消息协议：同时改前后两边的 `hostProtocol`
- 改 Photoshop / ComfyUI / API 行为：改 [public/host/services](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/public/host/services)

### 2. 不要再做的事

- 不要把业务逻辑重新塞回 `App.vue`
- 不要再新增一套 host 侧 API 卡片编辑器
- 不要修改已废弃的 `archive/uxp-plugin-legacy`

### 3. 已知限制

- UXP WebView 的键盘焦点恢复仍受宿主限制
- 当前已经通过统一焦点守卫和设置面板提示降低影响
- 这是平台边界，不是普通前端输入框 bug

## 进一步阅读

更完整的维护说明见：

- [ARCHITECTURE.md](/I:/BaiduSyncdisk/uxp-comfyui-bridge-project/uxp-vue-bridge/ARCHITECTURE.md)
