import { app as comfyApp } from "../../scripts/app.js";
import { api as comfyApi } from "../../scripts/api.js";

(() => {
  "use strict";

  const PRODUCT_NAME = "图南画桥";
  const FRONTEND_VERSION = 36;
  const FRONTEND_RUNTIME_KEY = "__tunanPaintBridgeFrontendRuntime";
  const previousRuntime = window[FRONTEND_RUNTIME_KEY];
  const hasLegacyFrontend = Boolean(window.__tunanPaintBridgeFrontendLoaded && !previousRuntime);

  if (previousRuntime?.version === FRONTEND_VERSION) {
    return;
  }

  if (hasLegacyFrontend) {
    console.warn(`[${PRODUCT_NAME}] legacy frontend instance detected, refresh ComfyUI once to load the new frontend cleanly`);
    return;
  }

  if (typeof previousRuntime?.dispose === "function") {
    try {
      previousRuntime.dispose("reload");
    } catch (error) {
      console.warn(`[${PRODUCT_NAME}] previous frontend dispose failed`, error);
    }
  }

  window.__tunanPaintBridgeFrontendLoaded = true;
  const EXTENSION_NAME = "tunan.paint.bridge.frontend";
  const FONT_FAMILY = "'Microsoft YaHei', 'Segoe UI', sans-serif";
  const RECEIVE_FLASH_DURATION_MS = 1000;
  const FRONTEND_KIND = "electronAPI" in window ? "desktop" : "browser";
  const FRONTEND_SESSION_ID = (() => {
    const storageKey = "__tunanPaintBridgeFrontendSessionId";
    try {
      const cached = window.sessionStorage?.getItem(storageKey);
      if (cached) return cached;
      const created = `${FRONTEND_KIND}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage?.setItem(storageKey, created);
      return created;
    } catch (_) {
      return `${FRONTEND_KIND}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
  })();

  const IDS = {
    bridge: "TuNanPSBridge",
    sender: "TuNanPSSender",
    smartResize: "TuNanSmartResize",
    maskRefine: "TuNanMaskRefine",
  };

  const TARGET_IDS = new Set(Object.values(IDS));
  const MAIN_IDS = new Set([IDS.bridge, IDS.sender]);

  const DISPLAY = {
    [IDS.bridge]: "图南PS桥接器",
    [IDS.sender]: "图南PS发送器",
    [IDS.smartResize]: "图南智能缩放",
    [IDS.maskRefine]: "图南蒙版微调",
  };

  const DESCRIPTIONS = {
    [IDS.bridge]: "接收 Photoshop 发来的图像、选区和参数",
    [IDS.sender]: "把结果发回 Photoshop，可在整图和选区还原之间切换",
    [IDS.smartResize]: "按一条边统一尺寸，自动保持比例",
    [IDS.maskRefine]: "扩边、柔化或反转蒙版，适合回传前修边",
  };

  const BRIDGE_SOURCE_LABELS = {
    current_layer_selection: "当前层选区",
    merged_selection: "合并选区",
    current_layer_content: "当前层内容",
    current_layer_document: "当前层整图",
    merged_document: "整张文档",
    http_upload: "HTTP 上传",
  };

  const SURFACE = {
    title: "#272a30",
    body: "#181b20",
    preview: "#111317",
    previewBorder: "rgba(255,255,255,0.06)",
    line: "rgba(255,255,255,0.08)",
    text: "#e6e9ef",
    muted: "#8c94a0",
    mutedSoft: "#626975",
    chip: "rgba(255,255,255,0.05)",
    sizeBar: "rgba(12,14,17,0.94)",
    placeholder: "rgba(255,255,255,0.06)",
    placeholderText: "rgba(230,233,239,0.76)",
    placeholderSub: "rgba(140,148,160,0.76)",
  };

  const THEMES = {
    [IDS.bridge]: {
      ...SURFACE,
      accentRgb: "118,136,166",
      accentSoft: "rgba(118,136,166,0.08)",
      accentStrong: "#8091ae",
      previewBorder: "rgba(255,255,255,0.06)",
      danger: "#c38888",
      dangerRgb: "195,136,136",
    },
    [IDS.sender]: {
      ...SURFACE,
      accentRgb: "130,149,140",
      accentSoft: "rgba(130,149,140,0.08)",
      accentStrong: "#8ea197",
      previewBorder: "rgba(255,255,255,0.06)",
      danger: "#b78f82",
      dangerRgb: "183,143,130",
    },
    [IDS.smartResize]: {
      ...SURFACE,
      accentRgb: "132,143,163",
      accentSoft: "rgba(132,143,163,0.08)",
      accentStrong: "#8d99af",
      previewBorder: "rgba(255,255,255,0.06)",
    },
    [IDS.maskRefine]: {
      ...SURFACE,
      accentRgb: "126,148,146",
      accentSoft: "rgba(126,148,146,0.08)",
      accentStrong: "#8fa2a0",
      previewBorder: "rgba(255,255,255,0.06)",
    },
  };

  const MIN_SIZE = {
    [IDS.bridge]: [340, 450],
    [IDS.sender]: [340, 450],
    [IDS.smartResize]: [332, 312],
    [IDS.maskRefine]: [308, 252],
  };

  const TOOL_LAYOUT = {
    contentTop: 48,
    slotSpacing: 22,
    widgetSpacing: 28,
    widgetHeight: 22,
    footerHeight: 76,
    bottomPad: 14,
    widgetInputX: 12,
    slotPad: 4,
    portsAreaHeight: 64,
    slotVisualLift: 22,
    portInset: 12,
    controlsTopPad: 12,
    gapBeforeFooter: 20,
    footerMaxHeight: 148,
  };

  const STATE = {
    app: null,
    graphRefreshTimer: null,
    workflowSyncDebounce: null,
    workflowObserver: null,
    workflowObserverTarget: null,
    workflowSurfaceObserver: null,
    workflowClickBound: false,
    workflowTabMeta: {},
    workflowSyncToken: null,
    workflowBridgeReady: false,
    bridge: null,
    sender: null,
    bridgeImage: null,
    senderImage: null,
    bridgeSizeText: "无图像",
    senderSizeText: "无图像",
    lastBridgeToken: null,
    lastSenderToken: null,
    bridgeImageRequestId: 0,
    senderImageRequestId: 0,
    senderExecutionStartedAt: 0,
    workflowExecutionStartedAt: 0,
    senderExecutionElapsed: 0,
    queueButtonBound: false,
    bridgeReceiveFlashUntil: 0,
    bridgeReceiveAnimationFrame: null,
    senderAdjustDebounce: null,
    senderAdjustRequestId: 0,
    senderPreviewFrame: 0,
    senderPreviewPendingNode: null,
    senderPreviewPendingForce: false,
    senderSource: null,
    senderSourcePromise: null,
  };

  const MANAGED_LISTENERS = [];

  const BRIDGE_OUTPUT_NAMES = ["图像", "选区", "降噪强度", "种子", "正面提示词", "负面提示词", "CFG", "步数"];
  const SENDER_RETURN_MODE_NAME = "回贴模式";
  const SENDER_EDGE_SHRINK_NAME = "边缘收缩";
  const SENDER_EDGE_FEATHER_NAME = "边缘柔化";
  const SENDER_RESEND_BUTTON_NAME = "重新发送当前图";
  function debugLog(stage, payload = {}) {
    try {
      console.log(`[TuNanFrontendDebug] ${stage}`, payload);
    } catch (_) {
      console.log(`[TuNanFrontendDebug] ${stage}`);
    }
  }

  function addManagedEventListener(target, type, handler, options) {
    if (!target?.addEventListener || typeof handler !== "function") {
      return false;
    }

    target.addEventListener(type, handler, options);
    MANAGED_LISTENERS.push({ target, type, handler, options });
    return true;
  }

  function removeManagedEventListeners() {
    while (MANAGED_LISTENERS.length) {
      const item = MANAGED_LISTENERS.pop();
      try {
        item.target?.removeEventListener?.(item.type, item.handler, item.options);
      } catch (_) {}
    }
  }

  function disposeFrontendRuntime(reason = "reload") {
    stopBridgeReceivePulse();

    if (STATE.graphRefreshTimer) {
      window.clearTimeout(STATE.graphRefreshTimer);
      STATE.graphRefreshTimer = null;
    }

    if (STATE.workflowSyncDebounce) {
      window.clearTimeout(STATE.workflowSyncDebounce);
      STATE.workflowSyncDebounce = null;
    }

    if (STATE.senderAdjustDebounce) {
      window.clearTimeout(STATE.senderAdjustDebounce);
      STATE.senderAdjustDebounce = null;
    }

    if (STATE.workflowObserver) {
      STATE.workflowObserver.disconnect();
      STATE.workflowObserver = null;
      STATE.workflowObserverTarget = null;
    }

    if (STATE.workflowSurfaceObserver) {
      STATE.workflowSurfaceObserver.disconnect();
      STATE.workflowSurfaceObserver = null;
    }

    removeManagedEventListeners();
    STATE.workflowBridgeReady = false;
    STATE.workflowClickBound = false;
    STATE.workflowTabMeta = {};
    STATE.queueButtonBound = false;
    STATE.app = null;

    if (window[FRONTEND_RUNTIME_KEY]?.dispose === disposeFrontendRuntime) {
      delete window[FRONTEND_RUNTIME_KEY];
    }

    console.info(`[${PRODUCT_NAME}] frontend disposed (${reason})`);
  }

  function ensureRoundRect() {
    if (CanvasRenderingContext2D.prototype.roundRect) {
      return;
    }

    CanvasRenderingContext2D.prototype.roundRect = function roundRect(x, y, w, h, r) {
      let radius = r;
      if (w < 2 * radius) radius = w / 2;
      if (h < 2 * radius) radius = h / 2;
      this.moveTo(x + radius, y);
      this.arcTo(x + w, y, x + w, y + h, radius);
      this.arcTo(x + w, y + h, x, y + h, radius);
      this.arcTo(x, y + h, x, y, radius);
      this.arcTo(x, y, x + w, y, radius);
      this.closePath();
      return this;
    };
  }

  function drawText(ctx, text, x, y, options = {}) {
    ctx.save();
    ctx.fillStyle = options.color || "#ffffff";
    ctx.font = options.font || `12px ${FONT_FAMILY}`;
    ctx.textAlign = options.align || "left";
    ctx.textBaseline = options.baseline || "alphabetic";
    ctx.fillText(String(text), x, y);
    ctx.restore();
  }

  function shortenLabel(text, maxLength = 10) {
    const value = String(text || "").trim();
    if (!value) return "";
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
  }

  function getBridgeSourceText(context = {}, imageInfo = {}) {
    const sourceKey = context.source || imageInfo.source || "";
    let label = BRIDGE_SOURCE_LABELS[sourceKey] || "";

    if (!label) {
      if (context.has_selection || imageInfo.has_selection) {
        label = "选区输入";
      } else if (sourceKey) {
        label = sourceKey.replace(/_/g, " ");
      } else {
        label = "";
      }
    }

    return shortenLabel(label, 10);
  }

  function getSenderDeliveryText(raw = {}) {
    if (raw.sent_to_ps) {
      return raw.can_overlay_in_place ? "已回传 PS" : "已发送 PS";
    }

    if (raw.has_preview || raw.has_image) {
      if (raw.message) {
        return shortenLabel(raw.message, 18);
      }
      return "仅预览";
    }

    return "";
  }

  function fillRounded(ctx, x, y, w, h, radius, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    ctx.restore();
  }

  function strokeRounded(ctx, x, y, w, h, radius, color, lineWidth = 1) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.stroke();
    ctx.restore();
  }

  function clipRounded(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.clip();
  }

  function getRuntimeApp() {
    return STATE.app || comfyApp || window.comfyAPI?.app?.app || window.app || null;
  }

  function getRuntimeApi() {
    return getRuntimeApp()?.api || comfyApi || window.comfyAPI?.api || null;
  }

  function markCanvasDirty() {
    const app = getRuntimeApp();
    if (!app?.canvas) return;

    try {
      app.canvas.setDirty(true, true);
      if (typeof app.canvas.draw === "function") {
        app.canvas.draw(true, true);
      }
    } catch (_) {}
  }

  function normalizeMainNodePorts(node) {
    if (!node || !Array.isArray(node.outputs) && !Array.isArray(node.inputs)) {
      return;
    }

    if (node.comfyClass === IDS.bridge && Array.isArray(node.outputs)) {
      BRIDGE_OUTPUT_NAMES.forEach((name, index) => {
        if (node.outputs[index]) {
          node.outputs[index].name = name;
          node.outputs[index].label = name;
        }
      });
    }

  }

  function stopBridgeReceivePulse() {
    if (STATE.bridgeReceiveAnimationFrame) {
      cancelAnimationFrame(STATE.bridgeReceiveAnimationFrame);
      STATE.bridgeReceiveAnimationFrame = null;
    }
    STATE.bridgeReceiveFlashUntil = 0;
  }

  function triggerBridgeReceiveFeedback(durationMs = RECEIVE_FLASH_DURATION_MS) {
    const now = performance.now();
    STATE.bridgeReceiveFlashUntil = now + durationMs;

    if (STATE.bridgeReceiveAnimationFrame) {
      return;
    }

    const tick = () => {
      const current = performance.now();
      if (current >= STATE.bridgeReceiveFlashUntil) {
        STATE.bridgeReceiveAnimationFrame = null;
        STATE.bridgeReceiveFlashUntil = 0;
        markCanvasDirty();
        return;
      }

      markCanvasDirty();
      STATE.bridgeReceiveAnimationFrame = requestAnimationFrame(tick);
    };

    STATE.bridgeReceiveAnimationFrame = requestAnimationFrame(tick);
  }

  function getTheme(type) {
    return THEMES[type] || THEMES[IDS.bridge];
  }

  function normalizeNodeSource(nodeData) {
    if (!nodeData) return;
    nodeData.python_module = "custom_nodes.tunan-paint-bridge";
    if (!nodeData.nodeSource || typeof nodeData.nodeSource !== "object") {
      nodeData.nodeSource = {
        type: "custom_nodes",
        className: "comfy-custom-nodes",
      };
    }
    nodeData.nodeSource.displayText = "";
    nodeData.nodeSource.badgeText = "";
  }

  function getMinSize(type) {
    return MIN_SIZE[type] || [280, 220];
  }

  function getEffectiveMinSize(node) {
    const [baseWidth, baseHeight] = getMinSize(node.comfyClass);
    if (MAIN_IDS.has(node.comfyClass)) {
      return [baseWidth, baseHeight];
    }

    const metrics = getToolMetrics(node);
    return [baseWidth, Math.max(baseHeight, metrics.minHeight)];
  }

  function clampNodeSize(node) {
    const [minWidth, minHeight] = getEffectiveMinSize(node);
    node.size[0] = Math.max(node.size[0] || 0, minWidth);
    node.size[1] = Math.max(node.size[1] || 0, minHeight);
  }

  function getWidgetsBottom(node) {
    let bottom = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;

    if (Array.isArray(node.inputs) && node.inputs.length > 0) {
      const slotHeight = (window.LiteGraph && LiteGraph.NODE_SLOT_HEIGHT) || 20;
      bottom = Math.max(bottom, 30 + node.inputs.length * slotHeight + 8);
    }

    if (Array.isArray(node.widgets) && node.widgets.length > 0) {
      for (const widget of node.widgets) {
        if (!widget || widget.last_y == null) continue;
        const widgetHeight = widget.computeSize ? widget.computeSize()[1] : 22;
        bottom = Math.max(bottom, widget.last_y + widgetHeight + 6);
      }
    }

    return bottom;
  }

  function getBridgeConnectionState() {
    const raw = STATE.bridge?.connection_info || STATE.bridge || {};
    const parameters = STATE.bridge?.parameters || raw.parameters || {};
    const execution = STATE.bridge?.execution_status || raw.execution_status || {};
    const imageInfo = STATE.bridge?.image_info || raw.image_info || {};
    const bridgeContext = STATE.bridge?.bridge_context || raw.bridge_context || {};
    const connected = Boolean(
      raw.connected ||
      raw.websocket_connected ||
      raw.ps_connected ||
      STATE.bridge?.connected
    );

    return {
      connected,
      parameters,
      execution,
      hasImage: Boolean(raw.has_image || STATE.bridge?.has_image),
      sourceText: getBridgeSourceText(bridgeContext, imageInfo),
      clientCount: raw.client_count || 0,
      statusText: connected ? "已连接" : "未连接",
    };
  }

  function getSenderState() {
    const raw = STATE.sender || {};
    const ready = Boolean(raw.has_preview || raw.has_image);
    const generationTime =
      typeof raw.generation_time === "number" && raw.generation_time > 0.05
        ? raw.generation_time
        : null;
    return {
      ready,
      generationTime,
      vramUsed: typeof raw.vram_used === "number" ? raw.vram_used : null,
      fileSize: raw.file_size || null,
      sentToPs: Boolean(raw.sent_to_ps),
      deliveryText: getSenderDeliveryText(raw),
    };
  }

  function mergeBridgeState(patch = {}) {
    if (!patch || typeof patch !== "object") return;
    const next = {
      ...(STATE.bridge && typeof STATE.bridge === "object" ? STATE.bridge : {}),
      ...patch,
    };

    if (patch.connection_info && typeof patch.connection_info === "object") {
      next.connection_info = {
        ...(STATE.bridge?.connection_info || {}),
        ...patch.connection_info,
      };
    }

    if (patch.parameters && typeof patch.parameters === "object") {
      next.parameters = {
        ...(STATE.bridge?.parameters || {}),
        ...patch.parameters,
      };
    }

    if (patch.image_info && typeof patch.image_info === "object") {
      next.image_info = {
        ...(STATE.bridge?.image_info || {}),
        ...patch.image_info,
      };
    }

    if (patch.bridge_context && typeof patch.bridge_context === "object") {
      next.bridge_context = {
        ...(STATE.bridge?.bridge_context || {}),
        ...patch.bridge_context,
      };
    }

    if (patch.execution_status && typeof patch.execution_status === "object") {
      next.execution_status = {
        ...(STATE.bridge?.execution_status || {}),
        ...patch.execution_status,
      };
    }

    if (patch.receive_status && typeof patch.receive_status === "object") {
      next.receive_status = {
        ...(STATE.bridge?.receive_status || {}),
        ...patch.receive_status,
      };
    }

    STATE.bridge = next;
  }

  function getBridgeReceiveVisualState() {
    const raw = STATE.bridge?.receive_status || {};
    const now = performance.now();
    const isReceiving = Boolean(raw.is_receiving);
    const progress = Math.max(0, Math.min(100, Number(raw.progress || 0)));
    const isError = raw.phase === "error";
    const receivedAtMs = Number(raw.received_at || 0) * 1000;
    const isRecentlyReceived =
      raw.phase === "received" &&
      receivedAtMs > 0 &&
      Date.now() - receivedAtMs <= RECEIVE_FLASH_DURATION_MS;
    const isReceived = STATE.bridgeReceiveFlashUntil > now || isRecentlyReceived;
    const remainingRatio = isReceived
      ? Math.max(0, STATE.bridgeReceiveFlashUntil - now) / RECEIVE_FLASH_DURATION_MS
      : 0;
    const pulse = isReceived
      ? 0.5 + 0.5 * Math.sin((1 - remainingRatio) * Math.PI * 4)
      : 0;

    return {
      isReceiving: isReceiving && !isReceived && !isError,
      progress,
      isReceived,
      isError,
      errorMessage: String(raw.error_message || ""),
      pulse,
    };
  }

  function mergeSenderState(patch = {}) {
    if (!patch || typeof patch !== "object") return;
    if (patch.has_preview === false && patch.has_image === false) {
      STATE.sender = { ...patch };
      STATE.senderSource = null;
      STATE.senderSourcePromise = null;
      return;
    }
    const previousSourceToken = Number(STATE.sender?.source_token || 0);
    STATE.sender = {
      ...(STATE.sender && typeof STATE.sender === "object" ? STATE.sender : {}),
      ...patch,
    };
    const nextSourceToken = Number(STATE.sender?.source_token || 0);
    if (
      previousSourceToken > 0 &&
      nextSourceToken > 0 &&
      previousSourceToken !== nextSourceToken
    ) {
      STATE.senderSource = null;
      STATE.senderSourcePromise = null;
    }
  }

  function getSenderNodeIds() {
    const app = getRuntimeApp();
    const nodes = app?.graph?._nodes || [];
    const ids = [];
    for (const node of nodes) {
      if (node?.comfyClass === IDS.sender && node.id != null) {
        ids.push(node.id);
      }
    }
    return ids;
  }

  function isSenderExecutionEvent(event) {
    const detail = event?.detail;
    const nodeId =
      typeof detail === "number"
        ? detail
        : detail && typeof detail === "object"
          ? detail.node
          : null;

    if (nodeId == null) {
      return false;
    }

    const app = getRuntimeApp();
    const node = typeof app?.graph?.getNodeById === "function" ? app.graph.getNodeById(nodeId) : null;
    if (node?.comfyClass === IDS.sender) {
      return true;
    }

    return getSenderNodeIds().includes(nodeId);
  }

  async function updateExecutionTimeFromFrontend(executionTime) {
    if (!Number.isFinite(executionTime) || executionTime <= 0) {
      return;
    }

    try {
      await fetch("/tunan/ps/update_execution_time", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          execution_time: executionTime,
        }),
      });
    } catch (_) {}
  }

  function markSenderExecutionStart() {
    STATE.senderExecutionStartedAt = performance.now();
  }

  function getSenderWidget(node, widgetName) {
    if (!node || !Array.isArray(node.widgets)) {
      return null;
    }
    return node.widgets.find((widget) => widget?.name === widgetName) || null;
  }

  function getSenderAdjustPayload(node) {
    const returnMode = getSenderWidget(node, SENDER_RETURN_MODE_NAME)?.value || "选区还原模式";
    const edgeShrink = Number.parseInt(getSenderWidget(node, SENDER_EDGE_SHRINK_NAME)?.value ?? 0, 10);
    const edgeFeather = Number.parseInt(getSenderWidget(node, SENDER_EDGE_FEATHER_NAME)?.value ?? 0, 10);

    return {
      return_mode: String(returnMode || "选区还原模式"),
      edge_shrink: Number.isFinite(edgeShrink) ? Math.max(0, edgeShrink) : 0,
      edge_feather: Number.isFinite(edgeFeather) ? Math.max(0, edgeFeather) : 0,
    };
  }

  function createCanvasElement(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width || 1));
    canvas.height = Math.max(1, Math.round(height || 1));
    return canvas;
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      if (!src) {
        resolve(null);
        return;
      }

      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image load failed"));
      image.src = src;
    });
  }

  function getPrimarySenderNode() {
    const app = getRuntimeApp();
    const nodes = app?.graph?._nodes || [];
    return nodes.find((node) => node?.comfyClass === IDS.sender) || null;
  }

  async function ensureSenderSourceState(force = false) {
    const senderState = STATE.sender || {};
    const sourceToken = Number(senderState.source_token || 0);
    const cached = STATE.senderSource;

    if (
      !force &&
      cached &&
      Number(cached.sourceToken || 0) === sourceToken &&
      cached.image &&
      (!cached.hasSelection || cached.selectionMask)
    ) {
      return cached;
    }

    if (!force && STATE.senderSourcePromise) {
      return STATE.senderSourcePromise;
    }

    const promise = (async () => {
      const result = await fetchJson("/tunan/ps/sender_source_state");
      if (!result || result.status === "empty" || !result.has_source || !result.image_data_url) {
        STATE.senderSource = null;
        return null;
      }

      const [image, selectionMask, contentAlpha] = await Promise.all([
        loadImageElement(result.image_data_url),
        result.selection_mask_data_url ? loadImageElement(result.selection_mask_data_url) : Promise.resolve(null),
        result.content_alpha_data_url ? loadImageElement(result.content_alpha_data_url) : Promise.resolve(null),
      ]);

      const selectionMaskCanvas =
        selectionMask && result.has_selection
          ? drawableToAlphaMaskCanvas(
              selectionMask,
              Number(result.image_width || image?.naturalWidth || 0),
              Number(result.image_height || image?.naturalHeight || 0)
            )
          : null;
      const contentAlphaCanvas =
        contentAlpha && result.has_content_alpha
          ? drawableToAlphaMaskCanvas(
              contentAlpha,
              Number(result.image_width || image?.naturalWidth || 0),
              Number(result.image_height || image?.naturalHeight || 0)
            )
          : null;
      const selectionBaseBBox = selectionMaskCanvas ? maskCanvasToBBox(selectionMaskCanvas) : null;
      const selectionMaskLocalCanvas =
        selectionMaskCanvas && selectionBaseBBox
          ? cropCanvasToBBox(selectionMaskCanvas, selectionBaseBBox)
          : selectionMaskCanvas;
      const contentAlphaLocalCanvas =
        contentAlphaCanvas && selectionBaseBBox
          ? cropCanvasToBBox(contentAlphaCanvas, selectionBaseBBox)
          : contentAlphaCanvas;

      const next = {
        sourceToken: Number(result.source_token || sourceToken || Date.now()),
        width: Number(result.image_width || image?.naturalWidth || 0),
        height: Number(result.image_height || image?.naturalHeight || 0),
        hasSelection: Boolean(result.has_selection && selectionMask),
        hasContentAlpha: Boolean(result.has_content_alpha && contentAlpha),
        image,
        selectionMask,
        contentAlpha,
        selectionMaskCanvas,
        contentAlphaCanvas,
        selectionBaseBBox,
        selectionMaskLocalCanvas,
        contentAlphaLocalCanvas,
      };
      STATE.senderSource = next;
      return next;
    })();

    STATE.senderSourcePromise = promise;
    try {
      return await promise;
    } finally {
      if (STATE.senderSourcePromise === promise) {
        STATE.senderSourcePromise = null;
      }
    }
  }

  function drawableToAlphaMaskCanvas(drawable, width, height) {
    const canvas = createCanvasElement(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(drawable, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
      const rgbValue = Math.max(data[index], data[index + 1], data[index + 2]);
      const alphaFactor = data[index + 3] / 255;
      const value = Math.round(rgbValue * alphaFactor);
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = value;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function maskCanvasToBBox(maskCanvas, threshold = 1) {
    if (!maskCanvas) {
      return null;
    }

    const ctx = maskCanvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = maskCanvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const alphaThreshold = Math.max(0, Math.min(255, Math.round(Number(threshold || 0))));

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha <= alphaThreshold) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX + 1),
      height: Math.max(1, maxY - minY + 1),
    };
  }

  function fitDrawableToBBoxCanvas(drawable, bbox, canvasWidth, canvasHeight) {
    if (!drawable || !bbox) {
      return drawable;
    }

    const output = createCanvasElement(canvasWidth, canvasHeight);
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(
      drawable,
      Math.round(bbox.x || 0),
      Math.round(bbox.y || 0),
      Math.max(1, Math.round(bbox.width || 1)),
      Math.max(1, Math.round(bbox.height || 1))
    );
    return output;
  }

  function fitDrawableToLocalSize(drawable, width, height) {
    if (!drawable) {
      return null;
    }

    const output = createCanvasElement(width, height);
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(drawable, 0, 0, output.width, output.height);
    return output;
  }

  function cropCanvasToBBox(sourceCanvas, bbox) {
    if (!sourceCanvas || !bbox) {
      return null;
    }

    const x = Math.max(0, Math.round(bbox.x || 0));
    const y = Math.max(0, Math.round(bbox.y || 0));
    const width = Math.max(1, Math.round(bbox.width || 1));
    const height = Math.max(1, Math.round(bbox.height || 1));
    const output = createCanvasElement(width, height);
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);
    return output;
  }

  function blurMaskCanvas(sourceCanvas, radius) {
    if (!(radius > 0)) {
      return sourceCanvas;
    }

    const output = createCanvasElement(sourceCanvas.width, sourceCanvas.height);
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.filter = `blur(${Math.max(0.5, radius)}px)`;
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.filter = "none";
    return output;
  }

  function thresholdMaskCanvas(sourceCanvas, threshold = 0.5, softness = 0.08) {
    const output = createCanvasElement(sourceCanvas.width, sourceCanvas.height);
    const srcCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    const outCtx = output.getContext("2d");
    const imageData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const data = imageData.data;
    const thresholdValue = Math.max(0, Math.min(1, Number(threshold || 0)));
    const softnessValue = Math.max(0.0001, Number(softness || 0.0001));

    for (let index = 0; index < data.length; index += 4) {
      const value = data[index + 3] / 255;
      let mapped = (value - thresholdValue) / softnessValue;
      mapped = Math.max(0, Math.min(1, mapped));
      mapped = mapped * mapped * (3 - 2 * mapped);
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = Math.round(mapped * 255);
    }

    outCtx.putImageData(imageData, 0, 0);
    return output;
  }

  function getSelectionShrinkThreshold(shrinkPx) {
    const shrink = Math.max(0, Number(shrinkPx || 0));
    if (shrink <= 0) {
      return 0.5;
    }
    return Math.max(0.54, Math.min(0.92, 0.5 + (shrink / (shrink + 18)) * 0.36));
  }

  function buildRectMaskCanvas(width, height, edgeShrink, edgeFeather) {
    const canvas = createCanvasElement(width, height);
    const ctx = canvas.getContext("2d");
    const inset = Math.max(0, Math.round(edgeShrink || 0));
    const rectWidth = Math.max(1, width - inset * 2);
    const rectHeight = Math.max(1, height - inset * 2);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(inset, inset, rectWidth, rectHeight);

    if (edgeFeather > 0) {
      return blurMaskCanvas(canvas, edgeFeather);
    }
    return canvas;
  }

  function buildSelectionMaskCanvas(sourceState, edgeShrink, edgeFeather) {
    if (!(sourceState?.width > 0) || !(sourceState.height > 0)) {
      return buildRectMaskCanvas(sourceState?.width || 1, sourceState?.height || 1, edgeShrink, edgeFeather);
    }

    let maskCanvas = sourceState.selectionMaskCanvas;
    if (!maskCanvas && sourceState.selectionMask) {
      maskCanvas = drawableToAlphaMaskCanvas(sourceState.selectionMask, sourceState.width, sourceState.height);
    }
    if (!maskCanvas) {
      return buildRectMaskCanvas(sourceState.width, sourceState.height, edgeShrink, edgeFeather);
    }

    if (edgeShrink > 0) {
      const shrinkBlur = blurMaskCanvas(maskCanvas, Math.max(0.8, edgeShrink * 0.9));
      maskCanvas = thresholdMaskCanvas(shrinkBlur, getSelectionShrinkThreshold(edgeShrink), 0.08);
    }

    if (edgeFeather > 0) {
      maskCanvas = blurMaskCanvas(maskCanvas, edgeFeather);
    }

    return maskCanvas;
  }

  function combineMaskCanvases(...maskCanvases) {
    const validMasks = maskCanvases.filter(
      (maskCanvas) => maskCanvas && maskCanvas.width > 0 && maskCanvas.height > 0
    );
    if (!validMasks.length) {
      return null;
    }

    const output = createCanvasElement(validMasks[0].width, validMasks[0].height);
    const ctx = output.getContext("2d");
    ctx.clearRect(0, 0, output.width, output.height);
    ctx.drawImage(validMasks[0], 0, 0, output.width, output.height);

    for (let index = 1; index < validMasks.length; index += 1) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(validMasks[index], 0, 0, output.width, output.height);
    }

    ctx.globalCompositeOperation = "source-over";
    return output;
  }

  function renderLocalSenderPreview(node, options = {}) {
    const sourceState = STATE.senderSource;
    if (!node || !sourceState?.image || !(sourceState.width > 0) || !(sourceState.height > 0)) {
      return false;
    }

    const payload = getSenderAdjustPayload(node);
    const useSelection =
      payload.return_mode === "选区还原模式" &&
      Boolean(sourceState.hasSelection && sourceState.selectionMask);

    const processedSelectionMask = useSelection
      ? buildSelectionMaskCanvas(sourceState, payload.edge_shrink, payload.edge_feather)
      : null;
    debugLog("sender_preview_render", {
      requestedMode: payload.return_mode,
      useSelection,
      hasSelection: Boolean(sourceState.hasSelection),
      hasSelectionMask: Boolean(sourceState.selectionMask),
      sourceWidth: sourceState.width,
      sourceHeight: sourceState.height,
    });
    const previewWidth = sourceState.width;
    const previewHeight = sourceState.height;
    const previewImage = sourceState.image;
    const returnMaskCanvas = useSelection
      ? processedSelectionMask
      : buildRectMaskCanvas(sourceState.width, sourceState.height, payload.edge_shrink, payload.edge_feather);
    const contentMaskCanvas = sourceState.contentAlphaCanvas;
    const maskCanvas = useSelection
      ? combineMaskCanvases(returnMaskCanvas, contentMaskCanvas)
      : combineMaskCanvases(returnMaskCanvas, sourceState.contentAlphaCanvas);

    const outputCanvas = createCanvasElement(previewWidth, previewHeight);
    const ctx = outputCanvas.getContext("2d");
    ctx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    ctx.drawImage(previewImage, 0, 0, outputCanvas.width, outputCanvas.height);
    if (maskCanvas) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(maskCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
      ctx.globalCompositeOperation = "source-over";
    }

    STATE.senderImage = outputCanvas;
    STATE.senderSizeText = formatSizeText(previewWidth, previewHeight);
    node.__tunanLastSenderAdjustKey = JSON.stringify(payload);

    const markDirtyPreview = Boolean(options.markDirtyPreview);
    const previewMessage =
      payload.return_mode === "选区还原模式" && !useSelection
        ? "当前无选区，已按整图预览"
        : markDirtyPreview
          ? "当前仅预览，点重新发送"
          : undefined;

    mergeSenderState({
      has_preview: true,
      has_image: true,
      image_width: previewWidth,
      image_height: previewHeight,
      return_mode: useSelection ? "选区还原模式" : "整图模式",
      requested_return_mode: payload.return_mode === "选区还原模式" ? "选区还原模式" : "整图模式",
      selection_restore_active: Boolean(useSelection),
      edge_shrink_px: payload.edge_shrink,
      edge_feather_px: payload.edge_feather,
      mode_hint: payload.return_mode === "选区还原模式" && !useSelection ? "当前无选区，已按整图处理" : "",
      ...(markDirtyPreview
        ? {
            sent_to_ps: false,
            message: previewMessage,
            delivery_mode: "adjust_preview",
          }
        : previewMessage
          ? {
              message: previewMessage,
            }
          : {}),
    });
    markCanvasDirty();
    return true;
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });

    if (!response.ok) {
      throw new Error(`${url} -> ${response.status}`);
    }

    return response.json();
  }

  async function applySenderPreviewAdjust(node, force = false) {
    if (!node) {
      return;
    }

    const payload = getSenderAdjustPayload(node);
    const requestKey = JSON.stringify(payload);
    if (!force && node.__tunanLastSenderAdjustKey === requestKey) {
      return;
    }

    try {
      const sourceState = await ensureSenderSourceState(false);
      if (sourceState) {
        renderLocalSenderPreview(node, { markDirtyPreview: true });
        return;
      }
    } catch (_) {}

    const requestId = ++STATE.senderAdjustRequestId;
    try {
      const result = await postJson("/tunan/ps/sender_adjust_preview", payload);
      if (requestId !== STATE.senderAdjustRequestId) {
        return;
      }
      if (result && typeof result === "object" && result.status !== "error" && result.status !== "empty") {
        node.__tunanLastSenderAdjustKey = requestKey;
        mergeSenderState(result);
        STATE.lastSenderToken = null;
        refreshSenderPreview();
        markCanvasDirty();
      }
    } catch (_) {}
  }

  function scheduleSenderPreviewAdjust(node, delay = 32, force = false) {
    if (STATE.senderSource?.image) {
      STATE.senderPreviewPendingNode = node;
      STATE.senderPreviewPendingForce = Boolean(STATE.senderPreviewPendingForce || force);
      if (STATE.senderPreviewFrame) {
        return;
      }
      STATE.senderPreviewFrame = window.requestAnimationFrame(() => {
        const pendingNode = STATE.senderPreviewPendingNode;
        const pendingForce = STATE.senderPreviewPendingForce;
        STATE.senderPreviewFrame = 0;
        STATE.senderPreviewPendingNode = null;
        STATE.senderPreviewPendingForce = false;
        applySenderPreviewAdjust(pendingNode, pendingForce);
      });
      return;
    }

    if (STATE.senderAdjustDebounce) {
      window.clearTimeout(STATE.senderAdjustDebounce);
      STATE.senderAdjustDebounce = null;
    }

    STATE.senderAdjustDebounce = window.setTimeout(() => {
      STATE.senderAdjustDebounce = null;
      applySenderPreviewAdjust(node, force);
    }, delay);
  }

  async function resendCurrentSenderPreview(node) {
    if (!node) {
      return;
    }

    const payload = getSenderAdjustPayload(node);
    try {
      const result = await postJson("/tunan/ps/sender_resend_current", payload);
      if (result && typeof result === "object" && result.status !== "error" && result.status !== "empty") {
        node.__tunanLastSenderAdjustKey = JSON.stringify(payload);
        mergeSenderState(result);
        STATE.lastSenderToken = null;
        refreshSenderPreview();
        markCanvasDirty();
      }
    } catch (_) {}
  }

  function calculateMainLayout(node) {
    const statusBarHeight = node.comfyClass === IDS.sender ? 24 : 30;
    const sizeBarHeight = 20;
    const previewPadding = 10;
    const senderWidgetCount =
      node.comfyClass === IDS.sender && Array.isArray(node.widgets)
        ? node.widgets.filter(Boolean).length
        : 0;
    const senderWidgetSpacing = 30;
    const senderWidgetHeight = 22;
    const senderWidgetTopGap = senderWidgetCount > 0 ? 14 : 0;
    const senderWidgetBottomGap = senderWidgetCount > 0 ? 8 : 0;
    const senderWidgetContentHeight =
      senderWidgetCount > 0
        ? (senderWidgetCount - 1) * senderWidgetSpacing + senderWidgetHeight
        : 0;
    const senderWidgetAreaHeight =
      senderWidgetCount > 0
        ? senderWidgetTopGap + senderWidgetContentHeight + senderWidgetBottomGap
        : 0;
    const previewY = statusBarHeight + previewPadding;
    const previewHeight = Math.max(
      node.size[1] - statusBarHeight - sizeBarHeight - previewPadding * 2 - senderWidgetAreaHeight,
      120
    );
    const previewBottom = previewY + previewHeight;

    return {
      statusBarHeight,
      sizeBarHeight,
      previewX: previewPadding,
      previewY,
      previewW: Math.max(node.size[0] - previewPadding * 2, 40),
      previewH: previewHeight,
      previewBottom,
      widgetsStartY: previewBottom + senderWidgetTopGap,
      widgetSpacing: senderWidgetSpacing,
      widgetHeight: senderWidgetHeight,
      widgetCount: senderWidgetCount,
      sizeBarY: node.size[1] - sizeBarHeight,
    };
  }

  function splitToolSlots(node) {
    normalizeToolWidgetInputs(node);

    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
    const outputs = Array.isArray(node.outputs) ? node.outputs : [];

    return {
      realInputs: inputs.filter((input) => input && !input.widget),
      widgetInputs: inputs.filter((input) => input && input.widget),
      outputs: outputs.filter(Boolean),
    };
  }

  function normalizeToolWidgetInputs(node) {
    if (!Array.isArray(node.inputs) || !Array.isArray(node.widgets) || node.widgets.length === 0) {
      return;
    }

    const validWidgetNames = new Set(node.widgets.map((widget) => widget?.name).filter(Boolean));
    const seenWidgetInputs = new Set();

    node.inputs = node.inputs.filter((input) => {
      if (!input || !input.widget) {
        return true;
      }

      const widgetName = input.widget?.name || input.name;
      if (!validWidgetNames.has(widgetName) || seenWidgetInputs.has(widgetName)) {
        return false;
      }

      seenWidgetInputs.add(widgetName);
      return true;
    });
  }

  function getToolMetrics(node) {
    const { realInputs, widgetInputs, outputs } = splitToolSlots(node);
    const actualHeight = Math.max(node.size?.[1] || 0, 0);
    const widgetCount = Math.max(node.widgets?.length || 0, widgetInputs.length);
    const slotBaseStartY = TOOL_LAYOUT.contentTop + TOOL_LAYOUT.slotPad;
    const portsAreaHeight = TOOL_LAYOUT.portsAreaHeight;
    const baseWidgetContentHeight = widgetCount > 0
      ? (widgetCount - 1) * TOOL_LAYOUT.widgetSpacing + TOOL_LAYOUT.widgetHeight
      : 0;
    const minHeight =
      slotBaseStartY +
      portsAreaHeight +
      TOOL_LAYOUT.controlsTopPad +
      baseWidgetContentHeight +
      TOOL_LAYOUT.gapBeforeFooter +
      TOOL_LAYOUT.footerHeight +
      TOOL_LAYOUT.bottomPad;
    const resolvedHeight = Math.max(actualHeight, minHeight);
    const extra = Math.max(0, resolvedHeight - minHeight);
    const widgetSpacing = TOOL_LAYOUT.widgetSpacing + Math.min(extra * 0.032, 10);
    const widgetContentHeight = widgetCount > 0
      ? (widgetCount - 1) * widgetSpacing + TOOL_LAYOUT.widgetHeight
      : 0;
    const slotStartY = slotBaseStartY;
    const controlsTopPad = TOOL_LAYOUT.controlsTopPad + Math.min(extra * 0.12, 28);
    const bottomPad = TOOL_LAYOUT.bottomPad + Math.min(extra * 0.045, 10);
    const footerHeight = Math.min(TOOL_LAYOUT.footerHeight + extra * 0.28, TOOL_LAYOUT.footerMaxHeight);
    const slotRegionBottom = slotStartY + portsAreaHeight;
    const widgetsStartY = slotRegionBottom + controlsTopPad;
    const widgetsBottom = widgetContentHeight > 0 ? widgetsStartY + widgetContentHeight : widgetsStartY;
    const footerTop = resolvedHeight - bottomPad - footerHeight;
    const gapBeforeFooter = Math.max(TOOL_LAYOUT.gapBeforeFooter, footerTop - widgetsBottom);
    const dividerY = slotRegionBottom;

    return {
      realInputs,
      widgetInputs,
      outputs,
      slotStartY,
      slotBottom: slotRegionBottom,
      portsAreaHeight,
      widgetSpacing,
      widgetsStartY,
      widgetsBottom,
      dividerY,
      controlsTopPad,
      footerTop,
      footerHeight,
      bottomPad,
      minHeight,
    };
  }

  function layoutToolNode(node) {
    normalizeMainNodePorts(node);
    const metrics = getToolMetrics(node);
    const getCenteredStartY = (count) => {
      if (!count || count <= 0) {
        return metrics.slotStartY + metrics.portsAreaHeight / 2 - TOOL_LAYOUT.slotVisualLift;
      }
      const contentHeight = (count - 1) * TOOL_LAYOUT.slotSpacing;
      return (
        metrics.slotStartY +
        Math.max(0, (metrics.portsAreaHeight - contentHeight) / 2) -
        TOOL_LAYOUT.slotVisualLift
      );
    };
    const inputStartY = getCenteredStartY(metrics.realInputs.length);
    const outputStartY = getCenteredStartY(metrics.outputs.length);

    metrics.realInputs.forEach((input, index) => {
      input.pos = [TOOL_LAYOUT.portInset, inputStartY + index * TOOL_LAYOUT.slotSpacing];
    });

    metrics.outputs.forEach((output, index) => {
      output.pos = [node.size[0] - TOOL_LAYOUT.portInset, outputStartY + index * TOOL_LAYOUT.slotSpacing];
    });

    if (Array.isArray(node.widgets)) {
      node.widgets.forEach((widget, index) => {
        if (!widget) return;
        const y = metrics.widgetsStartY + index * metrics.widgetSpacing;
        widget.y = y;
        widget.last_y = y;
      });
    }

    metrics.widgetInputs.forEach((input, index) => {
      const centerY = metrics.widgetsStartY + index * metrics.widgetSpacing + TOOL_LAYOUT.widgetHeight / 2;
      input.pos = [TOOL_LAYOUT.widgetInputX, centerY];
    });

    node.widgets_start_y = metrics.widgetsStartY;
    return metrics;
  }

  function drawToolNodeAccent(ctx, node) {
    const theme = getTheme(node.comfyClass);
    const layout = layoutToolNode(node);

    ctx.save();
    ctx.fillStyle = theme.accentStrong;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(0, 0, Math.min(node.size[0] * 0.24, 74), 2);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(14, layout.dividerY);
    ctx.lineTo(node.size[0] - 14, layout.dividerY);
    ctx.stroke();
    ctx.restore();

    if (node.size[1] < layout.minHeight - 6) {
      return;
    }

    const panelHeight = Math.min(layout.footerHeight, node.size[1] - layout.footerTop - layout.bottomPad);
    const panelY = layout.footerTop;
    const panelX = 12;
    const panelW = node.size[0] - 24;

    fillRounded(ctx, panelX, panelY, panelW, panelHeight, 12, "rgba(255,255,255,0.018)");
    strokeRounded(ctx, panelX, panelY, panelW, panelHeight, 12, theme.line);
    fillRounded(ctx, panelX, panelY + 8, 2.5, panelHeight - 16, 2, theme.accentStrong);

    drawText(ctx, DISPLAY[node.comfyClass] || PRODUCT_NAME, panelX + 14, panelY + 18, {
      color: theme.text,
      font: `bold 11.5px ${FONT_FAMILY}`,
    });

    drawText(ctx, DESCRIPTIONS[node.comfyClass] || PRODUCT_NAME, panelX + 14, panelY + 40, {
      color: theme.muted,
      font: `10px ${FONT_FAMILY}`,
    });
  }

  function drawPreviewPanel(ctx, node, theme, image, sizeText) {
    const layout = calculateMainLayout(node);
    const { previewX, previewY, previewW, previewH } = layout;
    const radius = 8;

    fillRounded(ctx, previewX, previewY, previewW, previewH, radius, theme.preview);
    strokeRounded(ctx, previewX, previewY, previewW, previewH, radius, theme.previewBorder);

    const imageWidth = Number(image?.naturalWidth || image?.videoWidth || image?.width || 0);
    const imageHeight = Number(image?.naturalHeight || image?.videoHeight || image?.height || 0);
    const imageReady = Boolean(image && imageWidth > 0 && imageHeight > 0 && (image.complete !== false));

    if (imageReady) {
      const imageRatio = imageWidth / imageHeight;
      const panelRatio = previewW / previewH;

      let drawWidth, drawHeight, drawX, drawY;
      if (imageRatio > panelRatio) {
        drawWidth = previewW;
        drawHeight = drawWidth / imageRatio;
        drawX = previewX;
        drawY = previewY + (previewH - drawHeight) / 2;
      } else {
        drawHeight = previewH;
        drawWidth = drawHeight * imageRatio;
        drawX = previewX + (previewW - drawWidth) / 2;
        drawY = previewY;
      }
      ctx.save();
      clipRounded(ctx, previewX, previewY, previewW, previewH, radius);
      ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
      ctx.restore();

      return layout;
    }

    const cx = previewX + previewW / 2;
    const cy = previewY + previewH / 2;
    const title = node.comfyClass === IDS.bridge ? "等待 Photoshop 图像" : "等待生成结果";
    const subtitle =
      node.comfyClass === IDS.bridge
        ? "发送后会在这里显示预览"
        : "工作流完成后会在这里显示预览";
    drawText(ctx, title, cx, cy - 8, {
      color: SURFACE.placeholderText,
      font: `bold 13px ${FONT_FAMILY}`,
      align: "center",
      baseline: "middle",
    });

    drawText(ctx, subtitle, cx, cy + 16, {
      color: SURFACE.placeholderSub,
      font: `10px ${FONT_FAMILY}`,
      align: "center",
      baseline: "middle",
    });

    drawText(ctx, "图南绘画工作室", cx, previewY + previewH - 16, {
      color: "rgba(140,148,160,0.34)",
      font: `10px ${FONT_FAMILY}`,
      align: "center",
      baseline: "middle",
    });

    return layout;
  }

  function drawBridgeStatusBar(ctx, node) {
    const theme = getTheme(node.comfyClass);
    const layout = calculateMainLayout(node);
    const state = getBridgeConnectionState();
    const execution = state.execution;
    const receiveVisual = getBridgeReceiveVisualState();
    const isConnected = state.connected;
    const connectedRgb = "90,214,136";
    const connectedColor = "#63d88e";
    const dangerRgb = theme.dangerRgb || "240,118,118";
    const barRgb = isConnected ? connectedRgb : dangerRgb;
    const barColor = isConnected ? connectedColor : theme.danger;

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.018)";
    ctx.fillRect(0, 0, node.size[0], layout.statusBarHeight);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, layout.statusBarHeight - 0.5);
    ctx.lineTo(node.size[0], layout.statusBarHeight - 0.5);
    ctx.stroke();
    ctx.restore();

    // 左侧 accent 竖条
    ctx.save();
    ctx.fillStyle = barColor;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(0, 6, 2, layout.statusBarHeight - 12);
    ctx.globalAlpha = 1;
    ctx.restore();

    const midY = layout.statusBarHeight / 2;
    const dotX = 15;

    const dotOuterRgb = receiveVisual.isError
      ? "255,107,107"
      : receiveVisual.isReceiving
      ? "113,184,255"
      : receiveVisual.isReceived
        ? "109,255,175"
        : barRgb;
    const dotInnerColor = receiveVisual.isError
      ? "#ff6b6b"
      : receiveVisual.isReceiving
      ? "#71b8ff"
      : receiveVisual.isReceived
        ? "#6dffaf"
        : barColor;
    const dotOuterAlpha = receiveVisual.isError
      ? 0.24
      : receiveVisual.isReceiving
      ? 0.22
      : receiveVisual.isReceived
        ? 0.16 + receiveVisual.pulse * 0.18
        : 0.12;
    const dotOuterRadius = receiveVisual.isError
      ? 6.5
      : receiveVisual.isReceiving
      ? 6.5
      : receiveVisual.isReceived
        ? 5.5 + receiveVisual.pulse * 1.2
        : 5;
    const dotInnerRadius = receiveVisual.isError
      ? 3
      : receiveVisual.isReceiving
      ? 3
      : receiveVisual.isReceived
        ? 2.5 + receiveVisual.pulse * 0.5
        : 2.5;

    ctx.save();
    ctx.fillStyle = `rgba(${dotOuterRgb}, ${dotOuterAlpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(dotX, midY, dotOuterRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    if (receiveVisual.isReceiving || receiveVisual.isReceived || receiveVisual.isError) {
      ctx.shadowColor = receiveVisual.isError
        ? "rgba(255,107,107,0.65)"
        : receiveVisual.isReceiving
        ? "rgba(113,184,255,0.75)"
        : `rgba(109,255,175, ${(0.55 + receiveVisual.pulse * 0.2).toFixed(3)})`;
      ctx.shadowBlur = receiveVisual.isError ? 8 : receiveVisual.isReceiving ? 8 : 10 + receiveVisual.pulse * 6;
    }
    ctx.fillStyle = dotInnerColor;
    ctx.beginPath();
    ctx.arc(dotX, midY, dotInnerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const statusText = receiveVisual.isError
      ? "接收失败"
      : receiveVisual.isReceiving
      ? "接收中"
      : receiveVisual.isReceived
        ? "已接收"
        : state.statusText;
    const statusColor = receiveVisual.isError
      ? "#ff6b6b"
      : receiveVisual.isReceiving
      ? "#71b8ff"
      : receiveVisual.isReceived
        ? "#6dffaf"
        : (isConnected ? connectedColor : theme.danger);

    ctx.save();
    if (receiveVisual.isReceived || receiveVisual.isError) {
      ctx.shadowColor = receiveVisual.isError ? "rgba(255,107,107,0.55)" : "rgba(109,255,175,0.65)";
      ctx.shadowBlur = receiveVisual.isError ? 8 : 10 + receiveVisual.pulse * 8;
    }
    drawText(ctx, statusText, dotX + 11, midY + 1, {
      color: statusColor,
      font: `bold 10.5px ${FONT_FAMILY}`,
      baseline: "middle",
    });
    ctx.restore();

    if (execution?.is_executing) {
      drawText(
        ctx,
        `执行 ${Math.round(execution.progress || 0)}%`,
        node.size[0] / 2,
        midY + 1,
        {
          color: "#e8c87a",
          font: `bold 10.5px ${FONT_FAMILY}`,
          align: "center",
          baseline: "middle",
        }
      );
    }

    if (state.hasImage && state.sourceText && !execution?.is_executing) {
      drawText(
        ctx,
        state.sourceText,
        node.size[0] - 10,
        midY + 1,
        {
          color: theme.muted,
          font: `10px ${FONT_FAMILY}`,
          align: "right",
          baseline: "middle",
        }
      );
    } else if (state.clientCount > 0 && !execution?.is_executing) {
      drawText(
        ctx,
        `${state.clientCount} 个客户端`,
        node.size[0] - 10,
        midY + 1,
        {
          color: theme.muted,
          font: `10px ${FONT_FAMILY}`,
          align: "right",
          baseline: "middle",
        }
      );
    }

    if (receiveVisual.isReceiving && receiveVisual.progress > 0 && receiveVisual.progress < 100) {
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, layout.statusBarHeight - 3, node.size[0], 3);
      ctx.fillStyle = "#71b8ff";
      ctx.fillRect(0, layout.statusBarHeight - 3, (node.size[0] * receiveVisual.progress) / 100, 3);
      ctx.restore();
    }
  }

  function drawSenderStatusBar(ctx, node) {
    const theme = getTheme(node.comfyClass);
    const layout = calculateMainLayout(node);
    const state = getSenderState();
    const isReady = state.ready;
    const accentRgb = theme.accentRgb || "72,196,140";
    const barRgb = isReady ? accentRgb : "70,70,80";
    const barColor = isReady ? theme.accentStrong : theme.muted;
    const leftText = isReady
      ? (state.generationTime != null ? `${state.generationTime.toFixed(1)}s` : "已生成")
      : "等待生成";

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.018)";
    ctx.fillRect(0, 0, node.size[0], layout.statusBarHeight);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, layout.statusBarHeight - 0.5);
    ctx.lineTo(node.size[0], layout.statusBarHeight - 0.5);
    ctx.stroke();
    ctx.restore();

    // 左侧 accent 竖条
    ctx.save();
    ctx.fillStyle = barColor;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(0, 5, 2, layout.statusBarHeight - 10);
    ctx.globalAlpha = 1;
    ctx.restore();

    const midY = layout.statusBarHeight / 2;
    const dotX = 14;

    ctx.save();
    ctx.fillStyle = `rgba(${barRgb}, 0.12)`;
    ctx.beginPath();
    ctx.arc(dotX, midY, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = barColor;
    ctx.beginPath();
    ctx.arc(dotX, midY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawText(ctx, leftText, dotX + 10, midY + 1, {
      color: isReady ? theme.text : theme.muted,
      font: `bold 10.5px ${FONT_FAMILY}`,
      baseline: "middle",
    });

    const centerParts = [];
    if (state.deliveryText) {
      centerParts.push(state.deliveryText);
    }
    if (state.vramUsed) {
      centerParts.push(`显存 ${state.vramUsed.toFixed(1)} G`);
    }
    if (centerParts.length > 0) {
      drawText(ctx, centerParts.join(" · "), node.size[0] / 2, midY + 1, {
        color: state.sentToPs ? theme.accentStrong : theme.muted,
        font: `10px ${FONT_FAMILY}`,
        align: "center",
        baseline: "middle",
      });
    }

    if (state.fileSize) {
      drawText(ctx, state.fileSize, node.size[0] - 10, midY + 1, {
        color: theme.muted,
        font: `10px ${FONT_FAMILY}`,
        align: "right",
        baseline: "middle",
      });
    }
  }

  function drawSizeBar(ctx, node, sizeText) {
    const theme = getTheme(node.comfyClass);
    const layout = calculateMainLayout(node);
    const midY = layout.sizeBarY + layout.sizeBarHeight / 2 + 1;
    const hasSize = sizeText && sizeText !== "无图像";

    ctx.save();
    ctx.fillStyle = SURFACE.sizeBar;
    ctx.fillRect(0, layout.sizeBarY, node.size[0], layout.sizeBarHeight);
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, layout.sizeBarY + 0.5);
    ctx.lineTo(node.size[0], layout.sizeBarY + 0.5);
    ctx.stroke();
    ctx.restore();

    drawText(ctx, node.comfyClass === IDS.bridge ? "图像尺寸" : "输出尺寸", 12, midY, {
      color: theme.muted,
      font: `9px ${FONT_FAMILY}`,
      baseline: "middle",
    });

    drawText(ctx, sizeText || "无图像", node.size[0] - 10, midY, {
      color: hasSize ? theme.accentStrong : theme.muted,
      font: hasSize
        ? `bold 10px 'Consolas','Courier New',monospace`
        : `10px 'Consolas','Courier New',monospace`,
      align: "right",
      baseline: "middle",
    });
  }

  function adjustConnectionPoints(node) {
    if (!MAIN_IDS.has(node.comfyClass) || node.flags?.collapsed) {
      return;
    }

    normalizeMainNodePorts(node);
    normalizeToolWidgetInputs(node);

    const layout = calculateMainLayout(node);
    const centerY = layout.previewY + layout.previewH / 2;
    const slotSpacing = 22;
    const inputs = Array.isArray(node.inputs) ? node.inputs.filter((input) => input && !input.widget) : [];
    const widgetInputs = Array.isArray(node.inputs) ? node.inputs.filter((input) => input && input.widget) : [];

    if (Array.isArray(node.outputs) && node.outputs.length > 0) {
      const startY = centerY - ((node.outputs.length - 1) * slotSpacing) / 2;
      for (let i = 0; i < node.outputs.length; i += 1) {
        if (!node.outputs[i]) continue;
        node.outputs[i].pos = [node.size[0] - TOOL_LAYOUT.portInset, startY + i * slotSpacing];
      }
    }

    if (inputs.length > 0) {
      const startY = centerY - ((inputs.length - 1) * slotSpacing) / 2;
      for (let i = 0; i < inputs.length; i += 1) {
        if (!inputs[i]) continue;
        inputs[i].pos = [TOOL_LAYOUT.portInset, startY + i * slotSpacing];
      }
    }

    if (node.comfyClass === IDS.sender && Array.isArray(node.widgets) && node.widgets.length > 0) {
      node.widgets.forEach((widget, index) => {
        if (!widget) return;
        const y = layout.widgetsStartY + index * layout.widgetSpacing;
        widget.y = y;
        widget.last_y = y;
      });

      widgetInputs.forEach((input, index) => {
        const centerWidgetY = layout.widgetsStartY + index * layout.widgetSpacing + layout.widgetHeight / 2;
        input.pos = [TOOL_LAYOUT.widgetInputX, centerWidgetY];
      });

      node.widgets_start_y = layout.widgetsStartY;
    }
  }

  function formatSizeText(width, height) {
    const w = Number(width || 0);
    const h = Number(height || 0);
    return w > 0 && h > 0 ? `${w} x ${h}` : "无图像";
  }

  function clearImage(kind, sizeText = "无图像") {
    STATE[`${kind}Image`] = null;
    STATE[`${kind}SizeText`] = sizeText;
    markCanvasDirty();
  }

  function loadImage(kind, url) {
    const requestIdKey = `${kind}ImageRequestId`;
    const requestId = (STATE[requestIdKey] || 0) + 1;
    STATE[requestIdKey] = requestId;
    const image = new Image();
    image.onload = () => {
      if (STATE[requestIdKey] !== requestId) {
        return;
      }
      STATE[`${kind}Image`] = image;
      STATE[`${kind}SizeText`] = `${image.naturalWidth} x ${image.naturalHeight}`;
      markCanvasDirty();
    };
    image.onerror = () => {
      if (STATE[requestIdKey] !== requestId) {
        return;
      }
      if (
        kind === "sender" &&
        STATE.senderImage &&
        (STATE.sender?.has_preview || STATE.sender?.has_image)
      ) {
        markCanvasDirty();
        return;
      }
      clearImage(kind, kind === "sender" ? STATE.senderSizeText : undefined);
    };
    image.src = url;
  }

  function refreshBridgePreview() {
    const bridgeState = STATE.bridge?.connection_info || STATE.bridge || {};
    const connected = Boolean(
      bridgeState.connected ||
      bridgeState.websocket_connected ||
      bridgeState.ps_connected ||
      STATE.bridge?.connected
    );
    const hasImage = Boolean(bridgeState.has_image || STATE.bridge?.has_image);
    const sizeText = formatSizeText(
      bridgeState.display_width ?? bridgeState.image_width,
      bridgeState.display_height ?? bridgeState.image_height
    );

    if (!connected) {
      STATE.lastBridgeToken = null;
      stopBridgeReceivePulse();
      clearImage("bridge", sizeText);
      return;
    }

    if (!hasImage) {
      STATE.lastBridgeToken = "waiting";
      clearImage("bridge", sizeText);
      return;
    }

    const token = JSON.stringify([
      bridgeState.image_update_id ?? STATE.bridge?.image_update_id ?? null,
      bridgeState.last_activity ?? STATE.bridge?.last_activity ?? null,
      hasImage,
    ]);

    if (STATE.lastBridgeToken === token && STATE.bridgeImage) {
      return;
    }

    STATE.lastBridgeToken = token;
    loadImage("bridge", `/tunan/ps/current_image?ts=${encodeURIComponent(token)}-${Date.now()}`);
  }

  function refreshSenderPreview() {
    const senderState = STATE.sender || {};
    const ready = Boolean(senderState.has_preview || senderState.has_image);
    const sizeText = formatSizeText(
      senderState.display_width ?? senderState.image_info?.width ?? senderState.image_width,
      senderState.display_height ?? senderState.image_info?.height ?? senderState.image_height
    );

    if (!ready) {
      STATE.lastSenderToken = "waiting";
      STATE.senderSource = null;
      STATE.senderSourcePromise = null;
      clearImage("sender", sizeText);
      return;
    }

    const token = JSON.stringify([
      senderState.preview_path ?? null,
      senderState.timestamp ?? null,
      senderState.source_token ?? null,
      senderState.image_info?.file_size ?? null,
      senderState.image_info?.width ?? null,
      senderState.image_info?.height ?? null,
      ready,
    ]);

    if (STATE.lastSenderToken === token && STATE.senderImage) {
      return;
    }

    STATE.lastSenderToken = token;

    const width = senderState.image_info?.width || senderState.image_width;
    const height = senderState.image_info?.height || senderState.image_height;
    if (width && height) {
      STATE.senderSizeText = formatSizeText(width, height);
    }

    const shouldUseLocalPreview =
      Boolean(senderState.has_adjustable_source) &&
      String(senderState.delivery_mode || "") === "adjust_preview";

    if (shouldUseLocalPreview) {
      ensureSenderSourceState(false)
        .then((sourceState) => {
          const senderNode = getPrimarySenderNode();
          if (sourceState && senderNode && renderLocalSenderPreview(senderNode, { markDirtyPreview: false })) {
            return;
          }
          loadImage("sender", `/tunan/ps/sender_preview?ts=${Date.now()}`);
        })
        .catch(() => {
          loadImage("sender", `/tunan/ps/sender_preview?ts=${Date.now()}`);
        });
      return;
    }

    loadImage("sender", `/tunan/ps/sender_preview?ts=${Date.now()}`);
  }

  async function refreshStatusOnce() {
    try {
      const [bridgeResult, senderStatusResult, senderPreviewResult] = await Promise.allSettled([
        fetchJson("/tunan/ps/status"),
        fetchJson("/tunan/ps/sender_last_status"),
        fetchJson("/tunan/ps/sender_status"),
      ]);

      if (bridgeResult.status === "fulfilled") {
        mergeBridgeState(bridgeResult.value);
        refreshBridgePreview();
      }

      const senderMerged = {};
      const senderLastStatus =
        senderStatusResult.status === "fulfilled" && senderStatusResult.value && typeof senderStatusResult.value === "object"
          ? senderStatusResult.value
          : null;
      const senderCurrentStatus =
        senderPreviewResult.status === "fulfilled" && senderPreviewResult.value && typeof senderPreviewResult.value === "object"
          ? senderPreviewResult.value
          : null;
      const senderIsEmpty =
        senderCurrentStatus &&
        senderCurrentStatus.has_preview === false &&
        senderCurrentStatus.has_image === false;

      if (senderIsEmpty) {
        if (senderLastStatus && (senderLastStatus.has_preview || senderLastStatus.has_image)) {
          Object.assign(senderMerged, senderLastStatus);
        } else {
          Object.assign(senderMerged, senderCurrentStatus);
        }
      } else {
        if (senderLastStatus) {
          Object.assign(senderMerged, senderLastStatus);
        }
        if (senderCurrentStatus) {
          Object.assign(senderMerged, senderCurrentStatus);
        }
      }

      if (Object.keys(senderMerged).length > 0) {
        mergeSenderState(senderMerged);
        refreshSenderPreview();
      }

      markCanvasDirty();
    } catch (_) {}
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${url} -> ${response.status}`);
    }
    return response.json();
  }

  function cleanWorkflowTabName(rawText) {
    return String(rawText || "")
      .replace(/\u2022/g, "")
      .replace(/关闭/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getWorkflowTabButtons() {
    return Array.from(document.querySelectorAll("button.p-togglebutton.p-component"));
  }

  async function openSavedWorkflow(app, workflowPath, workflowName, workflowData = null, workflowId = "") {
    const normalizedName = cleanWorkflowTabName(workflowName);
    if (!workflowData || typeof app?.handleFile !== "function") {
      return false;
    }

    const filename = String(workflowPath || workflowName || "Untitled Workflow")
      .split(/[\\/]/)
      .pop()
      .replace(/^workflows\//i, "");
    const graphData = JSON.parse(JSON.stringify(workflowData));

    if (!graphData.extra || typeof graphData.extra !== "object") {
      graphData.extra = {};
    }
    graphData.extra.title = normalizedName || filename.replace(/\.json$/i, "");
    graphData.extra.filename = filename;
    graphData.extra.workflow_id = String(graphData.extra.workflow_id || workflowId || "");
    graphData.extra.workflow_path = String(graphData.extra.workflow_path || workflowPath || "");

    try {
      const blob = new Blob([JSON.stringify(graphData)], { type: "application/json" });
      const file = new File([blob], filename, {
        type: "application/json",
        lastModified: Date.now(),
      });
      await app.handleFile(file);
    } catch (_) {
      return false;
    }

    attachWorkflowObserver();
    scheduleWorkflowSync(true, 40);
    scheduleGraphRefresh(80);
    return true;
  }

  function scheduleWorkflowSync(force = false, delay = 90) {
    if (STATE.workflowSyncDebounce) {
      window.clearTimeout(STATE.workflowSyncDebounce);
    }

    STATE.workflowSyncDebounce = window.setTimeout(() => {
      STATE.workflowSyncDebounce = null;
      syncWorkflowTabs(force);
    }, delay);
  }

  function attachWorkflowObserver() {
    const tabButtons = getWorkflowTabButtons();
    const container = tabButtons[0]?.parentElement;

    if (!container) {
      return;
    }

    if (STATE.workflowObserverTarget === container && STATE.workflowObserver) {
      return;
    }

    if (STATE.workflowObserver) {
      STATE.workflowObserver.disconnect();
    }

    const observer = new MutationObserver((mutations) => {
      const hasRelevantChange = mutations.some((mutation) => {
        if (mutation.type === "childList") {
          return true;
        }

        return mutation.target?.matches?.("button.p-togglebutton.p-component");
      });

      if (hasRelevantChange) {
        scheduleWorkflowSync(false, 70);
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-pressed", "data-p-highlight"],
    });

    STATE.workflowObserver = observer;
    STATE.workflowObserverTarget = container;
  }

  function ensureWorkflowSurfaceObserver() {
    if (STATE.workflowSurfaceObserver) {
      return;
    }

    const root = document.body || document.documentElement;
    if (!root) {
      return;
    }

    const observer = new MutationObserver(() => {
      const tabButtons = getWorkflowTabButtons();
      if (!tabButtons.length) {
        return;
      }

      const currentContainer = tabButtons[0]?.parentElement;
      const shouldReattach =
        !STATE.workflowObserver ||
        !STATE.workflowObserverTarget ||
        STATE.workflowObserverTarget !== currentContainer ||
        !document.contains(STATE.workflowObserverTarget);

      if (shouldReattach) {
        attachWorkflowObserver();
      }

      scheduleWorkflowSync(true, 30);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });

    STATE.workflowSurfaceObserver = observer;
    attachWorkflowObserver();
    scheduleWorkflowSync(true, 30);
  }

  function bindWorkflowTabEvents() {
    if (!STATE.workflowClickBound) {
      addManagedEventListener(
        document,
        "click",
        (event) => {
          if (event.target?.closest?.("button.p-togglebutton.p-component")) {
            attachWorkflowObserver();
            scheduleWorkflowSync(true, 120);
          }
        },
        true,
      );

      STATE.workflowClickBound = true;
    }

    ensureWorkflowSurfaceObserver();
  }

  function collectWorkflowTabsFromDom() {
    const buttons = getWorkflowTabButtons();
    return buttons
      .map((button, index) => {
        const rawName = button.textContent || "";
        const name = cleanWorkflowTabName(rawName);

        if (!name) {
          return null;
        }

        return {
          id: `tab_${index}`,
          name,
          index,
          is_current: button.classList.contains("p-togglebutton-checked"),
          is_saved: !/Unsaved Workflow|未保存/i.test(name),
          is_modified: /[\u2022*]/.test(rawName),
        };
      })
      .filter(Boolean);
  }

  async function syncWorkflowTabs(force = false) {
    const tabs = collectWorkflowTabsFromDom();
    const runtimeApp = getRuntimeApp();
    if (!tabs.length) {
      const emptyToken = "__no_tabs__";
      if (!force && STATE.workflowSyncToken === emptyToken) {
        return;
      }

      STATE.workflowSyncToken = emptyToken;

      try {
        debugLog("syncWorkflowTabs:empty", {
          force,
          sessionId: FRONTEND_SESSION_ID,
          kind: FRONTEND_KIND,
        });
        await fetch("/tunan/ps/tab_update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "sync_all",
            current_tab: null,
            tabs: [],
            frontend_session_id: FRONTEND_SESSION_ID,
            frontend_kind: FRONTEND_KIND,
          }),
        });
      } catch (_) {}
      return;
    }

    const currentTab = tabs.find((tab) => tab.is_current) || null;

    tabs.forEach((tab) => {
      tab.is_current = currentTab ? tab.id === currentTab.id : false;
    });

    if (currentTab && runtimeApp?.graph?.extra) {
      const currentMeta = {
        workflow_id: String(runtimeApp.graph.extra.workflow_id || ""),
        filename: String(runtimeApp.graph.extra.filename || ""),
        path: String(runtimeApp.graph.extra.workflow_path || runtimeApp.graph.extra.path || ""),
      };

      if (currentMeta.workflow_id || currentMeta.filename || currentMeta.path) {
        STATE.workflowTabMeta[currentTab.id] = currentMeta;
      }
    }

    tabs.forEach((tab) => {
      const cachedMeta = STATE.workflowTabMeta[tab.id];
      if (!cachedMeta) {
        return;
      }
      tab.workflow_id = String(cachedMeta.workflow_id || "");
      tab.filename = String(cachedMeta.filename || "");
      tab.path = String(cachedMeta.path || "");
    });

    const syncToken = JSON.stringify({
      current: currentTab?.id || null,
      tabs: tabs.map((tab) => `${tab.id}:${tab.name}:${tab.is_current}:${tab.is_modified}`),
    });

    if (!force && STATE.workflowSyncToken === syncToken) {
      return;
    }

    STATE.workflowSyncToken = syncToken;

    try {
      debugLog("syncWorkflowTabs:send", {
        force,
        sessionId: FRONTEND_SESSION_ID,
        kind: FRONTEND_KIND,
        currentTab: currentTab?.id || null,
        tabs: tabs.map((tab) => ({
          id: tab.id,
          name: tab.name,
          isCurrent: tab.is_current,
        })),
      });
      await fetch("/tunan/ps/tab_update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_all",
          current_tab: currentTab?.id || null,
          tabs,
          frontend_session_id: FRONTEND_SESSION_ID,
          frontend_kind: FRONTEND_KIND,
        }),
      });
    } catch (_) {}
  }

  function switchToWorkflowTab(tabRef) {
    const tabButtons = getWorkflowTabButtons();
    let tabIndex = null;

    if (typeof tabRef === "number") {
      tabIndex = tabRef;
    } else if (typeof tabRef === "string") {
      const match = tabRef.match(/tab_(\d+)/);
      if (match) {
        tabIndex = Number(match[1]);
      }
    }

    if (typeof tabIndex !== "number" || !tabButtons[tabIndex]) {
      return;
    }

    const targetButton = tabButtons[tabIndex];
    const alreadyCurrent =
      targetButton.classList.contains("p-togglebutton-checked") ||
      targetButton.getAttribute("aria-pressed") === "true" ||
      targetButton.dataset?.pHighlight === "true";

    if (alreadyCurrent) {
      attachWorkflowObserver();
      scheduleWorkflowSync(true, 20);
      scheduleGraphRefresh(40);
      return;
    }

    targetButton.click();
    attachWorkflowObserver();
    scheduleWorkflowSync(true, 40);
    scheduleGraphRefresh(80);
  }

  async function handleWorkflowLoad(detail = {}) {
    const app = getRuntimeApp();
    if (!app) {
      return;
    }

    const workflowName = detail.workflow_name || detail.workflow_id || detail.filename?.replace(/\.json$/i, "") || "Untitled Workflow";
    const filename = String(detail.filename || `${workflowName}.json`)
      .split(/[\\/]/)
      .pop();
    const workflowPath = String(detail.path || `workflows/${filename}`);
    const workflowData = detail.workflow && typeof detail.workflow === "object" ? detail.workflow : null;

    if (await openSavedWorkflow(app, workflowPath, workflowName, workflowData, detail.workflow_id || "")) {
      return;
    }

    console.warn("[图南画桥] openWorkflow failed", { workflowName, workflowPath });
  }

  async function notifyExecutionStartedToBridge(promptId, workflowId = "current_active") {
    if (!promptId) {
      return;
    }

    try {
      await fetch("/tunan/ps/execution_started", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt_id: promptId,
          workflow_id: workflowId,
        }),
      });
    } catch (_) {}
  }

  async function executeCurrentWorkflowFromBridge() {
    const app = getRuntimeApp();
    const api = getRuntimeApi();
    if (!app || !api) {
      return false;
    }

    if (typeof app.graphToPrompt !== "function" || typeof api.queuePrompt !== "function") {
      return false;
    }

    const promptData = await app.graphToPrompt();
    if (!promptData?.workflow) {
      return false;
    }

    markSenderExecutionStart();
    const result = await api.queuePrompt(0, promptData);
    const promptId = String(result?.prompt_id || "");
    if (promptId) {
      await notifyExecutionStartedToBridge(promptId, "current_active");
    }
    return true;
  }

  function setupWorkflowBridge(app) {
    if (STATE.workflowBridgeReady || !app?.api?.addEventListener) {
      return;
    }

    STATE.workflowBridgeReady = true;
    bindWorkflowTabEvents();

    if (!STATE.queueButtonBound) {
      const queueButton = document.querySelector("#queue-button");
      if (queueButton) {
        addManagedEventListener(queueButton, "click", () => {
          markSenderExecutionStart();
        });
        STATE.queueButtonBound = true;
      }
    }

    const handleWorkflowSyncRequest = (event) => {
      debugLog("workflowSyncRequest", {
        eventType: event?.type || "unknown",
        sessionId: FRONTEND_SESSION_ID,
      });
      ensureWorkflowSurfaceObserver();
      scheduleWorkflowSync(true, 40);
    };

    addManagedEventListener(app.api, "tunan_request_current_workflow", handleWorkflowSyncRequest);
    addManagedEventListener(app.api, "tunan_request_tabs", handleWorkflowSyncRequest);

    addManagedEventListener(app.api, "switch_tab", (event) => {
      const detail = event?.detail || {};
      if (detail.target_session_id && detail.target_session_id !== FRONTEND_SESSION_ID) {
        return;
      }
      switchToWorkflowTab(detail.tab_id ?? detail.tab_index ?? null);
    });

    addManagedEventListener(app.api, "tunan_load_workflow", (event) => {
      const detail = event?.detail || {};
      if (detail.target_session_id && detail.target_session_id !== FRONTEND_SESSION_ID) {
        return;
      }
      handleWorkflowLoad(detail);
    });

    addManagedEventListener(app.api, "ps_execute_workflow", async (event) => {
      const detail = event?.detail || {};
      if (detail.target_session_id && detail.target_session_id !== FRONTEND_SESSION_ID) {
        return;
      }
      try {
        await executeCurrentWorkflowFromBridge();
      } catch (error) {
        console.warn("[图南画桥] execute workflow failed", error);
      }
    });

    addManagedEventListener(app.api, "ps_connection_changed", (event) => {
      const detail = event?.detail || {};
      debugLog("ps_connection_changed", {
        connected: Boolean(detail.connected),
        clientCount: detail.client_count || 0,
        sessionId: FRONTEND_SESSION_ID,
      });
      mergeBridgeState({
        connected: Boolean(detail.connected),
        client_count: detail.client_count || 0,
        last_activity: detail.timestamp || Date.now() / 1000,
        connection_info: detail,
      });
      if (!detail.connected) {
        stopBridgeReceivePulse();
      } else {
        ensureWorkflowSurfaceObserver();
        scheduleWorkflowSync(true, 60);
      }
      refreshBridgePreview();
      markCanvasDirty();
      refreshStatusOnce();
    });

    addManagedEventListener(app.api, "tunan_receive_state", (event) => {
      const detail = event?.detail || {};
      mergeBridgeState({ receive_status: detail });
      if (detail.phase === "received") {
        triggerBridgeReceiveFeedback();
      }
      markCanvasDirty();
    });

    addManagedEventListener(app.api, "image_updated", (event) => {
      const detail = event?.detail || {};
      mergeBridgeState(detail);
      mergeBridgeState({
        receive_status: {
          phase: "received",
          is_receiving: false,
          progress: 100,
          received_at: Date.now() / 1000,
        },
      });
      if (detail.image_url) {
        STATE.lastBridgeToken = null;
      }
      triggerBridgeReceiveFeedback();
      refreshBridgePreview();
      markCanvasDirty();
    });

    addManagedEventListener(app.api, "execution_start", (event) => {
      const detail = event?.detail || {};
      debugLog("execution_start", {
        detail,
        sessionId: FRONTEND_SESSION_ID,
      });
      STATE.workflowExecutionStartedAt = performance.now();
      STATE.senderExecutionElapsed = 0;
      markSenderExecutionStart();
    });

    addManagedEventListener(app.api, "executed", (event) => {
      if (!isSenderExecutionEvent(event) || STATE.workflowExecutionStartedAt <= 0) {
        return;
      }

      const elapsed = (performance.now() - STATE.workflowExecutionStartedAt) / 1000;
      if (!Number.isFinite(elapsed) || elapsed <= 0) {
        return;
      }

      STATE.senderExecutionElapsed = elapsed;
      STATE.workflowExecutionStartedAt = 0;
      STATE.senderExecutionStartedAt = 0;
      updateExecutionTimeFromFrontend(elapsed);
      window.setTimeout(() => {
        refreshStatusOnce();
      }, 60);
    });

    addManagedEventListener(app.api, "tunan_sender_update", (event) => {
      const detail = event?.detail || {};
      const status = detail?.status && typeof detail.status === "object" ? detail.status : detail;
      if (
        status &&
        typeof status === "object" &&
        (!Number.isFinite(status.generation_time) || status.generation_time <= 0.05)
      ) {
        if (STATE.senderExecutionElapsed > 0.05) {
          status.generation_time = STATE.senderExecutionElapsed;
        } else if (STATE.senderExecutionStartedAt > 0) {
          status.generation_time = (performance.now() - STATE.senderExecutionStartedAt) / 1000;
        }
      }
      STATE.senderExecutionElapsed = 0;
      STATE.senderExecutionStartedAt = 0;
      mergeSenderState(status);
      STATE.lastSenderToken = null;
      refreshSenderPreview();
      markCanvasDirty();
    });

  }

  function scheduleGraphRefresh(delay = 0) {
    if (STATE.graphRefreshTimer) {
      window.clearTimeout(STATE.graphRefreshTimer);
      STATE.graphRefreshTimer = null;
    }

    STATE.graphRefreshTimer = window.setTimeout(() => {
      STATE.graphRefreshTimer = null;
      scanGraphNodes();
      markCanvasDirty();
    }, delay);
  }

  function drawMainNodeBackground(ctx, node) {
    if (node.flags?.collapsed) return;

    const theme = getTheme(node.comfyClass);
    const image = node.comfyClass === IDS.bridge ? STATE.bridgeImage : STATE.senderImage;
    const sizeText = node.comfyClass === IDS.bridge ? STATE.bridgeSizeText : STATE.senderSizeText;

    drawPreviewPanel(ctx, node, theme, image, sizeText);
  }

  function drawMainNodeForeground(ctx, node) {
    if (node.flags?.collapsed) return;

    if (node.comfyClass === IDS.bridge) {
      drawBridgeStatusBar(ctx, node);
      drawSizeBar(ctx, node, STATE.bridgeSizeText);
    } else {
      drawSenderStatusBar(ctx, node);
      drawSizeBar(ctx, node, STATE.senderSizeText);
    }

    adjustConnectionPoints(node);
  }

  function bindSenderAdjustWidget(node, widget) {
    if (!node || !widget || widget.__tunanSenderAdjustBound === FRONTEND_VERSION) {
      return;
    }

    if (!widget.__tunanSenderValueIntercepted) {
      const descriptor = Object.getOwnPropertyDescriptor(widget, "value");
      if (!descriptor || (!descriptor.get && !descriptor.set)) {
        let currentValue = widget.value;
        try {
          Object.defineProperty(widget, "value", {
            configurable: true,
            enumerable: true,
            get() {
              return currentValue;
            },
            set(nextValue) {
              const changed = currentValue !== nextValue;
              currentValue = nextValue;
              if (changed) {
                scheduleSenderPreviewAdjust(node, 0, true);
              }
            },
          });
          widget.__tunanSenderValueIntercepted = true;
        } catch (_) {}
      }
    }

    const originalCallback = typeof widget.callback === "function" ? widget.callback : null;
    widget.callback = function onSenderAdjustWidgetChanged() {
      debugLog("sender_widget_changed", {
        widget: widget?.name || "",
        value: widget?.value,
      });
      if (originalCallback) {
        try {
          originalCallback.apply(this, arguments);
        } catch (_) {}
      }
      scheduleSenderPreviewAdjust(node);
    };
    widget.__tunanSenderAdjustBound = FRONTEND_VERSION;
  }

  function ensureSenderControls(node) {
    if (!node || node.comfyClass !== IDS.sender) {
      return;
    }

    [
      getSenderWidget(node, SENDER_RETURN_MODE_NAME),
      getSenderWidget(node, SENDER_EDGE_SHRINK_NAME),
      getSenderWidget(node, SENDER_EDGE_FEATHER_NAME),
    ]
      .filter(Boolean)
      .forEach((widget) => bindSenderAdjustWidget(node, widget));

    const hasResendButton = Array.isArray(node.widgets)
      ? node.widgets.some((widget) => widget?.name === SENDER_RESEND_BUTTON_NAME)
      : false;
    if (!hasResendButton && typeof node.addWidget === "function") {
      const button = node.addWidget("button", SENDER_RESEND_BUTTON_NAME, null, () => {
        resendCurrentSenderPreview(node);
      });
      if (button) {
        button.serialize = false;
      }
    }
  }

  function applyNodeTheme(node) {
    if (!node || !TARGET_IDS.has(node.comfyClass)) {
      return;
    }

    if (node.__tunanFrontendVersion === FRONTEND_VERSION) {
      clampNodeSize(node);
      ensureSenderControls(node);
      adjustConnectionPoints(node);
      return;
    }

    node.__tunanFrontendApplied = true;
    node.__tunanFrontendVersion = FRONTEND_VERSION;
    node.title = DISPLAY[node.comfyClass] || node.title;
    normalizeMainNodePorts(node);

    const theme = getTheme(node.comfyClass);
    node.color = theme.title;
    node.bgcolor = theme.body;
    node.shape = typeof LiteGraph !== "undefined" ? LiteGraph.ROUND_SHAPE : 1;
    node.badges = [];
    node.badgePosition = null;

    node.drawBadges = function drawBadges() {
      return;
    };

    clampNodeSize(node);
    ensureSenderControls(node);

    const originalComputeSize = node.computeSize;
    node.computeSize = function computeSize(width) {
      const size = originalComputeSize ? originalComputeSize.call(this, width) : [...getMinSize(this.comfyClass)];
      const [minWidth, minHeight] = getEffectiveMinSize(this);
      size[0] = Math.max(size[0], minWidth);
      size[1] = Math.max(size[1], minHeight);
      return size;
    };

    const originalBackground = node.onDrawBackground;
    node.onDrawBackground = function onDrawBackground(ctx) {
      if (originalBackground) {
        originalBackground.apply(this, arguments);
      }

      if (MAIN_IDS.has(this.comfyClass)) {
        drawMainNodeBackground(ctx, this);
        return;
      }

      drawToolNodeAccent(ctx, this);
    };

    const originalForeground = node.onDrawForeground;
    node.onDrawForeground = function onDrawForeground(ctx) {
      if (MAIN_IDS.has(this.comfyClass)) {
        drawMainNodeForeground(ctx, this);
      }

      if (originalForeground) {
        originalForeground.apply(this, arguments);
      }
    };

    const originalResize = node.onResize;
    node.onResize = function onResize(size) {
      const result = originalResize ? originalResize.call(this, size) : undefined;
      clampNodeSize(this);
      if (MAIN_IDS.has(this.comfyClass)) {
        adjustConnectionPoints(this);
      } else {
        layoutToolNode(this);
      }
      this.setDirtyCanvas(true, false);
      return result;
    };

    const originalConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function onConnectionsChange() {
      const result = originalConnectionsChange ? originalConnectionsChange.apply(this, arguments) : undefined;
      if (MAIN_IDS.has(this.comfyClass)) {
        adjustConnectionPoints(this);
      } else {
        layoutToolNode(this);
      }
      return result;
    };

    if (MAIN_IDS.has(node.comfyClass)) {
      adjustConnectionPoints(node);
    } else {
      layoutToolNode(node);
    }
  }

  function scanGraphNodes() {
    const nodes = getRuntimeApp()?.graph?._nodes || [];
    for (const node of nodes) {
      applyNodeTheme(node);
    }
  }

  function installNodeHooks(nodeType, nodeData) {
    const nodeId =
      nodeData?.name ||
      nodeData?.comfyClass ||
      nodeData?.node_name ||
      nodeType?.comfyClass ||
      null;

    if (!TARGET_IDS.has(nodeId) || nodeType.prototype.__tunanHooked) {
      return;
    }

    normalizeNodeSource(nodeData);
    if (nodeType.nodeData) {
      normalizeNodeSource(nodeType.nodeData);
    }

    nodeType.prototype.__tunanHooked = true;
    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function onNodeCreated() {
      const result = originalOnNodeCreated ? originalOnNodeCreated.apply(this, arguments) : undefined;
      applyNodeTheme(this);
      return result;
    };
  }

  function hookRegisteredNodeTypes() {
    const registeredTypes = window.LiteGraph?.registered_node_types || {};
    for (const nodeId of TARGET_IDS) {
      const nodeType = registeredTypes[nodeId];
      if (nodeType) {
        normalizeNodeSource(nodeType.nodeData);
        installNodeHooks(nodeType, { name: nodeId });
      }
    }
  }

  function activateFrontend(app) {
    if (!app) {
      return;
    }

    if (STATE.app === app && STATE.workflowBridgeReady) {
      scheduleGraphRefresh(0);
      refreshStatusOnce();
      return;
    }

    STATE.app = app;
    setupWorkflowBridge(app);
    hookRegisteredNodeTypes();
    scheduleGraphRefresh(0);
    refreshStatusOnce();
    bindWorkflowTabEvents();
    ensureWorkflowSurfaceObserver();
  }

  function registerExtension(app) {
    const targetApp = app || getRuntimeApp();
    if (!targetApp) {
      return false;
    }

    const extension = {
      name: EXTENSION_NAME,
      async beforeRegisterNodeDef(nodeType, nodeData) {
        installNodeHooks(nodeType, nodeData);
      },
      async afterConfigureGraph() {
        ensureWorkflowSurfaceObserver();
        scheduleWorkflowSync(true, 30);
        scheduleGraphRefresh(0);
      },
      async setup(currentApp) {
        activateFrontend(currentApp);
      },
    };

    if (typeof targetApp.registerExtension === "function") {
      targetApp.registerExtension(extension);
      return true;
    }

    if (targetApp.extensionManager?.registerExtension) {
      targetApp.extensionManager.registerExtension(extension);
      return true;
    }

    return false;
  }

  function boot() {
    ensureRoundRect();
    const app = getRuntimeApp();
    if (!app) {
      console.warn(`[${PRODUCT_NAME}] ComfyUI app unavailable during boot`);
      return;
    }

    if (!registerExtension(app)) {
      console.warn(`[${PRODUCT_NAME}] frontend registration failed`);
      return;
    }

    window[FRONTEND_RUNTIME_KEY] = {
      version: FRONTEND_VERSION,
      sessionId: FRONTEND_SESSION_ID,
      dispose: disposeFrontendRuntime,
    };

    console.info(`[${PRODUCT_NAME}] frontend loaded v${FRONTEND_VERSION}`);
    activateFrontend(app);
  }

  boot();
})();



