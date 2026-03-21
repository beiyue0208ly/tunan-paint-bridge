"""Sender routes and Photoshop delivery helpers for TuNan Paint Bridge."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from io import BytesIO

from aiohttp import web
from PIL import Image


def safe_image_size(image_path):
    """Read image size safely for UI display."""
    try:
        if image_path and os.path.exists(image_path):
            with Image.open(image_path) as img:
                return int(img.width), int(img.height)
    except Exception:
        pass
    return 0, 0


def build_size_payload(width, height):
    width = int(width or 0)
    height = int(height or 0)
    return {
        "display_width": width,
        "display_height": height,
        "display_size_text": f"{width} x {height}" if width > 0 and height > 0 else "",
    }


def get_image_visible_bounds(pil_image):
    try:
        if pil_image is None:
            return None

        width, height = pil_image.size
        if width <= 0 or height <= 0:
            return None

        if "A" in pil_image.getbands():
            alpha = pil_image.getchannel("A")
            bbox = alpha.getbbox()
        else:
            bbox = (0, 0, width, height)

        if not bbox:
            return None

        left, top, right, bottom = bbox
        return {
            "left": int(left),
            "top": int(top),
            "right": int(right),
            "bottom": int(bottom),
            "width": int(max(0, right - left)),
            "height": int(max(0, bottom - top)),
        }
    except Exception:
        return None


def get_bridge_display_size(resource_manager, ps_bridge):
    if ps_bridge and ps_bridge.last_image_data is not None:
        if getattr(ps_bridge, "last_image_width", 0) and getattr(ps_bridge, "last_image_height", 0):
            return int(ps_bridge.last_image_width), int(ps_bridge.last_image_height)
        try:
            return int(ps_bridge.last_image_data.shape[2]), int(ps_bridge.last_image_data.shape[1])
        except Exception:
            pass
    return safe_image_size(resource_manager.waiting_image_path)


def get_sender_waiting_size(resource_manager):
    waiting_path = resource_manager.sender_waiting_image_path or resource_manager.waiting_image_path
    return safe_image_size(waiting_path)


def write_sender_last_status(resource_manager, status):
    status_file = os.path.join(resource_manager.plugin_dir, "sender_last_status.json")
    with open(status_file, "w", encoding="utf-8") as handle:
        json.dump(status, handle, ensure_ascii=False)
    return status_file


def read_sender_last_status(resource_manager):
    status_file = os.path.join(resource_manager.plugin_dir, "sender_last_status.json")
    if not os.path.exists(status_file):
        return None

    try:
        with open(status_file, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def send_image_to_ps(
    pil_image,
    ps_connection,
    ps_bridge,
    format_type="JPEG",
    jpeg_quality=90,
    png_compression=6,
    placement_snapshot=None,
    image_info_snapshot=None,
    image_name_override=None,
):
    """Send a generated image back to the connected Photoshop client."""
    try:
        if not ps_connection or not ps_connection.ps_connected or len(ps_connection.clients) == 0:
            return False

        if pil_image.mode not in ["RGB", "RGBA"]:
            pil_image = pil_image.convert("RGB")

        image_name = str(image_name_override or f"ComfyUI_Output_{int(time.time())}")
        image_buffer = BytesIO()

        if format_type == "JPEG":
            if pil_image.mode == "RGBA":
                rgb_image = Image.new("RGB", pil_image.size, (255, 255, 255))
                rgb_image.paste(pil_image, mask=pil_image.split()[3])
                pil_image = rgb_image
            pil_image.save(image_buffer, format="JPEG", quality=jpeg_quality, optimize=True)
        else:
            pil_image.save(image_buffer, format="PNG", compress_level=png_compression, optimize=True)

        visible_bounds = get_image_visible_bounds(pil_image)
        placement_payload = (
            placement_snapshot
            if isinstance(placement_snapshot, dict)
            else (ps_bridge.original_placement if ps_bridge else None)
        )
        canvas_role = (
            str((placement_payload or {}).get("canvasRole") or "").strip().lower()
            if isinstance(placement_payload, dict)
            else ""
        ) or "workspace"
        image_info = (
            image_info_snapshot
            if isinstance(image_info_snapshot, dict)
            else ((ps_bridge.image_info or {}) if ps_bridge else {})
        )

        send_data = {
            "type": "receive_image",
            "data": {
                "image": base64.b64encode(image_buffer.getvalue()).decode("utf-8"),
                "encoding": "base64",
                "format": format_type.lower(),
                "name": image_name,
                "timestamp": int(time.time()),
                "source": "ComfyUI",
                "has_alpha": pil_image.mode == "RGBA",
                "dimensions": {
                    "width": pil_image.width,
                    "height": pil_image.height,
                },
                "visible_bounds": visible_bounds,
                "quality": jpeg_quality if format_type == "JPEG" else png_compression,
                "original_placement": placement_payload,
                "canvas_role": canvas_role,
                "source_layer_name": image_info.get("source_layer_name"),
                "document_name": image_info.get("document_name"),
                "capture_source": image_info.get("source"),
            },
        }

        async def _send():
            payload = json.dumps(send_data, ensure_ascii=False)
            for client in list(ps_connection.clients):
                try:
                    await client.send_str(payload)
                except Exception:
                    continue

        prompt_server_instance = getattr(getattr(ps_connection, "prompt_server", None), "instance", None)
        server_loop = getattr(prompt_server_instance, "loop", None) if prompt_server_instance else None
        if server_loop and getattr(server_loop, "is_running", lambda: False)():
            asyncio.run_coroutine_threadsafe(_send(), server_loop)
            return True

        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        if running_loop and running_loop.is_running():
            running_loop.create_task(_send())
        else:
            asyncio.run(_send())

        return True
    except Exception:
        return False


def register_sender_routes(prompt_server, resource_manager, ps_connection_getter, ps_bridge_getter, sender_runtime_getter=None):
    routes = prompt_server.instance.routes

    def _get_ps_connection():
        return ps_connection_getter() if ps_connection_getter else None

    def _get_ps_bridge():
        return ps_bridge_getter() if ps_bridge_getter else None

    def _get_sender_runtime():
        return sender_runtime_getter() if sender_runtime_getter else None

    async def _read_sender_adjust_payload(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        return {
            "return_mode": str(payload.get("return_mode") or "选区还原模式"),
            "edge_shrink": max(0, int(payload.get("edge_shrink") or 0)),
            "edge_feather": max(0, int(payload.get("edge_feather") or 0)),
        }

    def _get_active_preview_path():
        preview_path = getattr(resource_manager, "sender_preview_path", None)
        if preview_path and os.path.exists(preview_path):
            return preview_path
        last_status = read_sender_last_status(resource_manager)
        fallback_path = str((last_status or {}).get("preview_path") or "").strip()
        if fallback_path and os.path.exists(fallback_path):
            return fallback_path
        return None

    @routes.get("/tunan/ps/sender_status")
    async def get_sender_status(request):
        try:
            latest_file = _get_active_preview_path()
            last_status = read_sender_last_status(resource_manager) or {}

            if latest_file:
                try:
                    with Image.open(latest_file) as img:
                        width, height = img.size
                        image_format = img.format
                except Exception:
                    width, height, image_format = 0, 0, "unknown"

                image_info = {
                    **(last_status.get("image_info") or {}),
                    "width": width,
                    "height": height,
                    "format": image_format,
                    "file_size": os.path.getsize(latest_file),
                }
                response = {
                    **last_status,
                    "status": "success",
                    "has_preview": True,
                    "has_image": bool(last_status.get("has_image", True)),
                    "preview_path": latest_file,
                    **build_size_payload(width, height),
                    "image_info": image_info,
                }
                return web.json_response(
                    response
                )

            if last_status:
                status_width = int(last_status.get("image_width", 0) or 0)
                status_height = int(last_status.get("image_height", 0) or 0)
                image_info = {
                    **(last_status.get("image_info") or {}),
                    "width": status_width,
                    "height": status_height,
                    "format": last_status.get("image_format") or "PNG",
                    "file_size": last_status.get("file_size") or 0,
                }
                response = {
                    **last_status,
                    "status": "success",
                    "has_preview": bool(last_status.get("has_preview") or last_status.get("preview_path")),
                    "has_image": bool(last_status.get("has_image")),
                    **build_size_payload(status_width, status_height),
                    "image_info": image_info,
                }
                return web.json_response(response)

            waiting_width, waiting_height = get_sender_waiting_size(resource_manager)
            return web.json_response(
                {
                    "status": "success",
                    "has_preview": False,
                    "has_image": False,
                    "preview_path": "",
                    "generation_time": 0,
                    "vram_used": 0,
                    "sent_to_ps": False,
                    "message": "当前还没有发送器预览图",
                    **build_size_payload(waiting_width, waiting_height),
                    "image_info": {
                        "width": waiting_width,
                        "height": waiting_height,
                        "format": "PNG",
                        "file_size": os.path.getsize(resource_manager.sender_waiting_image_path)
                        if resource_manager.sender_waiting_image_path and os.path.exists(resource_manager.sender_waiting_image_path)
                        else 0,
                    },
                }
            )
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/sender_last_status")
    async def get_sender_last_status(request):
        try:
            latest_file = _get_active_preview_path()
            status_data = read_sender_last_status(resource_manager)
            if status_data:
                waiting_width, waiting_height = get_sender_waiting_size(resource_manager)
                status_width = int(status_data.get("image_width", 0) or 0)
                status_height = int(status_data.get("image_height", 0) or 0)
                status_data = {**status_data}
                if latest_file:
                    status_data["preview_path"] = latest_file
                if status_width > 0 and status_height > 0:
                    status_data.update(build_size_payload(status_width, status_height))
                else:
                    status_data.update(build_size_payload(waiting_width, waiting_height))
                return web.json_response(status_data)

            waiting_width, waiting_height = get_sender_waiting_size(resource_manager)
            return web.json_response(
                {
                    "has_image": False,
                    "has_preview": False,
                    "preview_path": "",
                    "generation_time": 0,
                    "vram_used": 0,
                    "sent_to_ps": False,
                    "message": "还没有可用的发送器状态",
                    **build_size_payload(waiting_width, waiting_height),
                }
            )
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/sender_preview")
    async def get_sender_preview(request):
        try:
            latest_file = _get_active_preview_path()
            if latest_file:
                return web.FileResponse(latest_file)
            return web.FileResponse(resource_manager.sender_waiting_image_path)
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/sender_adjust_preview")
    async def adjust_sender_preview(request):
        try:
            payload = await _read_sender_adjust_payload(request)
            sender_runtime = _get_sender_runtime()
            if not sender_runtime or not hasattr(sender_runtime, "render_latest_preview"):
                return web.json_response({"status": "error", "message": "sender runtime unavailable"}, status=500)

            status = sender_runtime.render_latest_preview(
                payload["return_mode"],
                payload["edge_shrink"],
                payload["edge_feather"],
                send_to_ps=False,
                status_action="preview_adjust",
                event_type="preview_adjusted",
            )
            if not status:
                waiting_width, waiting_height = get_sender_waiting_size(resource_manager)
                return web.json_response(
                    {
                        "status": "empty",
                        "has_preview": False,
                        "has_image": False,
                        "message": "当前还没有可调整的发送结果",
                        **build_size_payload(waiting_width, waiting_height),
                    }
                )

            return web.json_response({"status": "success", **status})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/sender_resend_current")
    async def resend_current_sender_preview(request):
        try:
            payload = await _read_sender_adjust_payload(request)
            sender_runtime = _get_sender_runtime()
            if not sender_runtime or not hasattr(sender_runtime, "render_latest_preview"):
                return web.json_response({"status": "error", "message": "sender runtime unavailable"}, status=500)

            status = sender_runtime.render_latest_preview(
                payload["return_mode"],
                payload["edge_shrink"],
                payload["edge_feather"],
                send_to_ps=True,
                status_action="manual_resend",
                event_type="manual_resend",
            )
            if not status:
                waiting_width, waiting_height = get_sender_waiting_size(resource_manager)
                return web.json_response(
                    {
                        "status": "empty",
                        "has_preview": False,
                        "has_image": False,
                        "message": "当前还没有可重新发送的结果",
                        **build_size_payload(waiting_width, waiting_height),
                    }
                )

            return web.json_response({"status": "success", **status})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/sender_source_state")
    async def get_sender_source_state(request):
        try:
            sender_runtime = _get_sender_runtime()
            if not sender_runtime or not hasattr(sender_runtime, "get_latest_source_payload"):
                return web.json_response({"status": "error", "message": "sender runtime unavailable"}, status=500)

            payload = sender_runtime.get_latest_source_payload()
            if not payload:
                return web.json_response({"status": "empty", "has_source": False})

            return web.json_response({"status": "success", **payload})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    return {
        "get_sender_status": get_sender_status,
        "get_sender_last_status": get_sender_last_status,
        "get_sender_preview": get_sender_preview,
        "adjust_sender_preview": adjust_sender_preview,
        "resend_current_sender_preview": resend_current_sender_preview,
        "get_sender_source_state": get_sender_source_state,
        "send_image_to_ps": lambda pil_image, format_type="JPEG", jpeg_quality=90, png_compression=6, placement_snapshot=None, image_info_snapshot=None, image_name_override=None: send_image_to_ps(
            pil_image,
            _get_ps_connection(),
            _get_ps_bridge(),
            format_type,
            jpeg_quality,
            png_compression,
            placement_snapshot,
            image_info_snapshot,
            image_name_override,
        ),
        "safe_image_size": safe_image_size,
        "build_size_payload": build_size_payload,
        "get_bridge_display_size": lambda: get_bridge_display_size(resource_manager, _get_ps_bridge()),
        "get_sender_waiting_size": lambda: get_sender_waiting_size(resource_manager),
        "write_sender_last_status": lambda status: write_sender_last_status(resource_manager, status),
    }



