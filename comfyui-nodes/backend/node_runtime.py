"""Node runtime classes for TuNan Paint Bridge."""

from __future__ import annotations

import base64
import io
import json
import os
import time

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter


_resource_manager = None
_ps_connection = None
_sender_helpers = {}
_prompt_server = None
_get_last_execution_time = None
_ps_bridge_instance = None
VERBOSE_RUNTIME_LOGS = os.environ.get("TUNAN_DEBUG_RUNTIME", "").lower() in ("1", "true", "yes")


def _runtime_log(event, **payload):
    if not VERBOSE_RUNTIME_LOGS:
        return
    try:
        print(f"[TuNanRuntime] {event} {json.dumps(payload, ensure_ascii=False, default=str)}")
    except Exception:
        print(f"[TuNanRuntime] {event} {payload}")


def _describe_tensor(tensor):
    if tensor is None:
        return None

    try:
        return {
            "shape": [int(v) for v in tensor.shape],
            "dtype": str(tensor.dtype),
            "device": str(tensor.device),
            "contiguous": bool(tensor.is_contiguous()),
        }
    except Exception as exc:
        return {"error": str(exc)}


def _describe_array(array):
    if array is None:
        return None

    try:
        return {
            "shape": [int(v) for v in array.shape],
            "dtype": str(array.dtype),
        }
    except Exception as exc:
        return {"error": str(exc)}


def configure_runtime(
    resource_manager,
    ps_connection,
    sender_helpers,
    prompt_server=None,
    get_last_execution_time=None,
):
    global _resource_manager, _ps_connection, _sender_helpers, _prompt_server, _get_last_execution_time
    _resource_manager = resource_manager
    _ps_connection = ps_connection
    _sender_helpers = sender_helpers or {}
    _prompt_server = prompt_server
    _get_last_execution_time = get_last_execution_time


def create_default_tunan_workflow():
    return {
        "1": {
            "inputs": {},
            "class_type": "TuNanPSBridge",
            "_meta": {"title": "图南 PS 桥接器"},
        },
        "2": {
            "inputs": {"ckpt_name": "v1-5-pruned-emaonly.ckpt"},
            "class_type": "CheckpointLoaderSimple",
            "_meta": {"title": "加载模型"},
        },
        "3": {
            "inputs": {"text": ["1", 4], "clip": ["2", 1]},
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "正面提示词"},
        },
        "4": {
            "inputs": {"text": ["1", 5], "clip": ["2", 1]},
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "负面提示词"},
        },
        "5": {
            "inputs": {"pixels": ["1", 0], "vae": ["2", 2]},
            "class_type": "VAEEncode",
            "_meta": {"title": "VAE 编码"},
        },
        "6": {
            "inputs": {
                "seed": ["1", 3],
                "steps": ["1", 7],
                "cfg": ["1", 6],
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": ["1", 2],
                "model": ["2", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
            },
            "class_type": "KSampler",
            "_meta": {"title": "采样器"},
        },
        "7": {
            "inputs": {"samples": ["6", 0], "vae": ["2", 2]},
            "class_type": "VAEDecode",
            "_meta": {"title": "VAE 解码"},
        },
        "8": {
            "inputs": {"图像": ["7", 0]},
            "class_type": "TuNanPSSender",
            "_meta": {"title": "图南 PS 发送器"},
        },
    }


def get_or_create_ps_bridge():
    global _ps_bridge_instance
    if _ps_bridge_instance is None:
        _ps_bridge_instance = TunanPSBridge()
    return _ps_bridge_instance


