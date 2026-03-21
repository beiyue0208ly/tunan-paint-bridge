"""Workflow and tab control services for TuNan Paint Bridge."""

from __future__ import annotations

import asyncio
import copy
import logging
import time
import uuid

from aiohttp import web

from . import workflow_backend

LOGGER = logging.getLogger("tunan.paint.bridge.workflow")


_last_execution_time = 0.0


def get_last_execution_time():
    return _last_execution_time


class WorkflowRouteService:
    """Shared workflow logic used by both HTTP routes and WebSocket handlers."""

    def __init__(self, prompt_server, broadcast_manager, ps_connection):
        self.prompt_server = prompt_server
        self.broadcast_manager = broadcast_manager
        self.ps_connection = ps_connection

    def refresh_workflow_cache(self, force_check=False):
        with workflow_backend.workflow_cache_lock:
            if workflow_backend.should_refresh_workflow_cache(force_check):
                workflows, workflow_dirs = workflow_backend._scan_saved_workflows()
                workflow_backend.workflow_cache["workflows"] = workflows
                workflow_backend.workflow_cache["last_update"] = time.time()
                workflow_backend.update_workflow_cache_metadata(workflows, workflow_dirs)

            return copy.deepcopy(workflow_backend.workflow_cache["workflows"])

    def list_workflows(self, force_check=False):
        workflows = self.refresh_workflow_cache(force_check)
        return {
            "status": "success",
            "workflows": workflow_backend._serialize_workflow_list_items(workflows),
            "count": len(workflows),
            "timestamp": time.time(),
        }

    def get_tabs_state(self):
        state = workflow_backend._refresh_global_tabs_state()
        state["timestamp"] = time.time()
        return state

    async def request_tabs_state(self):
        state = self.get_tabs_state()
        LOGGER.warning(
            "[WorkflowRoute] request_tabs_state:start current_tab=%s tabs=%s session=%s",
            state.get("current_tab"),
            len(state.get("tabs", [])),
            state.get("session_id"),
        )
        if state.get("tabs"):
            return state

        request_payload = {
            "requesting_client": "photoshop",
            "timestamp": time.time(),
        }

        for event_name in ("tunan_request_current_workflow", "tunan_request_tabs"):
            try:
                LOGGER.warning("[WorkflowRoute] request_tabs_state:prompt_frontend event=%s", event_name)
                await self.prompt_server.instance.send(event_name, request_payload)
            except Exception:
                LOGGER.exception("[WorkflowRoute] request_tabs_state:prompt_frontend_failed event=%s", event_name)
                pass

        for delay in (0.12, 0.32, 0.7):
            await asyncio.sleep(delay)
            state = self.get_tabs_state()
            LOGGER.warning(
                "[WorkflowRoute] request_tabs_state:retry delay=%.2f current_tab=%s tabs=%s session=%s",
                delay,
                state.get("current_tab"),
                len(state.get("tabs", [])),
                state.get("session_id"),
            )
            if state.get("tabs"):
                return state

        return state

    async def set_control_target(self, session_id="", mode="auto"):
        if session_id and session_id != "auto":
            if workflow_backend.frontend_tab_sessions.get(session_id) is None:
                LOGGER.warning(
                    "[WorkflowRoute] set_control_target:stale_session session=%s fallback=auto",
                    session_id,
                )
                workflow_backend._clear_frontend_control_preference()
            else:
                workflow_backend.frontend_control_preference["mode"] = "manual"
                workflow_backend.frontend_control_preference["session_id"] = session_id
        else:
            if mode not in {"auto", "desktop", "browser"}:
                raise ValueError("无效的控制模式")
            workflow_backend.frontend_control_preference["mode"] = mode
            workflow_backend.frontend_control_preference["session_id"] = None

        state = self.get_tabs_state()
        await self.ps_connection.broadcast(
            {
                "type": "tabs_updated",
                "action": "control_mode_changed",
                "current_tab": state.get("current_tab"),
                "tabs": state.get("tabs", []),
                "frontend_session_id": state.get("session_id"),
                "frontend_kind": state.get("session_kind"),
                "control_mode": state.get("control_mode"),
                "selected_session_id": state.get("selected_session_id"),
                "available_frontends": state.get("available_frontends"),
                "frontend_sessions": state.get("frontend_sessions", []),
                "has_control_target": state.get("has_control_target"),
                "timestamp": state["timestamp"],
            }
        )
        return state

    async def switch_tab(self, tab_id):
        if not tab_id:
            raise ValueError("缺少 tab_id 参数")

        authoritative_state = workflow_backend._refresh_global_tabs_state()
        target_session_id = authoritative_state.get("session_id")
        if not target_session_id:
            raise RuntimeError("当前没有可用的目标控制端")

        payload = {
            "tab_id": tab_id,
            "source": "tunan_switch",
            "target_session_id": target_session_id,
        }
        await self.broadcast_manager.broadcast("switch_tab", payload)

        session = workflow_backend.frontend_tab_sessions.get(target_session_id)
        if session:
            session["current_tab"] = tab_id
            session["last_seen"] = time.time()

        refreshed_state = self.get_tabs_state()
        await self.ps_connection.broadcast(
            {
                "type": "tab_switched",
                "tab_id": tab_id,
                "tab_info": workflow_backend.opened_tabs.get(tab_id, {}),
                "frontend_session_id": refreshed_state.get("session_id"),
                "frontend_kind": refreshed_state.get("session_kind"),
                "control_mode": refreshed_state.get("control_mode"),
                "selected_session_id": refreshed_state.get("selected_session_id"),
                "available_frontends": refreshed_state.get("available_frontends"),
                "frontend_sessions": refreshed_state.get("frontend_sessions", []),
            }
        )
        return refreshed_state

    async def load_workflow(self, workflow_id):
        if not workflow_id:
            raise ValueError("缺少 workflow_id")

        workflows = self.refresh_workflow_cache()
        target_workflow = next((item for item in workflows if item.get("id") == workflow_id), None)
        if not target_workflow:
            raise FileNotFoundError(f"未找到工作流: {workflow_id}")

        workflow_backend.workflow_state["ps_selected"] = workflow_id
        workflow_backend.workflow_state["ps_selected_name"] = target_workflow.get("name")

        authoritative_state = workflow_backend._refresh_global_tabs_state()
        target_session_id = authoritative_state.get("session_id")
        if not target_session_id:
            raise RuntimeError("当前没有可用的目标控制端")

        target_filename = str(target_workflow.get("filename") or f"{target_workflow.get('name')}.json")
        target_path = str(target_workflow.get("path") or "")
        existing_tab = next(
            (
                tab
                for tab in authoritative_state.get("tabs", [])
                if (
                    tab.get("workflow_id") == workflow_id
                    or (target_path and str(tab.get("path") or "") == target_path)
                    or (target_filename and str(tab.get("filename") or "") == target_filename)
                )
            ),
            None,
        )

        if existing_tab:
            refreshed_state = await self.switch_tab(existing_tab.get("id"))
            return {
                "status": "success",
                "message": f"工作流已切换: {target_workflow.get('name')}",
                "workflow_id": workflow_id,
                "workflow_name": target_workflow.get("name"),
                "tab_id": existing_tab.get("id"),
                "already_open": True,
                "data": refreshed_state,
            }

        workflow_data = copy.deepcopy(target_workflow.get("workflow", {}))
        if workflow_data:
            workflow_data.setdefault("extra", {})
            workflow_data["extra"]["title"] = target_workflow.get("name")
            workflow_data["extra"]["workflow_name"] = target_workflow.get("name")
            workflow_data["extra"]["workflow_id"] = workflow_id
            workflow_data["extra"]["filename"] = target_filename
            workflow_data.setdefault("version", "0.4")

        payload = {
            "workflow": workflow_data,
            "source": "tunan_saved_workflow",
            "workflow_name": target_workflow.get("name"),
            "workflow_id": workflow_id,
            "filename": target_filename,
            "path": target_path,
            "target_session_id": target_session_id,
        }
        await self.prompt_server.instance.send("tunan_load_workflow", payload)

        return {
            "status": "success",
            "message": f"工作流已打开: {target_workflow.get('name')}",
            "workflow_id": workflow_id,
            "workflow_name": target_workflow.get("name"),
            "already_open": False,
        }

    async def handle_tab_update_payload(self, data):
        action = data.get("action")
        frontend_session_id = data.get("frontend_session_id") or data.get("session_id") or "default_session"
        frontend_kind = data.get("frontend_kind")
        session = workflow_backend._get_frontend_session(frontend_session_id, frontend_kind)

        if action == "opened":
            tab_info = data.get("tab_info", {})
            tab_id = tab_info.get("id")
            if tab_id:
                session["tabs"][tab_id] = tab_info
        elif action == "closed":
            tab_id = data.get("tab_id")
            if tab_id in session["tabs"]:
                del session["tabs"][tab_id]
        elif action == "switched":
            session["current_tab"] = data.get("tab_id")
        elif action == "renamed":
            tab_id = data.get("tab_id")
            new_name = data.get("new_name")
            if tab_id in session["tabs"]:
                session["tabs"][tab_id]["name"] = new_name
        elif action == "sync_all":
            session["tabs"] = {tab["id"]: tab for tab in data.get("tabs", []) if tab.get("id")}
            session["current_tab"] = data.get("current_tab")

        session["last_seen"] = time.time()
        authoritative_state = self.get_tabs_state()

        await self.ps_connection.broadcast(
            {
                "type": "tabs_updated",
                "action": action,
                "current_tab": authoritative_state.get("current_tab"),
                "tabs": authoritative_state.get("tabs", []),
                "frontend_session_id": authoritative_state.get("session_id"),
                "frontend_kind": authoritative_state.get("session_kind"),
                "control_mode": authoritative_state.get("control_mode"),
                "selected_session_id": authoritative_state.get("selected_session_id"),
                "available_frontends": authoritative_state.get("available_frontends"),
                "frontend_sessions": authoritative_state.get("frontend_sessions", []),
                "timestamp": authoritative_state["timestamp"],
            }
        )
        return authoritative_state

    async def handle_workflow_changed_payload(self, data):
        to_name = data.get("to_name")
        notification = {
            "type": "workflow_sync",
            "action": "switch_selection",
            "from": data.get("from"),
            "from_name": data.get("from_name"),
            "to": data.get("to"),
            "to_name": to_name,
            "source": data.get("source", "comfyui"),
            "reason": data.get("action", "switched"),
            "timestamp": time.time(),
            "current_workflow": {
                "id": data.get("to") if to_name and to_name != "Unsaved Workflow" else "current_unsaved",
                "name": to_name if to_name and to_name != "Unsaved Workflow" else "当前工作流",
                "is_saved": bool(to_name and to_name != "Unsaved Workflow"),
            },
        }

        await self.ps_connection.broadcast(notification)
        await self.prompt_server.instance.send("tunan_workflow_sync", notification)
        return notification

    def get_current_workflow_info(self):
        return {
            "id": workflow_backend.workflow_state.get("current_active", "unknown"),
            "name": workflow_backend.workflow_state.get("current_active_name", "当前活动工作流"),
        }

    async def get_current_graph_info(self):
        await self.prompt_server.instance.send("request_graph", {"request_id": str(uuid.uuid4())})
        await asyncio.sleep(0.5)
        return {
            "status": "success",
            "message": "请从历史记录中读取当前工作流图数据",
        }

    def update_execution_time_value(self, execution_time):
        global _last_execution_time
        _last_execution_time = float(execution_time or 0)
        return _last_execution_time


