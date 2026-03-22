"""Bridge HTTP routes for TuNan Paint Bridge."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from aiohttp import web
from PIL import Image


def get_actual_comfyui_port(prompt_server):
    if hasattr(prompt_server.instance, "port"):
        return prompt_server.instance.port

    for index, arg in enumerate(sys.argv):
        if arg in ["--port", "-p"] and index + 1 < len(sys.argv):
            try:
                port = int(sys.argv[index + 1])
                if 1 <= port <= 65535:
                    return port
            except ValueError:
                pass

    env_port = os.environ.get("COMFYUI_PORT", os.environ.get("PORT"))
    if env_port:
        try:
            port = int(env_port)
            if 1 <= port <= 65535:
                return port
        except ValueError:
            pass

    return 8188


def _parse_json_like(value):
    if not isinstance(value, str):
        return value

    stripped = value.strip()
    if not stripped or stripped[0] not in "{[":
        return value

    try:
        return json.loads(stripped)
    except Exception:
        return value


def normalize_upload_metadata(metadata):
    if not isinstance(metadata, dict):
        return {}

    normalized = dict(metadata)

    for key in ("original_placement", "originalPlacement"):
        if key in normalized:
            normalized[key] = _parse_json_like(normalized[key])

    if normalized.get("originalPlacement") and not normalized.get("original_placement"):
        normalized["original_placement"] = normalized["originalPlacement"]

    if normalized.get("mask") and not normalized.get("selection_mask"):
        normalized["selection_mask"] = normalized["mask"]
    if normalized.get("selectionMask") and not normalized.get("selection_mask"):
        normalized["selection_mask"] = normalized["selectionMask"]
    if normalized.get("alpha") and not normalized.get("content_alpha"):
        normalized["content_alpha"] = normalized["alpha"]
    if normalized.get("contentAlpha") and not normalized.get("content_alpha"):
        normalized["content_alpha"] = normalized["contentAlpha"]

    return normalized


def register_bridge_routes(
    prompt_server,
    resource_manager,
    ps_connection_getter,
    ps_bridge_getter,
    sender_helpers,
    broadcast_manager_getter=None,
):
    routes = prompt_server.instance.routes

    def _get_ps_connection():
        return ps_connection_getter() if ps_connection_getter else None

    def _get_ps_bridge():
        return ps_bridge_getter() if ps_bridge_getter else None

    def _get_broadcast_manager():
        return broadcast_manager_getter() if broadcast_manager_getter else None

    @routes.get("/tunan/ps/current_image")
    async def get_current_image(request):
        try:
            if resource_manager.current_image_path and os.path.exists(resource_manager.current_image_path):
                return web.FileResponse(resource_manager.current_image_path)
            return web.Response(status=404, text="No current bridge image")
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/waiting_image")
    async def get_waiting_image(request):
        try:
            if resource_manager.sender_waiting_image_path and os.path.exists(resource_manager.sender_waiting_image_path):
                return web.FileResponse(resource_manager.sender_waiting_image_path)
            return web.FileResponse(resource_manager.waiting_image_path)
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/upload")
    async def handle_ps_upload(request):
        try:
            os.makedirs(resource_manager.plugin_dir, exist_ok=True)
            reader = await request.multipart()
            image_file = None
            metadata = {}

            while True:
                part = await reader.next()
                if part is None:
                    break

                if part.name == "image":
                    filename = f"ps_upload_{int(time.time() * 1000)}.{part.filename.split('.')[-1]}"
                    filepath = os.path.join(resource_manager.plugin_dir, filename)
                    with open(filepath, "wb") as handle:
                        while True:
                            chunk = await part.read_chunk(1024 * 1024)
                            if not chunk:
                                break
                            handle.write(chunk)
                    image_file = filepath
                    metadata["filename"] = filename
                    metadata["source"] = "http_upload"
                elif part.name in ("mask", "selection_mask"):
                    mask_filename = f"selection_mask_{int(time.time() * 1000)}.png"
                    mask_filepath = os.path.join(resource_manager.plugin_dir, mask_filename)
                    with open(mask_filepath, "wb") as handle:
                        while True:
                            chunk = await part.read_chunk(1024 * 1024)
                            if not chunk:
                                break
                            handle.write(chunk)
                    metadata["mask"] = mask_filename
                    metadata["selection_mask"] = mask_filename
                elif part.name in ("alpha", "content_alpha"):
                    alpha_filename = f"content_alpha_{int(time.time() * 1000)}.png"
                    alpha_filepath = os.path.join(resource_manager.plugin_dir, alpha_filename)
                    with open(alpha_filepath, "wb") as handle:
                        while True:
                            chunk = await part.read_chunk(1024 * 1024)
                            if not chunk:
                                break
                            handle.write(chunk)
                    metadata["alpha"] = alpha_filename
                    metadata["content_alpha"] = alpha_filename
                else:
                    value = await part.text()
                    if part.name == "metadata":
                        try:
                            metadata.update(json.loads(value))
                        except json.JSONDecodeError:
                            metadata[part.name] = value
                    else:
                        metadata[part.name] = value

            metadata = normalize_upload_metadata(metadata)

            if not image_file:
                return web.json_response({"status": "error", "message": "未接收到图像文件"}, status=400)

            pil_image = Image.open(image_file)
            ps_bridge = _get_ps_bridge()
            ps_connection = _get_ps_connection()

            if not ps_bridge or not ps_bridge.process_image_data(pil_image, metadata):
                return web.json_response({"status": "error", "message": "图像处理失败"}, status=500)

            if ps_connection and ps_connection.clients:
                message = json.dumps({"type": "image_uploaded", "status": "success"}, ensure_ascii=False)
                for ws in list(ps_connection.clients):
                    try:
                        if hasattr(ws, "send_text"):
                            ws.send_text(message)
                        elif hasattr(ws, "send_str") and asyncio.iscoroutinefunction(ws.send_str):
                            await ws.send_str(message)
                    except Exception:
                        continue

            return web.json_response(
                {
                    "status": "success",
                    "filename": metadata["filename"],
                    "size": os.path.getsize(image_file),
                    "width": pil_image.width,
                    "height": pil_image.height,
                    "metadata": metadata,
                }
            )
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/parameters")
    async def receive_ps_parameters_http(request):
        try:
            data = await request.json()
            ps_bridge = _get_ps_bridge()
            if ps_bridge and ps_bridge.update_parameters(data):
                return web.json_response({"status": "success"})
            return web.json_response({"status": "error"}, status=400)
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/crop-parameters")
    async def receive_crop_parameters_http(request):
        try:
            data = await request.json()
            ps_bridge = _get_ps_bridge()
            broadcast_manager = _get_broadcast_manager()

            if not ps_bridge:
                return web.json_response({"status": "error", "message": "桥接器未初始化"}, status=500)

            ps_bridge.crop_parameters = {
                "enabled": data.get("enabled", True),
                "featherRadius": data.get("featherRadius", 2.5),
                "cropIntensity": data.get("cropIntensity", 1.0),
                "selectionBounds": data.get("selectionBounds"),
                "updated_at": time.time(),
            }

            if broadcast_manager:
                await broadcast_manager.broadcast_to_all_websockets(
                    {
                        "action": "crop_parameters_updated",
                        "crop_enabled": ps_bridge.crop_parameters["enabled"],
                        "feather_radius": ps_bridge.crop_parameters["featherRadius"],
                        "crop_intensity": ps_bridge.crop_parameters["cropIntensity"],
                    }
                )

            return web.json_response({"status": "success", "message": "裁剪参数已更新"})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/status")
    async def get_status(request):
        try:
            ps_bridge = _get_ps_bridge()
            ps_connection = _get_ps_connection()
            if not ps_bridge or not ps_connection:
                return web.json_response({"status": "error", "message": "桥接器未初始化"}, status=500)

            display_width, display_height = sender_helpers["get_bridge_display_size"]()
            connection_status = ps_connection.get_connection_status()
            bridge_context = (
                ps_bridge.get_bridge_context_summary()
                if hasattr(ps_bridge, "get_bridge_context_summary")
                else {}
            )
            image_info = (
                ps_bridge.get_public_image_info()
                if hasattr(ps_bridge, "get_public_image_info")
                else {}
            )
            return web.json_response(
                {
                    "websocket_connected": ps_connection.websocket_connected,
                    "websocket_clients": ps_connection.websocket_clients,
                    "has_image": ps_bridge.last_image_data is not None,
                    "image_update_id": ps_bridge.image_update_id,
                    "last_update_time": ps_bridge.last_update_time,
                    "image_width": int(getattr(ps_bridge, "last_image_width", 0) or 0),
                    "image_height": int(getattr(ps_bridge, "last_image_height", 0) or 0),
                    "parameters": ps_bridge.parameters,
                    "bridge_instance_id": id(ps_bridge),
                    "execution_status": ps_bridge.execution_status,
                    "receive_status": ps_bridge.receive_status,
                    "bridge_context": bridge_context,
                    "image_info": image_info,
                    **sender_helpers["build_size_payload"](display_width, display_height),
                    **connection_status,
                }
            )
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/cleanup")
    async def cleanup_temp_files(request):
        try:
            resource_manager.cleanup_temp_files()
            return web.json_response({"status": "success", "message": "临时文件已清理"})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/cleanup_all")
    async def cleanup_all_cache(request):
        try:
            resource_manager.cleanup_all_cache()
            return web.json_response({"status": "success", "message": "所有缓存已清理"})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/debug")
    async def debug_status(request):
        try:
            ps_bridge = _get_ps_bridge()
            ps_connection = _get_ps_connection()
            return web.json_response(
                {
                    "bridge_has_image": ps_bridge.last_image_data is not None if ps_bridge else False,
                    "bridge_image_shape": str(ps_bridge.last_image_data.shape) if ps_bridge and ps_bridge.last_image_data is not None else None,
                    "image_update_id": ps_bridge.image_update_id if ps_bridge else 0,
                    "last_update_time": ps_bridge.last_update_time if ps_bridge else 0,
                    "current_image_path": resource_manager.current_image_path,
                    "current_image_exists": os.path.exists(resource_manager.current_image_path) if resource_manager.current_image_path else False,
                    "plugin_dir": resource_manager.plugin_dir,
                    "ps_connected": ps_connection.ps_connected if ps_connection else False,
                    "client_count": len(ps_connection.clients) if ps_connection else 0,
                    "parameters": ps_bridge.parameters if ps_bridge else {},
                    "image_info": ps_bridge.image_info if ps_bridge else {},
                    "bridge_context": (
                        ps_bridge.get_bridge_context_summary()
                        if ps_bridge and hasattr(ps_bridge, "get_bridge_context_summary")
                        else {}
                    ),
                    "waiting_image_path": resource_manager.waiting_image_path,
                    "sender_waiting_image_path": resource_manager.sender_waiting_image_path,
                    "has_selection_mask": ps_bridge.last_selection_mask_data is not None if ps_bridge else False,
                    "selection_mask_shape": str(ps_bridge.last_selection_mask_data.shape) if ps_bridge and ps_bridge.last_selection_mask_data is not None else None,
                    "has_content_alpha": ps_bridge.last_content_alpha_data is not None if ps_bridge else False,
                    "content_alpha_shape": str(ps_bridge.last_content_alpha_data.shape) if ps_bridge and ps_bridge.last_content_alpha_data is not None else None,
                }
            )
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @routes.get("/tunan/ps/port_info")
    async def get_port_info(request):
        actual_port = get_actual_comfyui_port(prompt_server)
        return web.json_response(
            {
                "status": "ok",
                "port": actual_port,
                "host": "127.0.0.1",
                "endpoints": {
                    "websocket": "/tunan/ps/ws",
                    "upload": "/tunan/ps/upload",
                    "status": "/tunan/ps/status",
                    "current_image": "/tunan/ps/current_image",
                },
                "urls": {
                    "ws": f"ws://127.0.0.1:{actual_port}/tunan/ps/ws",
                    "http": f"http://127.0.0.1:{actual_port}",
                },
                "version": "1.0.9",
                "service": "TuNanPaintBridge",
            }
        )

    @routes.get("/tunan/ps/ready_check")
    async def ready_check(request):
        actual_port = get_actual_comfyui_port(prompt_server)
        return web.json_response(
            {
                "ready": True,
                "timestamp": time.time(),
                "port": actual_port,
                "service": "TuNanPaintBridge",
            }
        )

    @routes.post("/tunan/ps/shutdown")
    async def shutdown_bridge_backend(request):
        try:
            actual_port = get_actual_comfyui_port(prompt_server)
            loop = asyncio.get_running_loop()
            loop.call_later(0.25, lambda: os._exit(0))
            return web.json_response(
                {
                    "status": "success",
                    "message": "backend_shutting_down",
                    "port": actual_port,
                }
            )
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/execution_complete")
    async def handle_execution_complete(request):
        try:
            data = await request.json()
            ps_bridge = _get_ps_bridge()
            ps_connection = _get_ps_connection()

            if ps_bridge:
                ps_bridge.execution_status["is_executing"] = False
                ps_bridge.execution_status["progress"] = 100
                ps_bridge.execution_status["last_execution_time"] = data.get("execution_time", 0)
                ps_bridge.execution_status["error"] = False

            if ps_connection:
                await ps_connection.broadcast(
                    {
                        "type": "execution_complete",
                        "execution_time": data.get("execution_time", 0),
                        "timestamp": time.time(),
                    }
                )

            return web.json_response({"status": "success"})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    return {
        "get_current_image": get_current_image,
        "get_waiting_image": get_waiting_image,
        "handle_ps_upload": handle_ps_upload,
        "receive_ps_parameters_http": receive_ps_parameters_http,
        "receive_crop_parameters_http": receive_crop_parameters_http,
        "get_status": get_status,
        "cleanup_temp_files": cleanup_temp_files,
        "cleanup_all_cache": cleanup_all_cache,
        "debug_status": debug_status,
        "get_port_info": get_port_info,
        "ready_check": ready_check,
        "shutdown_bridge_backend": shutdown_bridge_backend,
        "handle_execution_complete": handle_execution_complete,
        "get_actual_comfyui_port": lambda: get_actual_comfyui_port(prompt_server),
    }