class TunanPSBridge:
    """Receive Photoshop image data and expose it as a bridge node."""

    def __new__(cls):
        global _ps_bridge_instance
        if _ps_bridge_instance is None:
            _ps_bridge_instance = super().__new__(cls)
        return _ps_bridge_instance

    def __init__(self):
        if hasattr(self, "_initialized"):
            return

        self._initialized = True
        self.last_image_data = None
        self.last_selection_mask_data = None
        self.last_content_alpha_data = None
        self.image_info = {}
        self.last_image_width = 0
        self.last_image_height = 0
        self.parameters = {
            "denoise": 0.5,
            "seed": -1,
            "positive_prompt": "",
            "negative_prompt": "",
            "cfg_scale": 7.0,
            "steps": 20,
        }
        self.original_placement = None
        self.crop_parameters = {
            "enabled": True,
            "featherRadius": 2.5,
            "cropIntensity": 1.0,
            "selectionBounds": None,
            "updated_at": time.time(),
        }
        self.image_update_id = 0
        self.last_update_time = time.time()
        self.execution_status = {
            "is_executing": False,
            "prompt_id": None,
            "progress": 0,
            "last_execution_time": 0,
            "error": False,
        }
        self.receive_status = {
            "phase": "idle",
            "is_receiving": False,
            "progress": 0,
            "received_at": 0,
            "error_message": "",
        }

    @staticmethod
    def _coerce_int(value, default=0):
        try:
            return int(round(float(value)))
        except Exception:
            return int(default)

    def _normalize_bounds_payload(self, bounds):
        if not isinstance(bounds, dict):
            return None

        if {"x", "y", "width", "height"}.issubset(bounds.keys()):
            width = max(0, self._coerce_int(bounds.get("width"), 0))
            height = max(0, self._coerce_int(bounds.get("height"), 0))
            return {
                "x": self._coerce_int(bounds.get("x"), 0),
                "y": self._coerce_int(bounds.get("y"), 0),
                "width": width,
                "height": height,
            }

        if {"left", "top", "right", "bottom"}.issubset(bounds.keys()):
            left = self._coerce_int(bounds.get("left"), 0)
            top = self._coerce_int(bounds.get("top"), 0)
            right = self._coerce_int(bounds.get("right"), left)
            bottom = self._coerce_int(bounds.get("bottom"), top)
            return {
                "x": left,
                "y": top,
                "width": max(0, right - left),
                "height": max(0, bottom - top),
            }

        return None

    def _extract_target_size(self, placement):
        if not isinstance(placement, dict):
            return (0, 0)

        target_size = placement.get("targetSize")
        if isinstance(target_size, dict):
            return (
                max(0, self._coerce_int(target_size.get("width"), 0)),
                max(0, self._coerce_int(target_size.get("height"), 0)),
            )
        if isinstance(target_size, (list, tuple)) and len(target_size) >= 2:
            return (
                max(0, self._coerce_int(target_size[0], 0)),
                max(0, self._coerce_int(target_size[1], 0)),
            )
        return (0, 0)

    def get_public_image_info(self):
        info = self.image_info if isinstance(self.image_info, dict) else {}
        return {
            "source": str(info.get("source") or ""),
            "document_name": str(info.get("document_name") or ""),
            "source_layer_name": str(info.get("source_layer_name") or ""),
            "has_selection": bool(info.get("has_selection")),
            "selection_send_mode": str(info.get("selection_send_mode") or ""),
            "selection_expand_px": self._coerce_int(info.get("selection_expand_px"), 0),
            "mask_in_image_alpha": bool(info.get("mask_in_image_alpha")),
        }

    def get_bridge_context_summary(self):
        placement = self.original_placement if isinstance(self.original_placement, dict) else {}
        info = self.get_public_image_info()
        selection_bounds = self._normalize_bounds_payload(placement.get("selectionBounds"))
        send_bounds = self._normalize_bounds_payload(placement.get("sendBounds"))

        if selection_bounds is None:
            selection_bounds = self._normalize_bounds_payload((self.image_info or {}).get("original_bounds"))
        if send_bounds is None:
            send_bounds = self._normalize_bounds_payload((self.image_info or {}).get("send_bounds"))

        target_width, target_height = self._extract_target_size(placement)

        if placement.get("isSelectionBased"):
            placement_mode = "selection"
        elif placement.get("isLayerPlacement"):
            placement_mode = "layer"
        elif placement.get("documentBounds"):
            placement_mode = "document"
        else:
            placement_mode = ""

        return {
            "source": info.get("source", ""),
            "document_name": info.get("document_name", ""),
            "source_layer_name": info.get("source_layer_name", ""),
            "has_selection": bool(self.last_selection_mask_data is not None or info.get("has_selection")),
            "has_content_alpha": bool(self.last_content_alpha_data is not None),
            "selection_send_mode": str(
                placement.get("selectionSendMode")
                or info.get("selection_send_mode")
                or ""
            ),
            "placement_mode": placement_mode,
            "can_overlay_in_place": bool(placement.get("canOverlayInPlace")),
            "selection_bounds": selection_bounds,
            "send_bounds": send_bounds,
            "target_width": target_width,
            "target_height": target_height,
            "mask_in_image_alpha": bool(info.get("mask_in_image_alpha")),
        }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模式": (["图像和参数", "仅图像", "仅参数"], {"default": "图像和参数"}),
                "输出格式": (["RGB", "RGBA"], {"default": "RGB"}),
            },
            "hidden": {
                "current_image_url": ("STRING", {"default": ""}),
                "connection_status": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT", "INT", "STRING", "STRING", "FLOAT", "INT")
    RETURN_NAMES = ("图像", "真实选区蒙版", "降噪强度", "种子", "正面提示词", "负面提示词", "CFG", "步数")
    FUNCTION = "bridge_ps_data"
    OUTPUT_NODE = True
    CATEGORY = "图南绘画工具"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        bridge = get_or_create_ps_bridge()
        has_image = bridge.last_image_data is not None
        return (
            f"img:{bridge.image_update_id}|"
            f"time:{bridge.last_update_time}|"
            f"has:{int(has_image)}|"
            f"params:{hash(str(bridge.parameters))}"
        )

    def _get_display_image_tensor(self):
        if self.last_image_data is not None:
            return self.last_image_data

        try:
            pil_image = Image.open(_resource_manager.waiting_image_path)
            if pil_image.mode != "RGB":
                pil_image = pil_image.convert("RGB")
            image_array = np.array(pil_image).astype(np.float32) / 255.0
            return torch.from_numpy(image_array).unsqueeze(0)
        except Exception:
            return torch.ones((1, 512, 512, 3), dtype=torch.float32) * 0.2

    def bridge_ps_data(self, 模式="图像和参数", 输出格式="RGB", current_image_url="", connection_status=""):
        try:
            TunanPSSender.reset_workflow_timer()
            bridge = get_or_create_ps_bridge()
            _runtime_log(
                "bridge:start",
                mode=模式,
                output_format=输出格式,
                has_bridge_image=bridge.last_image_data is not None,
                image_update_id=int(bridge.image_update_id),
                bridge_image=_describe_tensor(bridge.last_image_data),
                selection_mask=_describe_tensor(bridge.last_selection_mask_data),
                content_alpha=_describe_tensor(bridge.last_content_alpha_data),
            )
            status = _ps_connection.get_connection_status() if _ps_connection else {
                "connected": False,
                "status_text": "未连接",
                "status_color": "#ff6b6b",
                "client_count": 0,
            }

            if 模式 in ["图像和参数", "仅图像"]:
                if bridge.last_image_data is not None:
                    if 输出格式 == "RGB" and bridge.last_image_data.shape[-1] == 4:
                        image = bridge.last_image_data[:, :, :, :3]
                    elif 输出格式 == "RGBA" and bridge.last_image_data.shape[-1] == 3:
                        alpha = torch.ones(
                            (
                                bridge.last_image_data.shape[0],
                                bridge.last_image_data.shape[1],
                                bridge.last_image_data.shape[2],
                                1,
                            ),
                            dtype=torch.float32,
                        )
                        image = torch.cat([bridge.last_image_data, alpha], dim=-1)
                    else:
                        image = bridge.last_image_data

                    _runtime_log("bridge:before_contiguous", image=_describe_tensor(image))
                    image = image.contiguous()
                    _runtime_log("bridge:after_contiguous", image=_describe_tensor(image))
                    if bridge.last_selection_mask_data is not None:
                        selection_mask = bridge.last_selection_mask_data
                    else:
                        selection_mask = torch.zeros((1, image.shape[1], image.shape[2]), dtype=torch.float32)

                else:
                    image = self._get_display_image_tensor()
                    _runtime_log("bridge:fallback_display_image", image=_describe_tensor(image))
                    selection_mask = torch.zeros((1, image.shape[1], image.shape[2]), dtype=torch.float32)
            else:
                image = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
                selection_mask = torch.zeros((1, 64, 64), dtype=torch.float32)

            image_url = _resource_manager.get_current_image_url()
            joiner = "&" if "?" in image_url else "?"
            image_url = f"{image_url}{joiner}force_reload={int(time.time() * 1000)}"
            public_image_info = bridge.get_public_image_info()
            bridge_context = bridge.get_bridge_context_summary()

            ui_data = {
                "text": [
                    f"状态: {status['status_text']} | 图片: {'已接收' if bridge.last_image_data is not None else '等待中'}"
                ],
                "tunan_ps_status": {
                    "connected": status["connected"],
                    "status_text": status["status_text"],
                    "status_color": status["status_color"],
                    "image_url": image_url,
                    "has_image": bridge.last_image_data is not None,
                    "client_count": status["client_count"],
                    "last_update": int(time.time() * 1000),
                    "update_id": bridge.image_update_id,
                    "parameters": bridge.parameters,
                    "execution_status": bridge.execution_status,
                    "receive_status": bridge.receive_status,
                    "image_info": public_image_info,
                    "bridge_context": bridge_context,
                },
            }

            _runtime_log(
                "bridge:return",
                image=_describe_tensor(image),
                selection_mask=_describe_tensor(selection_mask),
                params={
                    "denoise": float(bridge.parameters.get("denoise", 0.5)),
                    "seed": int(bridge.parameters.get("seed", -1)),
                    "cfg_scale": float(bridge.parameters.get("cfg_scale", 7.0)),
                    "steps": int(bridge.parameters.get("steps", 20)),
                },
            )

            return {
                "ui": ui_data,
                "result": (
                    image,
                    selection_mask,
                    float(bridge.parameters.get("denoise", 0.5)),
                    int(bridge.parameters.get("seed", -1)),
                    str(bridge.parameters.get("positive_prompt", "")),
                    str(bridge.parameters.get("negative_prompt", "")),
                    float(bridge.parameters.get("cfg_scale", 7.0)),
                    int(bridge.parameters.get("steps", 20)),
                ),
            }
        except Exception as exc:
            _runtime_log("bridge:error", error=str(exc))
            error_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            error_selection_mask = torch.zeros((1, 512, 512), dtype=torch.float32)
            return {
                "ui": {
                    "text": [f"桥接器错误: {exc}"],
                    "tunan_ps_status": {
                        "connected": False,
                        "status_text": "错误",
                        "status_color": "#ff6b6b",
                        "image_url": "",
                        "has_image": False,
                        "client_count": 0,
                    },
                },
                "result": (error_image, error_selection_mask, 0.5, -1, "", "", 7.0, 20),
            }

    def process_image_data(self, pil_image, metadata=None):
        metadata = metadata or {}
        if not pil_image:
            return False

        _runtime_log(
            "process_image_data:start",
            size=[int(pil_image.width), int(pil_image.height)],
            mode=str(pil_image.mode),
            metadata_keys=sorted(str(key) for key in metadata.keys()),
        )

        self.last_image_width = int(pil_image.width)
        self.last_image_height = int(pil_image.height)
        _resource_manager.save_current_image(pil_image)

        has_alpha = pil_image.mode == "RGBA"
        if has_alpha:
            image_array = np.array(pil_image).astype(np.float32) / 255.0
            alpha_channel = image_array[:, :, 3]
            self.last_content_alpha_data = torch.from_numpy(alpha_channel).unsqueeze(0)
            rgb_array = image_array[:, :, :3]
            self.last_image_data = torch.from_numpy(rgb_array).unsqueeze(0)
        else:
            if pil_image.mode != "RGB":
                pil_image = pil_image.convert("RGB")
            image_array = np.array(pil_image).astype(np.float32) / 255.0
            if len(image_array.shape) == 2:
                image_array = np.stack([image_array] * 3, axis=-1)
            self.last_image_data = torch.from_numpy(image_array).unsqueeze(0)
            self.last_content_alpha_data = torch.ones(
                (1, self.last_image_data.shape[1], self.last_image_data.shape[2]),
                dtype=torch.float32,
            )

        self.last_selection_mask_data = self._load_mask_tensor(
            metadata,
            prefix="selection_mask",
            default_size=pil_image.size,
        )

        content_alpha_override = self._load_mask_tensor(
            metadata,
            prefix="content_alpha",
            default_size=pil_image.size,
        )
        if content_alpha_override is not None:
            self.last_content_alpha_data = content_alpha_override

        self.image_info = metadata
        self.original_placement = metadata.get("original_placement")
        self.image_update_id += 1
        self.last_update_time = time.time()
        self.receive_status = {
            "phase": "received",
            "is_receiving": False,
            "progress": 100,
            "received_at": self.last_update_time,
            "error_message": "",
        }

        if _prompt_server and hasattr(_prompt_server.instance, "send_sync"):
            try:
                _prompt_server.instance.send_sync(
                    "image_updated",
                    {
                        "has_image": True,
                        "timestamp": time.time(),
                        "image_url": _resource_manager.get_current_image_url(),
                        "update_id": self.image_update_id,
                        "receive_status": self.receive_status,
                        "image_info": self.get_public_image_info(),
                        "bridge_context": self.get_bridge_context_summary(),
                    },
                )
            except Exception:
                pass

        _runtime_log(
            "process_image_data:done",
            image=_describe_tensor(self.last_image_data),
            selection_mask=_describe_tensor(self.last_selection_mask_data),
            content_alpha=_describe_tensor(self.last_content_alpha_data),
            image_info_keys=sorted(str(key) for key in self.image_info.keys()),
        )

        return True

    def _load_mask_tensor(self, metadata, prefix, default_size):
        try:
            mask_image = self._load_mask_image(metadata, prefix, default_size)
            if mask_image is None:
                return None

            if "A" in mask_image.getbands():
                mask_image = mask_image.getchannel("A")
            elif mask_image.mode != "L":
                mask_image = mask_image.convert("L")

            if mask_image.size != default_size:
                mask_image = mask_image.resize(default_size, Image.BILINEAR)

            mask_array = np.array(mask_image).astype(np.float32) / 255.0
            if mask_array.ndim == 3:
                mask_array = mask_array[:, :, 0]
            return torch.from_numpy(mask_array).unsqueeze(0)
        except Exception:
            return None

    def _load_mask_image(self, metadata, prefix, default_size):
        raw_flag = metadata.get(f"{prefix}_raw")
        raw_data = metadata.get(f"{prefix}_raw_data")
        if raw_flag and raw_data:
            mode_map = {
                1: "L",
                2: "LA",
                3: "RGB",
                4: "RGBA",
            }
            components = int(metadata.get(f"{prefix}_components", 1) or 1)
            raw_width = int(metadata.get(f"{prefix}_source_width", default_size[0]) or 0)
            raw_height = int(metadata.get(f"{prefix}_source_height", default_size[1]) or 0)
            raw_mode = mode_map.get(components)
            if not raw_mode or raw_width <= 0 or raw_height <= 0:
                return None

            mask_image = Image.frombytes(
                raw_mode,
                (raw_width, raw_height),
                base64.b64decode(raw_data),
            )

            canvas_width = int(metadata.get(f"{prefix}_canvas_width", raw_width) or raw_width)
            canvas_height = int(metadata.get(f"{prefix}_canvas_height", raw_height) or raw_height)
            offset_x = int(metadata.get(f"{prefix}_offset_x", 0) or 0)
            offset_y = int(metadata.get(f"{prefix}_offset_y", 0) or 0)
            target_width = int(metadata.get(f"{prefix}_target_width", canvas_width) or canvas_width)
            target_height = int(metadata.get(f"{prefix}_target_height", canvas_height) or canvas_height)

            if canvas_width != raw_width or canvas_height != raw_height or offset_x != 0 or offset_y != 0:
                canvas_mode = "RGBA" if "A" in mask_image.getbands() else ("RGB" if mask_image.mode in ("RGB", "RGBA") else "L")
                background = (0, 0, 0, 0) if canvas_mode == "RGBA" else ((0, 0, 0) if canvas_mode == "RGB" else 0)
                composed = Image.new(canvas_mode, (canvas_width, canvas_height), background)
                paste_source = mask_image if mask_image.mode == canvas_mode else mask_image.convert(canvas_mode)
                if canvas_mode == "RGBA":
                    composed.paste(paste_source, (offset_x, offset_y), paste_source)
                else:
                    composed.paste(paste_source, (offset_x, offset_y))
                mask_image = composed

            if target_width > 0 and target_height > 0 and mask_image.size != (target_width, target_height):
                mask_image = mask_image.resize((target_width, target_height), Image.Resampling.BILINEAR)

            return mask_image

        mask_data = metadata.get(f"{prefix}_data")
        mask_filename = metadata.get(prefix)
        if mask_data or mask_filename:
            if mask_data:
                raw_mask = mask_data.split(",", 1)[1] if "," in mask_data else mask_data
                return Image.open(io.BytesIO(base64.b64decode(raw_mask)))

            mask_path = (
                mask_filename
                if os.path.isabs(mask_filename)
                else os.path.join(_resource_manager.plugin_dir, mask_filename)
            )
            if not os.path.exists(mask_path):
                return None
            return Image.open(mask_path)

        return None

    def update_parameters(self, params):
        updated_keys = []
        for key, value in (params or {}).items():
            if key in self.parameters:
                self.parameters[key] = value
                updated_keys.append(key)

        if updated_keys:
            self.last_update_time = time.time()
        return bool(updated_keys)


class TunanSelectionCropper:
    """Smart crop helper based on Photoshop selection bounds."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"图像": ("IMAGE",)},
            "optional": {
                "启用裁剪": ("BOOLEAN", {"default": True, "label_on": "启用", "label_off": "禁用"}),
                "羽化半径": ("FLOAT", {"default": 2.5, "min": 0.0, "max": 50.0, "step": 0.5}),
                "边缘处理": (["smooth", "feather", "blur"], {"default": "smooth"}),
                "保持原尺寸": ("BOOLEAN", {"default": False, "label_on": "保持", "label_off": "裁剪"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("裁剪图像", "裁剪蒙版")
    FUNCTION = "process_selection_crop"
    CATEGORY = "图南绘画工具/图像处理"

    def process_selection_crop(self, 图像, 启用裁剪=True, 羽化半径=2.5, 边缘处理="smooth", 保持原尺寸=False):
        bridge = get_or_create_ps_bridge()
        crop_config = bridge.crop_parameters if bridge and hasattr(bridge, "crop_parameters") else {}
        enabled = crop_config.get("enabled", 启用裁剪)
        feather_radius = crop_config.get("featherRadius", 羽化半径)

        if not enabled:
            full_mask = torch.ones((图像.shape[0], 图像.shape[1], 图像.shape[2]), dtype=torch.float32)
            return 图像, full_mask

        selection_bounds = None
        if bridge and bridge.original_placement:
            selection_bounds = bridge.original_placement.get("selectionBounds")

        if not selection_bounds:
            full_mask = torch.ones((图像.shape[0], 图像.shape[1], 图像.shape[2]), dtype=torch.float32)
            return 图像, full_mask

        results = []
        masks = []
        for index in range(图像.shape[0]):
            cropped_img, crop_mask = self.crop_single_image(
                图像[index],
                selection_bounds,
                feather_radius,
                边缘处理,
                保持原尺寸,
            )
            results.append(cropped_img)
            masks.append(crop_mask)

        return torch.stack(results, dim=0), torch.stack(masks, dim=0)

    def crop_single_image(self, image_tensor, bounds, feather_radius, edge_mode, keep_original_size):
        img_array = (image_tensor.cpu().numpy() * 255).astype(np.uint8)
        pil_image = Image.fromarray(img_array)
        img_width, img_height = pil_image.size

        x = int(bounds.get("x", 0))
        y = int(bounds.get("y", 0))
        width = int(bounds.get("width", img_width))
        height = int(bounds.get("height", img_height))

        mask = Image.new("L", (img_width, img_height), 0)
        draw = ImageDraw.Draw(mask)
        draw.rectangle([x, y, x + width, y + height], fill=255)

        if feather_radius > 0:
            if edge_mode == "feather":
                mask = mask.filter(ImageFilter.GaussianBlur(radius=feather_radius))
            elif edge_mode == "smooth":
                mask = mask.filter(ImageFilter.GaussianBlur(radius=feather_radius * 0.6))
            elif edge_mode == "blur":
                mask = mask.filter(ImageFilter.BoxBlur(radius=feather_radius))

        if pil_image.mode == "RGB":
            rgba_image = Image.new("RGBA", pil_image.size, (0, 0, 0, 0))
            rgba_image.paste(pil_image, mask=mask)
            result_image = rgba_image
        else:
            result_image = pil_image

        if not keep_original_size and width > 0 and height > 0:
            expand = int(feather_radius * 2)
            crop_x = max(0, x - expand)
            crop_y = max(0, y - expand)
            crop_x2 = min(img_width, x + width + expand)
            crop_y2 = min(img_height, y + height + expand)
            result_image = result_image.crop((crop_x, crop_y, crop_x2, crop_y2))
            mask = mask.crop((crop_x, crop_y, crop_x2, crop_y2))

        if result_image.mode == "RGBA":
            rgb_array = np.array(result_image)[:, :, :3]
            result_tensor = torch.from_numpy(rgb_array.astype(np.float32) / 255.0)
        else:
            result_array = np.array(result_image.convert("RGB"))
            result_tensor = torch.from_numpy(result_array.astype(np.float32) / 255.0)

        mask_array = np.array(mask).astype(np.float32) / 255.0
        mask_tensor = torch.from_numpy(mask_array)
        return result_tensor, mask_tensor


class TunanPSSender:
    """Send generated images back to Photoshop and expose sender preview UI."""

    _workflow_start_time = None
    _workflow_start_perf = None
    _latest_source_state = None

    def __init__(self):
        self.last_sent_time = 0
        self.current_preview_path = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "图像格式": (["JPEG", "PNG"], {"default": "JPEG"}),
                "回贴模式": (["选区还原模式", "整图模式"], {"default": "选区还原模式"}),
                "边缘收缩": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
                "边缘柔化": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
            },
            "optional": {
                "图像名称": ("STRING", {"default": "ComfyUI_Output", "multiline": False}),
                "JPEG质量": ("INT", {"default": 90, "min": 60, "max": 100, "step": 5}),
                "PNG压缩": ("INT", {"default": 6, "min": 0, "max": 9, "step": 1}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "process_and_send"
    CATEGORY = "图南绘画工具"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        if not hasattr(cls, "_class_init_time"):
            cls._class_init_time = time.time()
        if time.time() - cls._class_init_time < 3.0:
            return f"sender_initializing_{int(time.time() * 10)}"

        preview_exists = bool(
            _resource_manager
            and _resource_manager.sender_preview_path
            and os.path.exists(_resource_manager.sender_preview_path)
        )
        return f"sender_preview_{int(preview_exists)}_{int(time.time() // 10)}"

    @classmethod
    def reset_workflow_timer(cls):
        cls._workflow_start_time = time.time()
        cls._workflow_start_perf = time.perf_counter()
        try:
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
        except Exception:
            pass

    def _get_vram_info(self):
        try:
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                total = torch.cuda.get_device_properties(0).total_memory
                free = torch.cuda.mem_get_info()[0]
                used = total - free
                peak_reserved = 0
                if hasattr(torch.cuda, "max_memory_reserved"):
                    peak_reserved = torch.cuda.max_memory_reserved()
                elif hasattr(torch.cuda, "max_memory_allocated"):
                    peak_reserved = torch.cuda.max_memory_allocated()

                if peak_reserved <= 0:
                    peak_reserved = used

                return {
                    "used_gb": round(used / (1024 ** 3), 2),
                    "peak_gb": round(peak_reserved / (1024 ** 3), 2),
                }
        except Exception:
            pass
        return {"used_gb": 0.0, "peak_gb": 0.0}

    def _format_size(self, byte_count):
        if byte_count < 1024:
            return f"{byte_count} B"
        if byte_count < 1024 * 1024:
            return f"{byte_count / 1024:.1f} KB"
        return f"{byte_count / (1024 * 1024):.1f} MB"

    def _clear_sender_preview_state(self):
        try:
            preview_path = getattr(_resource_manager, "sender_preview_path", None)
            if preview_path and os.path.exists(preview_path):
                os.remove(preview_path)
        except Exception:
            pass
        if _resource_manager:
            _resource_manager.sender_preview_path = None
        self.current_preview_path = None
        TunanPSSender._latest_source_state = None

    def _clone_optional_array(self, array):
        if array is None:
            return None
        return np.array(array, copy=True)

    def _clone_serializable(self, value):
        if value is None:
            return None
        try:
            return json.loads(json.dumps(value, ensure_ascii=False))
        except Exception:
            return None

    def _store_latest_source_state(
        self,
        image_np,
        selection_alpha,
        content_alpha,
        image_name,
        image_format,
        jpeg_quality,
        png_compression,
        generation_params,
        execution_time,
        vram_used,
        placement_snapshot=None,
        image_info_snapshot=None,
        bridge_context_snapshot=None,
    ):
        TunanPSSender._latest_source_state = {
            "image_np": np.array(image_np, copy=True),
            "selection_alpha": self._clone_optional_array(selection_alpha),
            "content_alpha": self._clone_optional_array(content_alpha),
            "image_name": str(image_name or "ComfyUI_Output"),
            "image_format": str(image_format or "PNG"),
            "jpeg_quality": int(max(60, min(100, int(jpeg_quality or 90)))),
            "png_compression": int(max(0, min(9, int(png_compression or 6)))),
            "generation_params": dict(generation_params or {}),
            "generation_time": float(execution_time or 0.0),
            "vram_used": float(vram_used or 0.0),
            "placement_snapshot": self._clone_serializable(placement_snapshot),
            "image_info_snapshot": self._clone_serializable(image_info_snapshot),
            "bridge_context_snapshot": self._clone_serializable(bridge_context_snapshot),
            "stored_at": float(time.time()),
        }
        return TunanPSSender._latest_source_state

    def _build_empty_sender_status(self):
        waiting_width = 0
        waiting_height = 0
        waiting_path = getattr(_resource_manager, "sender_waiting_image_path", None)
        try:
            if waiting_path and os.path.exists(waiting_path):
                with Image.open(waiting_path) as waiting_image:
                    waiting_width, waiting_height = waiting_image.size
        except Exception:
            pass

        return {
            "has_image": False,
            "has_preview": False,
            "image_format": "",
            "file_size": "",
            "image_width": int(waiting_width),
            "image_height": int(waiting_height),
            "image_name": "",
            "sent_to_ps": False,
            "preview_path": "",
            "timestamp": float(time.time()),
            "generation_time": 0.0,
            "vram_used": 0.0,
            "generation_params": {},
            "message": "等待生成结果",
            "delivery_mode": "waiting",
            "alpha_mode": "none",
            "can_overlay_in_place": False,
            "placement_mode": "",
            "capture_source": "",
            "selection_send_mode": "",
        }

    def _is_bridge_waiting_placeholder(self, image_np):
        bridge = get_or_create_ps_bridge()
        if bridge and bridge.last_image_data is not None:
            return False

        waiting_path = getattr(_resource_manager, "waiting_image_path", None)
        if not waiting_path or not os.path.exists(waiting_path):
            return False

        try:
            with Image.open(waiting_path) as waiting_image:
                waiting_rgb = waiting_image.convert("RGB")
                waiting_np = np.array(waiting_rgb, dtype=np.uint8)
        except Exception:
            return False

        source_rgb = image_np[:, :, :3] if image_np.ndim == 3 and image_np.shape[2] >= 3 else image_np
        if source_rgb.shape != waiting_np.shape:
            return False

        try:
            diff = np.abs(source_rgb.astype(np.int16) - waiting_np.astype(np.int16))
            mean_diff = float(diff.mean())
            max_diff = int(diff.max())
            return bool(mean_diff <= 1.0 and max_diff <= 4)
        except Exception:
            return bool(np.array_equal(source_rgb, waiting_np))

    def _mask_tensor_to_array(self, mask_tensor, width, height):
        if mask_tensor is None:
            return None

        try:
            if mask_tensor.dim() == 3:
                mask_tensor = mask_tensor[0]
            elif mask_tensor.dim() != 2:
                return None

            mask_np = mask_tensor.detach().cpu().numpy().astype(np.float32)
            if mask_np.ndim != 2:
                return None

            if mask_np.shape[1] != width or mask_np.shape[0] != height:
                mask_img = Image.fromarray(np.clip(mask_np * 255.0, 0, 255).astype(np.uint8), "L")
                mask_img = mask_img.resize((width, height), Image.BILINEAR)
                mask_np = np.array(mask_img).astype(np.float32) / 255.0

            return np.clip(mask_np, 0.0, 1.0)
        except Exception:
            return None

    def _mask_has_content(self, mask_array):
        if mask_array is None:
            return False
        return bool(float(mask_array.max()) > 0.001 and float(mask_array.mean()) > 0.0001)

    def _normalize_return_mode(self, return_mode):
        mode_text = str(return_mode or "").strip()
        if mode_text in {"选区还原模式", "真实选区模式", "selection_restore"}:
            return "selection_restore"
        return "whole_image"

    def _resolve_applied_return_mode(self, return_mode, selection_alpha):
        requested_mode = self._normalize_return_mode(return_mode)
        has_selection = self._mask_has_content(selection_alpha)
        if requested_mode == "selection_restore" and has_selection:
            return "selection_restore", requested_mode, True
        return "whole_image", requested_mode, False

    def _resolve_selection_alpha(self, image_tensor, selection_mask):
        height = int(image_tensor.shape[0])
        width = int(image_tensor.shape[1])

        selection_alpha = self._mask_tensor_to_array(selection_mask, width, height)
        if self._mask_has_content(selection_alpha):
            return selection_alpha

        bridge = get_or_create_ps_bridge()
        if bridge and bridge.last_selection_mask_data is not None:
            bridge_alpha = self._mask_tensor_to_array(bridge.last_selection_mask_data, width, height)
            if self._mask_has_content(bridge_alpha):
                return bridge_alpha

        return None

    def _resolve_content_alpha(self, image_tensor):
        bridge = get_or_create_ps_bridge()
        height = int(image_tensor.shape[0])
        width = int(image_tensor.shape[1])

        if bridge and bridge.last_content_alpha_data is not None:
            bridge_alpha = self._mask_tensor_to_array(bridge.last_content_alpha_data, width, height)
            if self._mask_has_content(bridge_alpha):
                return bridge_alpha

        return None

    def _feather_alpha(self, alpha_array, feather_px):
        if alpha_array is None:
            return None

        feather_px = max(0.0, float(feather_px or 0))
        if feather_px <= 0:
            return np.clip(alpha_array.astype(np.float32), 0.0, 1.0)

        alpha_image = Image.fromarray(
            np.clip(alpha_array.astype(np.float32) * 255.0, 0, 255).astype(np.uint8),
            "L",
        )
        blurred = alpha_image.filter(ImageFilter.GaussianBlur(radius=feather_px))
        return np.clip(np.array(blurred).astype(np.float32) / 255.0, 0.0, 1.0)

    def _shrink_alpha(self, alpha_array, shrink_px):
        if alpha_array is None:
            return None

        shrink_px = max(0, int(round(float(shrink_px or 0))))
        if shrink_px <= 0:
            return np.clip(alpha_array.astype(np.float32), 0.0, 1.0)

        binary_image = Image.fromarray(
            ((alpha_array.astype(np.float32) > 0.001).astype(np.uint8) * 255),
            "L",
        )
        for _ in range(shrink_px):
            binary_image = binary_image.filter(ImageFilter.MinFilter(3))
        return (np.array(binary_image).astype(np.float32) > 127.5).astype(np.float32)

    def _build_rect_alpha(self, width, height, shrink_px, feather_px):
        width = max(1, int(width or 0))
        height = max(1, int(height or 0))
        shrink_px = max(0, int(round(float(shrink_px or 0))))
        feather_px = max(0.0, float(feather_px or 0))

        rect = np.zeros((height, width), dtype=np.float32)
        inset = min(shrink_px, max(0, min(width, height) // 2))
        inner_left = inset
        inner_top = inset
        inner_right = max(inner_left + 1, width - inset)
        inner_bottom = max(inner_top + 1, height - inset)
        rect[inner_top:inner_bottom, inner_left:inner_right] = 1.0
        if feather_px > 0:
            rect = self._feather_alpha(rect, feather_px)
        return np.clip(rect, 0.0, 1.0)

    def _mask_to_bbox(self, mask_array, threshold=0.001):
        if not self._mask_has_content(mask_array):
            return None

        coords = np.argwhere(mask_array > threshold)
        if coords.size == 0:
            return None

        y0, x0 = coords.min(axis=0)
        y1, x1 = coords.max(axis=0) + 1
        return (int(x0), int(y0), int(x1 - x0), int(y1 - y0))

    def _fit_image_to_bbox_canvas(self, image_array, bbox, canvas_width, canvas_height):
        if image_array is None or bbox is None:
            return image_array

        x, y, target_width, target_height = bbox
        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))
        canvas_width = max(1, int(canvas_width or 0))
        canvas_height = max(1, int(canvas_height or 0))

        mode = "RGBA" if image_array.shape[2] == 4 else "RGB"
        source_image = Image.fromarray(np.clip(image_array, 0, 255).astype(np.uint8), mode)
        resized = source_image.resize((target_width, target_height), Image.Resampling.BILINEAR)
        canvas = Image.new(mode, (canvas_width, canvas_height), (0, 0, 0, 0) if mode == "RGBA" else (0, 0, 0))
        canvas.paste(resized, (x, y))
        return np.array(canvas, dtype=np.uint8)

    def _fit_image_to_bbox_local(self, image_array, bbox):
        if image_array is None or bbox is None:
            return image_array

        _, _, target_width, target_height = bbox
        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))

        mode = "RGBA" if image_array.shape[2] == 4 else "RGB"
        source_image = Image.fromarray(np.clip(image_array, 0, 255).astype(np.uint8), mode)
        resized = source_image.resize((target_width, target_height), Image.Resampling.BILINEAR)
        return np.array(resized, dtype=np.uint8)

    def _crop_image_to_bbox_local(self, image_array, bbox):
        if image_array is None or bbox is None:
            return image_array

        x, y, target_width, target_height = bbox
        x = max(0, int(x or 0))
        y = max(0, int(y or 0))
        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))
        y2 = min(image_array.shape[0], y + target_height)
        x2 = min(image_array.shape[1], x + target_width)
        cropped = image_array[y:y2, x:x2]

        if cropped.shape[0] == target_height and cropped.shape[1] == target_width:
            return np.array(cropped, copy=True)

        channel_count = int(image_array.shape[2]) if image_array.ndim == 3 else 3
        canvas = np.zeros((target_height, target_width, channel_count), dtype=np.uint8)
        canvas[:cropped.shape[0], :cropped.shape[1], :cropped.shape[2]] = cropped
        return canvas

    def _fit_alpha_to_bbox_canvas(self, alpha_array, bbox, canvas_width, canvas_height):
        if alpha_array is None or bbox is None:
            return alpha_array

        x, y, target_width, target_height = bbox
        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))
        canvas_width = max(1, int(canvas_width or 0))
        canvas_height = max(1, int(canvas_height or 0))

        alpha_image = Image.fromarray(
            np.clip(alpha_array.astype(np.float32) * 255.0, 0, 255).astype(np.uint8),
            "L",
        )
        resized = alpha_image.resize((target_width, target_height), Image.Resampling.BILINEAR)
        canvas = Image.new("L", (canvas_width, canvas_height), 0)
        canvas.paste(resized, (x, y))
        return np.clip(np.array(canvas).astype(np.float32) / 255.0, 0.0, 1.0)

    def _crop_alpha_to_bbox(self, alpha_array, bbox):
        if alpha_array is None or bbox is None:
            return alpha_array

        x, y, target_width, target_height = bbox
        x = max(0, int(x or 0))
        y = max(0, int(y or 0))
        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))

        y2 = min(alpha_array.shape[0], y + target_height)
        x2 = min(alpha_array.shape[1], x + target_width)
        cropped = alpha_array[y:y2, x:x2]
        if cropped.shape[0] == target_height and cropped.shape[1] == target_width:
            return np.clip(cropped.astype(np.float32), 0.0, 1.0)

        canvas = np.zeros((target_height, target_width), dtype=np.float32)
        canvas[:cropped.shape[0], :cropped.shape[1]] = np.clip(cropped.astype(np.float32), 0.0, 1.0)
        return canvas

    def _resize_image_to_canvas(self, image_array, target_width, target_height):
        if image_array is None:
            return None

        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))
        mode = "RGBA" if image_array.shape[2] == 4 else "RGB"
        source_image = Image.fromarray(np.clip(image_array, 0, 255).astype(np.uint8), mode)
        resized = source_image.resize((target_width, target_height), Image.Resampling.BILINEAR)
        return np.array(resized, dtype=np.uint8)

    def _resize_alpha_to_canvas(self, alpha_array, target_width, target_height):
        if alpha_array is None:
            return None

        target_width = max(1, int(target_width or 0))
        target_height = max(1, int(target_height or 0))
        alpha_image = Image.fromarray(
            np.clip(alpha_array.astype(np.float32) * 255.0, 0, 255).astype(np.uint8),
            "L",
        )
        resized = alpha_image.resize((target_width, target_height), Image.Resampling.BILINEAR)
        return np.clip(np.array(resized).astype(np.float32) / 255.0, 0.0, 1.0)

    def _extract_bounds_components(self, bounds):
        if not isinstance(bounds, dict):
            return None

        left = bounds.get("left")
        top = bounds.get("top")
        right = bounds.get("right")
        bottom = bounds.get("bottom")
        width = bounds.get("width")
        height = bounds.get("height")

        if left is None and "x" in bounds:
            left = bounds.get("x")
        if top is None and "y" in bounds:
            top = bounds.get("y")
        if width is None and left is not None and right is not None:
            width = float(right) - float(left)
        if height is None and top is not None and bottom is not None:
            height = float(bottom) - float(top)
        if right is None and left is not None and width is not None:
            right = float(left) + float(width)
        if bottom is None and top is not None and height is not None:
            bottom = float(top) + float(height)

        if left is None or top is None or right is None or bottom is None:
            return None

        return {
            "left": float(left),
            "top": float(top),
            "right": float(right),
            "bottom": float(bottom),
            "width": float(right) - float(left),
            "height": float(bottom) - float(top),
        }

    def _map_bbox_to_document_bounds(self, bbox, placement_snapshot, canvas_width, canvas_height):
        if bbox is None or not isinstance(placement_snapshot, dict):
            return None

        base_bounds = (
            placement_snapshot.get("sendBounds")
            or placement_snapshot.get("selectionBounds")
            or placement_snapshot.get("layerBounds")
            or placement_snapshot.get("documentBounds")
        )
        base = self._extract_bounds_components(base_bounds)
        if base is None:
            return None

        canvas_width = max(1.0, float(canvas_width or 0))
        canvas_height = max(1.0, float(canvas_height or 0))
        x, y, width, height = bbox

        left = base["left"] + (float(x) / canvas_width) * base["width"]
        top = base["top"] + (float(y) / canvas_height) * base["height"]
        right = base["left"] + (float(x + width) / canvas_width) * base["width"]
        bottom = base["top"] + (float(y + height) / canvas_height) * base["height"]

        left_i = int(round(left))
        top_i = int(round(top))
        right_i = int(round(right))
        bottom_i = int(round(bottom))

        return {
            "left": left_i,
            "top": top_i,
            "right": right_i,
            "bottom": bottom_i,
            "width": max(1, right_i - left_i),
            "height": max(1, bottom_i - top_i),
            "x": left_i,
            "y": top_i,
        }

    def _encode_pil_to_data_url(self, pil_image, format_type="PNG"):
        if pil_image is None:
            return None

        buffer = io.BytesIO()
        pil_image.save(buffer, format=str(format_type or "PNG").upper())
        encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
        mime = "image/png" if str(format_type or "PNG").upper() == "PNG" else "image/jpeg"
        return f"data:{mime};base64,{encoded}"

    def _encode_alpha_to_data_url(self, alpha_array):
        if not self._mask_has_content(alpha_array):
            return None

        alpha_image = Image.fromarray(
            np.clip(alpha_array.astype(np.float32) * 255.0, 0, 255).astype(np.uint8),
            "L",
        )
        return self._encode_pil_to_data_url(alpha_image, "PNG")

    def _build_source_state_payload(self, source_state):
        if not source_state:
            return None

        source_token = float(source_state.get("stored_at") or 0.0)
        cached_payload = source_state.get("source_payload")
        if isinstance(cached_payload, dict) and float(cached_payload.get("source_token") or 0.0) == source_token:
            return cached_payload

        image_np = source_state.get("image_np")
        if image_np is None:
            return None

        if image_np.ndim != 3 or image_np.shape[2] < 3:
            return None

        image_mode = "RGBA" if image_np.shape[2] == 4 else "RGB"
        source_image = Image.fromarray(np.clip(image_np, 0, 255).astype(np.uint8), image_mode)
        selection_alpha = self._clone_optional_array(source_state.get("selection_alpha"))
        content_alpha = self._clone_optional_array(source_state.get("content_alpha"))
        selection_mask_url = self._encode_alpha_to_data_url(selection_alpha)
        content_alpha_url = self._encode_alpha_to_data_url(content_alpha)

        payload = {
            "has_source": True,
            "source_token": source_token,
            "image_width": int(source_image.width),
            "image_height": int(source_image.height),
            "has_selection": bool(selection_mask_url),
            "has_content_alpha": bool(content_alpha_url),
            "image_data_url": self._encode_pil_to_data_url(source_image, "PNG"),
            "selection_mask_data_url": selection_mask_url,
            "content_alpha_data_url": content_alpha_url,
        }
        source_state["source_payload"] = payload
        return payload

    def _merge_alpha_layers(self, *layers):
        merged = None
        for layer in layers:
            if layer is None:
                continue
            normalized = np.clip(layer.astype(np.float32), 0.0, 1.0)
            merged = normalized if merged is None else np.clip(merged * normalized, 0.0, 1.0)
        return merged

    def _build_selection_restore_mask(self, selection_alpha, edge_shrink, edge_feather):
        if not self._mask_has_content(selection_alpha):
            return None, None

        processed = np.clip(selection_alpha.astype(np.float32), 0.0, 1.0)
        if edge_shrink > 0:
            processed = self._shrink_alpha(processed, edge_shrink)
        if edge_feather > 0:
            processed = self._feather_alpha(processed, edge_feather)

        if not self._mask_has_content(processed):
            return None, None

        return processed, self._mask_to_bbox(processed)

    def _build_sender_delivery_summary(self, sent_to_ps, alpha_mode, source_state=None):
        context = (
            dict(source_state.get("bridge_context_snapshot") or {})
            if isinstance(source_state, dict)
            else {}
        )
        if not context:
            bridge = get_or_create_ps_bridge()
            context = (
                bridge.get_bridge_context_summary()
                if bridge and hasattr(bridge, "get_bridge_context_summary")
                else {}
            )

        can_overlay = bool(context.get("can_overlay_in_place"))
        placement_mode = str(context.get("placement_mode") or "")
        capture_source = str(context.get("source") or "")
        selection_send_mode = str(context.get("selection_send_mode") or "")

        if sent_to_ps:
            if can_overlay:
                message = "已回传 Photoshop"
                delivery_mode = "overlay"
            else:
                message = "已发送到 Photoshop"
                delivery_mode = "send"
        else:
            message = "已生成，仅保留预览"
            delivery_mode = "preview_only"

        return {
            "message": message,
            "delivery_mode": delivery_mode,
            "alpha_mode": alpha_mode,
            "can_overlay_in_place": can_overlay,
            "placement_mode": placement_mode,
            "capture_source": capture_source,
            "selection_send_mode": selection_send_mode,
        }

    def _apply_sender_alpha(self, rgb_array, alpha_array):
        if alpha_array is None:
            return Image.fromarray(rgb_array[:, :, :3], "RGB")

        alpha = np.clip(alpha_array.astype(np.float32), 0.0, 1.0)
        rgb = np.clip(rgb_array[:, :, :3], 0, 255).astype(np.uint8)

        rgba_array = np.dstack(
            [
                rgb,
                np.clip(alpha * 255.0, 0, 255).astype(np.uint8),
            ]
        )
        return Image.fromarray(rgba_array, "RGBA")

    def _render_sender_pil_image(self, image_np, image_format, sender_alpha):
        format_type = str(image_format or "PNG").upper()

        if format_type == "JPEG":
            if image_np.shape[2] == 4:
                rgb = image_np[:, :, :3]
                alpha = image_np[:, :, 3:4].astype(np.float32) / 255.0
            elif sender_alpha is not None:
                rgb = image_np[:, :, :3]
                alpha = sender_alpha[:, :, None]
            else:
                rgb = image_np[:, :, :3]
                alpha = None

            if alpha is not None:
                white_bg = np.ones_like(rgb) * 255
                rgb = (rgb.astype(np.float32) * alpha + white_bg.astype(np.float32) * (1 - alpha)).astype(np.uint8)
            return Image.fromarray(rgb, "RGB")

        if image_np.shape[2] == 4:
            rgba_array = image_np.copy()
            if sender_alpha is not None:
                existing_alpha = rgba_array[:, :, 3].astype(np.float32) / 255.0
                merged_alpha = np.clip(existing_alpha * sender_alpha, 0.0, 1.0)
                return self._apply_sender_alpha(rgba_array[:, :, :3], merged_alpha)
            return Image.fromarray(rgba_array, "RGBA")

        if sender_alpha is not None:
            return self._apply_sender_alpha(image_np[:, :, :3], sender_alpha)

        return Image.fromarray(image_np[:, :, :3], "RGB")

    def _publish_sender_status(self, clean_status, event_type):
        if callable(_sender_helpers.get("write_sender_last_status")):
            _sender_helpers["write_sender_last_status"](clean_status)

        if _prompt_server:
            try:
                payload = {
                    "node_id": getattr(self, "unique_id", None) or "sender_node",
                    "status": clean_status,
                    "timestamp": time.time(),
                    "event_type": event_type,
                }
                prompt_server_instance = _prompt_server.instance

                # Sender nodes may finish inside a non-server execution context.
                # Always prefer the thread-safe queue to avoid touching aiohttp
                # sockets from a different event loop.
                if hasattr(prompt_server_instance, "send_sync"):
                    prompt_server_instance.send_sync("tunan_sender_update", payload)
                    return

                import asyncio

                server_loop = getattr(prompt_server_instance, "loop", None)
                if server_loop and getattr(server_loop, "is_running", lambda: False)():
                    asyncio.run_coroutine_threadsafe(
                        prompt_server_instance.send("tunan_sender_update", payload),
                        server_loop,
                    )
                    return

                running_loop = asyncio.get_running_loop()
                running_loop.create_task(prompt_server_instance.send("tunan_sender_update", payload))
            except Exception:
                pass

    def _render_from_source_state(
        self,
        source_state,
        return_mode,
        edge_shrink,
        edge_feather,
        *,
        send_to_ps=False,
        status_action="preview_adjust",
        event_type="preview_adjusted",
    ):
        if not source_state or source_state.get("image_np") is None:
            return None

        image_np = np.array(source_state["image_np"], copy=True)
        if image_np.ndim != 3 or image_np.shape[2] < 3:
            return None

        source_canvas_height = int(image_np.shape[0])
        source_canvas_width = int(image_np.shape[1])
        height = int(image_np.shape[0])
        width = int(image_np.shape[1])
        selection_alpha = self._clone_optional_array(source_state.get("selection_alpha"))
        content_alpha = self._clone_optional_array(source_state.get("content_alpha"))
        placement_snapshot_for_send = self._clone_serializable(source_state.get("placement_snapshot"))
        image_format = str(source_state.get("image_format") or "PNG").upper()
        jpeg_quality = int(source_state.get("jpeg_quality") or 90)
        png_compression = int(source_state.get("png_compression") or 6)
        applied_mode, requested_mode, selection_restore_active = self._resolve_applied_return_mode(
            return_mode,
            selection_alpha,
        )

        if isinstance(placement_snapshot_for_send, dict):
            placement_snapshot_for_send["canvasRole"] = "workspace"

        return_alpha = None
        if selection_restore_active:
            selection_mask, selection_bbox = self._build_selection_restore_mask(
                selection_alpha,
                edge_shrink,
                edge_feather,
            )
            if selection_mask is not None:
                return_alpha = selection_mask
            if selection_bbox is not None and selection_mask is not None:
                # Selection restore keeps the full workspace canvas.
                # Only the selection alpha is adjusted so the returned image
                # still represents the workspace instead of a cropped target box.
                return_alpha = selection_mask
            else:
                applied_mode = "whole_image"
                selection_restore_active = False

        if not selection_restore_active:
            if edge_shrink > 0 or edge_feather > 0:
                return_alpha = self._build_rect_alpha(width, height, edge_shrink, edge_feather)
                alpha_mode = "whole_image_processed"
            elif self._mask_has_content(content_alpha):
                alpha_mode = "content_alpha"
            else:
                alpha_mode = "whole_image"
        else:
            alpha_mode = "selection_restore"

        sender_alpha = self._merge_alpha_layers(content_alpha, return_alpha)
        pil_image = self._render_sender_pil_image(image_np, image_format, sender_alpha)

        preview_path = _resource_manager.save_sender_preview(pil_image)
        self.current_preview_path = preview_path

        image_buffer = io.BytesIO()
        if image_format == "JPEG":
            export_image = pil_image.convert("RGB") if pil_image.mode != "RGB" else pil_image
            export_image.save(image_buffer, format="JPEG", quality=jpeg_quality, optimize=True)
        else:
            pil_image.save(image_buffer, format="PNG", compress_level=png_compression, optimize=True)
        file_size = self._format_size(len(image_buffer.getvalue()))

        connection_status = _ps_connection.get_connection_status() if _ps_connection else {"connected": False}
        sent_to_ps = False
        sender_send = _sender_helpers.get("send_image_to_ps")
        if send_to_ps and callable(sender_send) and connection_status.get("connected"):
            sent_to_ps = bool(
                sender_send(
                    pil_image,
                    image_format,
                    jpeg_quality,
                    png_compression,
                    placement_snapshot_for_send,
                    source_state.get("image_info_snapshot"),
                    source_state.get("image_name"),
                )
            )
            if sent_to_ps:
                self.last_sent_time = time.time()

        delivery_summary = self._build_sender_delivery_summary(sent_to_ps, alpha_mode, source_state)
        if status_action == "preview_adjust":
            delivery_summary["message"] = "已更新当前预览"
            delivery_summary["delivery_mode"] = "adjust_preview"
        elif status_action == "manual_resend":
            if sent_to_ps:
                delivery_summary["message"] = (
                    "已重新回传 Photoshop"
                    if delivery_summary.get("delivery_mode") == "overlay"
                    else "已重新发送到 Photoshop"
                )
            else:
                delivery_summary["message"] = "未连接 Photoshop，仅更新当前预览"
                delivery_summary["delivery_mode"] = "adjust_preview"

        mode_hint = ""
        if requested_mode == "selection_restore" and not selection_restore_active:
            mode_hint = "当前无选区，已按整图处理"

        clean_status = {
            "has_image": True,
            "has_preview": True,
            "image_format": image_format,
            "file_size": file_size,
            "image_width": int(pil_image.width),
            "image_height": int(pil_image.height),
            "image_name": str(source_state.get("image_name") or "ComfyUI_Output"),
            "sent_to_ps": bool(sent_to_ps),
            "preview_path": str(preview_path or ""),
            "timestamp": float(time.time()),
            "source_token": float(source_state.get("stored_at") or 0.0),
            "generation_time": float(source_state.get("generation_time") or 0.0),
            "vram_used": float(source_state.get("vram_used") or 0.0),
            "generation_params": dict(source_state.get("generation_params") or {}),
            "canvas_role": "workspace",
            "return_mode": "选区还原模式" if applied_mode == "selection_restore" else "整图模式",
            "requested_return_mode": "选区还原模式" if requested_mode == "selection_restore" else "整图模式",
            "selection_restore_active": bool(selection_restore_active),
            "edge_shrink_px": int(max(0, int(edge_shrink or 0))),
            "edge_feather_px": int(max(0, int(edge_feather or 0))),
            "has_adjustable_source": True,
            "mode_hint": mode_hint,
            **delivery_summary,
        }

        self._publish_sender_status(clean_status, event_type)
        return clean_status

    @classmethod
    def render_latest_preview(
        cls,
        return_mode,
        edge_shrink,
        edge_feather,
        *,
        send_to_ps=False,
        status_action="preview_adjust",
        event_type="preview_adjusted",
    ):
        source_state = TunanPSSender._latest_source_state
        if not source_state:
            return None

        instance = cls()
        return instance._render_from_source_state(
            source_state,
            return_mode,
            edge_shrink,
            edge_feather,
            send_to_ps=send_to_ps,
            status_action=status_action,
            event_type=event_type,
        )

    @classmethod
    def get_latest_source_payload(cls):
        source_state = TunanPSSender._latest_source_state
        if not source_state:
            return None

        instance = cls()
        return instance._build_source_state_payload(source_state)

    def process_and_send(
        self,
        图像,
        图像格式="PNG",
        回贴模式="选区还原模式",
        边缘收缩=0,
        边缘柔化=0,
        图像名称="ComfyUI_Output",
        JPEG质量=90,
        PNG压缩=6,
    ):
        execution_time = None
        if self.__class__._workflow_start_perf is not None:
            execution_time = time.perf_counter() - self.__class__._workflow_start_perf
        elif self.__class__._workflow_start_time is not None:
            execution_time = time.time() - self.__class__._workflow_start_time

        if (execution_time is None or execution_time <= 0.05) and callable(_get_last_execution_time):
            last_time = _get_last_execution_time()
            if last_time > 0:
                execution_time = last_time

        vram_used = self._get_vram_info().get("peak_gb", 0.0)
        image_format = str(图像格式 or "PNG").upper()
        image_name = str(图像名称 or "ComfyUI_Output")
        jpeg_quality = int(max(60, min(100, int(JPEG质量 or 90))))
        png_compression = int(max(0, min(9, int(PNG压缩 or 6))))
        edge_shrink = int(max(0, int(边缘收缩 or 0)))
        edge_feather = int(max(0, int(边缘柔化 or 0)))

        image_tensor = 图像[0]
        _runtime_log(
            "sender:start",
            image=_describe_tensor(image_tensor),
            image_format=image_format,
            return_mode=str(回贴模式),
            edge_shrink=edge_shrink,
            edge_feather=edge_feather,
            image_name=image_name,
        )
        image_np = (image_tensor.cpu().numpy() * 255).astype(np.uint8)
        _runtime_log("sender:image_np_ready", image_np=_describe_array(image_np))

        if self._is_bridge_waiting_placeholder(image_np):
            clean_status = self._build_empty_sender_status()
            self._clear_sender_preview_state()
            self._publish_sender_status(clean_status, "sender_waiting")
            _runtime_log("sender:waiting_placeholder")
            self.__class__._workflow_start_time = None
            self.__class__._workflow_start_perf = None
            return {
                "ui": {
                    "text": ["等待生成结果"],
                    "_generation_time": "0",
                    "_vram_used": "0",
                    "_generation_params": "{}",
                    "_sent_to_ps": "0",
                }
            }

        generation_params = {
            "denoise": get_or_create_ps_bridge().parameters.get("denoise", 0.75),
            "steps": get_or_create_ps_bridge().parameters.get("steps", 20),
            "cfg": get_or_create_ps_bridge().parameters.get("cfg_scale", 7.0),
            "sampler": "euler",
        }
        bridge = get_or_create_ps_bridge()
        placement_snapshot = self._clone_serializable(
            bridge.original_placement if bridge else None
        )
        image_info_snapshot = self._clone_serializable(
            bridge.image_info if bridge else None
        )
        bridge_context_snapshot = self._clone_serializable(
            bridge.get_bridge_context_summary()
            if bridge and hasattr(bridge, "get_bridge_context_summary")
            else {}
        )
        selection_alpha = self._resolve_selection_alpha(image_tensor, None)
        content_alpha = self._resolve_content_alpha(image_tensor)
        _runtime_log(
            "sender:alpha_resolved",
            selection_alpha=_describe_array(selection_alpha),
            content_alpha=_describe_array(content_alpha),
        )
        source_state = self._store_latest_source_state(
            image_np,
            selection_alpha,
            content_alpha,
            image_name,
            image_format,
            jpeg_quality,
            png_compression,
            generation_params,
            execution_time,
            vram_used,
            placement_snapshot,
            image_info_snapshot,
            bridge_context_snapshot,
        )
        _runtime_log(
            "sender:source_state_stored",
            source_image_np=_describe_array(source_state.get("image_np") if isinstance(source_state, dict) else None),
            source_token=float(source_state.get("stored_at") or 0.0) if isinstance(source_state, dict) else 0.0,
        )

        clean_status = self._render_from_source_state(
            source_state,
            回贴模式,
            edge_shrink,
            edge_feather,
            send_to_ps=True,
            status_action="generation_complete",
            event_type="generation_complete",
        )
        if clean_status is None:
            clean_status = self._build_empty_sender_status()
            self._publish_sender_status(clean_status, "sender_empty")
            _runtime_log("sender:empty_status")
        else:
            _runtime_log(
                "sender:done",
                sent_to_ps=bool(clean_status.get("sent_to_ps")),
                preview_path=str(clean_status.get("preview_path") or ""),
                image_width=int(clean_status.get("image_width") or 0),
                image_height=int(clean_status.get("image_height") or 0),
                alpha_mode=str(clean_status.get("alpha_mode") or ""),
                delivery_mode=str(clean_status.get("delivery_mode") or ""),
            )

        ui_data = {
            "text": [f"{image_name}.{image_format.lower()} | {clean_status.get('file_size', '')}"],
            "_generation_time": str(clean_status["generation_time"]),
            "_vram_used": str(clean_status["vram_used"]),
            "_generation_params": json.dumps(clean_status["generation_params"], ensure_ascii=False),
            "_sent_to_ps": "1" if clean_status["sent_to_ps"] else "0",
        }
        self.__class__._workflow_start_time = None
        self.__class__._workflow_start_perf = None
        return {"ui": ui_data}