def register_workflow_routes(prompt_server, broadcast_manager, ps_connection):
    routes = prompt_server.instance.routes
    service = WorkflowRouteService(prompt_server, broadcast_manager, ps_connection)

    @routes.get("/tunan/ps/workflows")
    async def get_workflows(request):
        try:
            force_check = str(request.rel_url.query.get("force", "")).lower() in {"1", "true", "yes"}
            return web.json_response(service.list_workflows(force_check))
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/load_workflow")
    async def load_workflow_api(request):
        try:
            data = await request.json()
            result = await service.load_workflow(data.get("workflow_id"))
            return web.json_response(result)
        except FileNotFoundError as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=404)
        except ValueError as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)
        except RuntimeError as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/tabs")
    async def get_opened_tabs(request):
        try:
            return web.json_response({"status": "success", "data": await service.request_tabs_state()})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/control_target")
    async def update_control_target(request):
        try:
            data = await request.json()
            state = await service.set_control_target(
                session_id=data.get("session_id", ""),
                mode=data.get("mode", "auto"),
            )
            return web.json_response({"status": "success", "data": state})
        except ValueError as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/switch_tab")
    async def switch_tab(request):
        try:
            data = await request.json()
            state = await service.switch_tab(data.get("tab_id"))
            return web.json_response(
                {
                    "status": "success",
                    "message": f"已切换到标签页: {data.get('tab_id')}",
                    "data": state,
                }
            )
        except ValueError as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=400)
        except RuntimeError as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/tab_update")
    async def handle_tab_update(request):
        try:
            data = await request.json()
            state = await service.handle_tab_update_payload(data)
            return web.json_response({"status": "success", "data": state})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/workflow_changed")
    async def workflow_changed_handler(request):
        try:
            data = await request.json()
            notification = await service.handle_workflow_changed_payload(data)
            return web.json_response({"status": "success", "data": notification})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/current_graph")
    async def get_current_graph(request):
        try:
            return web.json_response(await service.get_current_graph_info())
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.post("/tunan/ps/update_execution_time")
    async def update_execution_time(request):
        try:
            data = await request.json()
            service.update_execution_time_value(data.get("execution_time", 0))
            return web.json_response({"status": "success"})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    return {
        "service": service,
        "get_workflows": get_workflows,
        "load_workflow_api": load_workflow_api,
        "get_opened_tabs": get_opened_tabs,
        "update_control_target": update_control_target,
        "switch_tab": switch_tab,
        "handle_tab_update": handle_tab_update,
        "workflow_changed_handler": workflow_changed_handler,
        "get_current_graph": get_current_graph,
        "update_execution_time": update_execution_time,
        "get_current_workflow_info": service.get_current_workflow_info,
        "get_last_execution_time": get_last_execution_time,
    }




