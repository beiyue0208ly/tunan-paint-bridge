"""WebSocket protocol handlers for TuNan Paint Bridge."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import time
import uuid

import aiohttp
import nodes
from aiohttp import web
from PIL import Image

LOGGER = logging.getLogger("tunan.paint.bridge.ws")
WS_MAX_MSG_SIZE = 32 * 1024 * 1024


def register_ws_routes(
    prompt_server,
    ps_connection,
    ps_bridge_getter,
    resource_manager,
    workflow_service,
    broadcast_manager,
):
    routes = prompt_server.instance.routes

    def get_ps_bridge():
        return ps_bridge_getter() if ps_bridge_getter else None

    def write_ws_log(event, **payload):
        try:
            LOGGER.debug("[WS] %s %s", event, json.dumps(payload, ensure_ascii=False, default=str))
        except Exception:
            LOGGER.debug("[WS] %s %s", event, payload)

    async def send_json(ws, payload):
        await ws.send_str(json.dumps(payload, ensure_ascii=False))

    async def send_response(ws, request_id, message_type, **payload):
        response = {"type": message_type}
        if request_id:
            response["request_id"] = request_id
        response.update(payload)
        await send_json(ws, response)

    @routes.get("/tunan/ps/ws")
    async def websocket_handler(request):
        ws = web.WebSocketResponse(max_msg_size=WS_MAX_MSG_SIZE, timeout=60.0, heartbeat=30.0)
        await ws.prepare(request)
        client_ip = request.remote or "unknown"
        write_ws_log("open", client=client_ip)

        await send_json(
            ws,
            {
                "type": "welcome",
                "message": "已连接到图南画桥",
                "plugin_folder": resource_manager.plugin_dir,
            },
        )

        close_reason = "loop_complete"
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        await send_json(ws, {"type": "error", "message": "无效的 JSON 数据"})
                        continue

                    msg_type = data.get("type")
                    request_id = data.get("request_id")
                    ps_bridge = get_ps_bridge()

                    if msg_type == "client_auth":
                        client_type = data.get("client_type", "unknown")
                        write_ws_log(
                            "client_auth",
                            client_type=client_type,
                            client_id=data.get("client_id"),
                            request_id=request_id,
                        )
                        if client_type == "photoshop":
                            await ps_connection.add_client(ws)
                            await send_json(
                                ws,
                                {
                                    "type": "welcome",
                                    "message": "Photoshop 客户端连接成功",
                                    "server_time": time.time(),
                                    "client_id": data.get("client_id", "unknown"),
                                },
                            )
                            try:
                                asyncio.create_task(ps_connection.send_initial_workflow_state(ws))
                            except Exception:
                                pass
                        continue

                    if msg_type == "parameters":
                        success = ps_bridge.update_parameters(data.get("data", {})) if ps_bridge else False
                        await send_response(
                            ws,
                            request_id,
                            "parameters_ack",
                            status="success" if success else "error",
                        )
                        continue

                    if msg_type == "get_workflows":
                        result = workflow_service.list_workflows(bool(data.get("force")))
                        await send_response(
                            ws,
                            request_id,
                            "workflows_list",
                            workflows=result["workflows"],
                            count=result["count"],
                            timestamp=result["timestamp"],
                        )
                        continue

                    if msg_type == "get_tabs":
                        write_ws_log("get_tabs:request", request_id=request_id)
                        state = await workflow_service.request_tabs_state()
                        write_ws_log(
                            "get_tabs:response",
                            request_id=request_id,
                            current_tab=state.get("current_tab"),
                            tabs=len(state.get("tabs", [])),
                            session_id=state.get("session_id"),
                        )
                        await send_response(ws, request_id, "get_tabs_response", data=state)
                        continue

                    if msg_type == "set_control_target":
                        state = await workflow_service.set_control_target(
                            session_id=data.get("session_id", ""),
                            mode=data.get("mode", "auto"),
                        )
                        await send_response(ws, request_id, "control_target_updated", data=state)
                        continue

                    if msg_type == "switch_tab":
                        state = await workflow_service.switch_tab(data.get("tab_id"))
                        await send_response(ws, request_id, "switch_tab_response", data=state)
                        continue

                    if msg_type == "load_workflow":
                        result = await workflow_service.load_workflow(data.get("workflow_id"))
                        await send_response(
                            ws,
                            request_id,
                            "load_workflow_response",
                            **result,
                        )
                        continue

                    if msg_type == "tab_update":
                        state = await workflow_service.handle_tab_update_payload(data)
                        await send_response(ws, request_id, "tabs_updated", data=state)
                        continue

                    if msg_type == "workflow_changed":
                        result = await workflow_service.handle_workflow_changed_payload(data)
                        await send_response(ws, request_id, "workflow_sync", data=result)
                        continue

                    if msg_type == "binary_start":
                        if ps_bridge:
                            ps_bridge.receive_status = {
                                "phase": "receiving",
                                "is_receiving": True,
                                "progress": 0,
                                "received_at": 0,
                                "error_message": "",
                            }
                        await broadcast_manager.broadcast(
                            "tunan_receive_state",
                            {
                                "phase": "receiving",
                                "is_receiving": True,
                                "progress": 0,
                                "received_at": 0,
                                "error_message": "",
                            },
                        )
                        ps_connection.current_file = {
                            "name": data.get("name", ""),
                            "size": int(data.get("size", 0) or 0),
                            "format": data.get("format", "png"),
                            "width": int(data.get("width", 0) or 0),
                            "height": int(data.get("height", 0) or 0),
                            "document_name": data.get("document_name", ""),
                            "timestamp": data.get("timestamp", time.time()),
                            "chunks": int(data.get("chunks", 1) or 1),
                            "received": 0,
                            "metadata": data.get("metadata", {}) or {},
                        }
                        ps_connection.file_buffer = bytearray(ps_connection.current_file["size"])
                        await send_response(ws, request_id, "binary_start_ack", status="receiving")
                        continue

                    if msg_type == "binary_end":
                        if not ps_connection.current_file:
                            if ps_bridge:
                                ps_bridge.receive_status = {
                                    "phase": "error",
                                    "is_receiving": False,
                                    "progress": 0,
                                    "received_at": 0,
                                    "error_message": "没有正在接收的文件",
                                }
                            await broadcast_manager.broadcast(
                                "tunan_receive_state",
                                {
                                    "phase": "error",
                                    "is_receiving": False,
                                    "progress": 0,
                                    "received_at": 0,
                                    "error_message": "没有正在接收的文件",
                                },
                            )
                            await send_response(ws, request_id, "error", message="没有正在接收的文件")
                            continue

                        try:
                            metadata = ps_connection.current_file.get("metadata", {}) or {}
                            if metadata.get("raw_image"):
                                mode_map = {
                                    1: "L",
                                    2: "LA",
                                    3: "RGB",
                                    4: "RGBA",
                                }
                                components = int(metadata.get("raw_components", 4) or 4)
                                raw_width = int(metadata.get("raw_source_width", ps_connection.current_file["width"]) or 0)
                                raw_height = int(metadata.get("raw_source_height", ps_connection.current_file["height"]) or 0)
                                raw_mode = mode_map.get(components)
                                if not raw_mode or raw_width <= 0 or raw_height <= 0:
                                    raise ValueError("原始像素参数无效")

                                pil_image = Image.frombytes(
                                    raw_mode,
                                    (raw_width, raw_height),
                                    bytes(ps_connection.file_buffer),
                                )

                                canvas_width = int(metadata.get("raw_canvas_width", raw_width) or raw_width)
                                canvas_height = int(metadata.get("raw_canvas_height", raw_height) or raw_height)
                                offset_x = int(metadata.get("raw_offset_x", 0) or 0)
                                offset_y = int(metadata.get("raw_offset_y", 0) or 0)
                                target_width = int(metadata.get("raw_target_width", canvas_width) or canvas_width)
                                target_height = int(metadata.get("raw_target_height", canvas_height) or canvas_height)
                                output_format = metadata.get("raw_output_format", "png")

                                if canvas_width != raw_width or canvas_height != raw_height or offset_x != 0 or offset_y != 0:
                                    canvas_mode = "RGBA" if "A" in pil_image.getbands() else "RGB"
                                    background = (0, 0, 0, 0) if canvas_mode == "RGBA" else (0, 0, 0)
                                    composed = Image.new(canvas_mode, (canvas_width, canvas_height), background)
                                    paste_source = pil_image if pil_image.mode == canvas_mode else pil_image.convert(canvas_mode)
                                    if canvas_mode == "RGBA":
                                        composed.paste(paste_source, (offset_x, offset_y), paste_source)
                                    else:
                                        composed.paste(paste_source, (offset_x, offset_y))
                                    pil_image = composed

                                if target_width > 0 and target_height > 0 and (
                                    pil_image.width != target_width or pil_image.height != target_height
                                ):
                                    pil_image = pil_image.resize((target_width, target_height), Image.Resampling.LANCZOS)

                                ps_connection.current_file["format"] = output_format
                                ps_connection.current_file["width"] = pil_image.width
                                ps_connection.current_file["height"] = pil_image.height
                            else:
                                pil_image = Image.open(io.BytesIO(ps_connection.file_buffer))

                            metadata = {
                                "format": ps_connection.current_file["format"],
                                "width": ps_connection.current_file["width"],
                                "height": ps_connection.current_file["height"],
                                "document_name": ps_connection.current_file["document_name"],
                                "timestamp": ps_connection.current_file["timestamp"],
                            }
                            metadata.update(ps_connection.current_file.get("metadata", {}))

                            if ps_bridge and ps_bridge.process_image_data(pil_image, metadata):
                                await broadcast_manager.broadcast(
                                    "tunan_receive_state",
                                    ps_bridge.receive_status,
                                )
                                await send_response(
                                    ws,
                                    request_id,
                                    "binary_end_ack",
                                    status="success",
                                    message="图像已处理",
                                )
                            else:
                                if ps_bridge:
                                    ps_bridge.receive_status = {
                                        "phase": "error",
                                        "is_receiving": False,
                                        "progress": 0,
                                        "received_at": 0,
                                        "error_message": "图像处理失败",
                                    }
                                await broadcast_manager.broadcast(
                                    "tunan_receive_state",
                                    {
                                        "phase": "error",
                                        "is_receiving": False,
                                        "progress": 0,
                                        "received_at": 0,
                                        "error_message": "图像处理失败",
                                    },
                                )
                                await send_response(ws, request_id, "error", message="图像处理失败")
                        except Exception as exc:
                            if ps_bridge:
                                ps_bridge.receive_status = {
                                    "phase": "error",
                                    "is_receiving": False,
                                    "progress": 0,
                                    "received_at": 0,
                                    "error_message": f"处理图片失败: {exc}",
                                }
                            await broadcast_manager.broadcast(
                                "tunan_receive_state",
                                {
                                    "phase": "error",
                                    "is_receiving": False,
                                    "progress": 0,
                                    "received_at": 0,
                                    "error_message": f"处理图片失败: {exc}",
                                },
                            )
                            await send_response(ws, request_id, "error", message=f"处理图片失败: {exc}")
                        finally:
                            ps_connection.reset_file_transfer()
                        continue

                    if msg_type == "control_workflow":
                        action = data.get("action")
                        if action == "execute":
                            requested_workflow_id = data.get("workflow_id") or ""
                            workflow_id = "current_active"
                            client_id = data.get("client_id") or str(uuid.uuid4())
                            try:
                                write_ws_log(
                                    "workflow:execute",
                                    request_id=request_id,
                                    client_id=client_id,
                                    workflow_id=workflow_id,
                                    requested_workflow_id=requested_workflow_id,
                                )
                                if ps_bridge:
                                    ps_bridge.execution_status["is_executing"] = True
                                    ps_bridge.execution_status["prompt_id"] = None
                                    ps_bridge.execution_status["progress"] = 0
                                    ps_bridge.execution_status["error"] = False
                                await broadcast_manager.broadcast(
                                    "ps_execute_workflow",
                                    {
                                        "workflow_id": workflow_id,
                                        "requested_workflow_id": requested_workflow_id,
                                        "client_id": client_id,
                                    },
                                )
                                await send_response(
                                    ws,
                                    request_id,
                                    "workflow_executing",
                                    prompt_id=None,
                                    status="started",
                                )
                            except Exception as exc:
                                write_ws_log(
                                    "workflow:execute_failed",
                                    request_id=request_id,
                                    client_id=client_id,
                                    workflow_id=workflow_id,
                                    requested_workflow_id=requested_workflow_id,
                                    error=str(exc),
                                )
                                await send_response(ws, request_id, "error", message=f"执行工作流失败: {exc}")
                        elif action == "stop":
                            try:
                                write_ws_log(
                                    "workflow:stop",
                                    request_id=request_id,
                                    client_id=data.get("client_id"),
                                    prompt_id=ps_bridge.execution_status.get("prompt_id") if ps_bridge else None,
                                )
                                nodes.interrupt_processing()
                                if ps_bridge:
                                    ps_bridge.execution_status["is_executing"] = False
                                    ps_bridge.execution_status["progress"] = 0
                                    ps_bridge.execution_status["error"] = False
                                await send_response(ws, request_id, "workflow_stopped", status="stopped")
                            except Exception as exc:
                                write_ws_log(
                                    "workflow:stop_failed",
                                    request_id=request_id,
                                    client_id=data.get("client_id"),
                                    error=str(exc),
                                )
                                await send_response(ws, request_id, "error", message=f"停止工作流失败: {exc}")
                        else:
                            await send_response(ws, request_id, "error", message="不支持的工作流控制动作")
                        continue

                    if msg_type == "params_realtime_update":
                        if ps_bridge:
                            ps_bridge.update_parameters(data.get("params", {}))
                        await ps_connection.broadcast(
                            {
                                "type": "ps_params_update",
                                "params": data.get("params", {}),
                            }
                        )
                        await send_response(ws, request_id, "parameters_ack", status="success")
                        continue

                    if msg_type == "realtime_mode":
                        await ps_connection.broadcast(
                            {
                                "type": "ps_realtime_mode",
                                "enabled": bool(data.get("enabled", False)),
                            }
                        )
                        await send_response(
                            ws,
                            request_id,
                            "realtime_mode_set",
                            enabled=bool(data.get("enabled", False)),
                        )
                        continue

                    if msg_type == "request_status":
                        await send_response(
                            ws,
                            request_id,
                            "status",
                            connected=True,
                            connection_info=ps_connection.get_connection_status(),
                            has_image=bool(ps_bridge and ps_bridge.last_image_data is not None),
                            parameters=ps_bridge.parameters if ps_bridge else {},
                            documents=ps_connection.available_documents,
                            plugin_folder=resource_manager.plugin_dir,
                        )
                        continue

                    if msg_type == "ping":
                        await send_response(ws, request_id, "pong")
                        continue

                    await send_response(ws, request_id, "error", message=f"未知消息类型: {msg_type}")

                elif msg.type == aiohttp.WSMsgType.BINARY:
                    if ps_connection.current_file:
                        start = ps_connection.current_file["received"]
                        end = start + len(msg.data)
                        if end > len(ps_connection.file_buffer):
                            ps_connection.file_buffer.extend(bytearray(end - len(ps_connection.file_buffer)))

                        ps_connection.file_buffer[start:end] = msg.data
                        ps_connection.current_file["received"] = end
                        progress = min(
                            100,
                            int(
                                (ps_connection.current_file["received"] / max(ps_connection.current_file["size"], 1))
                                * 100
                            ),
                        )
                        ps_bridge = get_ps_bridge()
                        if ps_bridge:
                            ps_bridge.receive_status = {
                                "phase": "receiving",
                                "is_receiving": True,
                                "progress": progress,
                                "received_at": 0,
                                "error_message": "",
                            }
                        await broadcast_manager.broadcast(
                            "tunan_receive_state",
                            {
                                "phase": "receiving",
                                "is_receiving": True,
                                "progress": progress,
                                "received_at": 0,
                                "error_message": "",
                            },
                        )
                        await send_json(ws, {"type": "progress", "progress": progress})

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    close_reason = f"ws_error:{ws.exception()}"
                    break

        finally:
            write_ws_log(
                "close",
                client=client_ip,
                close_code=getattr(ws, "close_code", None),
                exception=str(ws.exception()) if ws.exception() else "",
                reason=close_reason,
            )
            await ps_connection.remove_client(ws)
            ps_connection.reset_file_transfer()

        return ws

    return {
        "websocket_handler": websocket_handler,
    }



