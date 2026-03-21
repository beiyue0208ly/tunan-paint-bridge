"""Workflow execution runtime for TuNan Paint Bridge."""

from __future__ import annotations

import asyncio
import copy
import json
import uuid

import aiohttp
from aiohttp import web
from comfy_execution.progress import get_progress_state


class ExecutionBackend:
    def __init__(self, prompt_server, ps_bridge_getter, ps_connection_getter, get_workflows_handler):
        self.prompt_server = prompt_server
        self.ps_bridge_getter = ps_bridge_getter
        self.ps_connection_getter = ps_connection_getter
        self.get_workflows_handler = get_workflows_handler
        self.monitor_tasks = {}

    def _get_ps_bridge(self):
        return self.ps_bridge_getter() if self.ps_bridge_getter else None

    def _get_ps_connection(self):
        return self.ps_connection_getter() if self.ps_connection_getter else None

    def _log_progress(self, stage, payload=None):
        try:
            print(f"[ExecutionProgress] {stage}", payload if payload is not None else "")
        except Exception:
            pass

    def _cleanup_monitor_task(self, prompt_id, task=None):
        current = self.monitor_tasks.get(prompt_id)
        if current is None:
            return
        if task is None or task is current:
            self.monitor_tasks.pop(prompt_id, None)

    def _extract_registry_progress(self, prompt_id):
        registry = get_progress_state()
        if not registry or str(getattr(registry, "prompt_id", "") or "") != str(prompt_id or ""):
            return None

        nodes = getattr(registry, "nodes", {}) or {}
        candidates = []
        for node_id, state in nodes.items():
            if not isinstance(state, dict):
                continue

            try:
                value = float(state.get("value", 0) or 0)
                max_value = float(state.get("max", 0) or 0)
            except (TypeError, ValueError):
                continue

            if max_value <= 0:
                continue

            raw_state = state.get("state")
            candidates.append(
                {
                    "node_id": node_id,
                    "value": max(0.0, min(max_value, value)),
                    "max": max_value,
                    "state": str(getattr(raw_state, "value", raw_state) or ""),
                }
            )

        if not candidates:
            return None

        candidates.sort(
            key=lambda item: (
                1 if item["state"] == "running" else 0,
                item["max"],
                item["value"],
            ),
            reverse=True,
        )
        return candidates[0]

    def _map_registry_progress_percent(self, candidate):
        if not candidate:
            return None

        max_value = float(candidate.get("max", 0) or 0)
        if max_value <= 0:
            return None

        ratio = float(candidate.get("value", 0) or 0) / max_value
        ratio = max(0.0, min(1.0, ratio))
        return max(4.0, min(96.0, round(4.0 + ratio * 92.0, 2)))

    async def _broadcast_execution_progress(self, prompt_id, progress, node_id=None):
        ps_bridge = self._get_ps_bridge()
        ps_connection = self._get_ps_connection()

        if ps_bridge:
            ps_bridge.execution_status["is_executing"] = progress < 100
            ps_bridge.execution_status["prompt_id"] = prompt_id
            ps_bridge.execution_status["progress"] = progress
            ps_bridge.execution_status["error"] = False

        if ps_connection:
            await ps_connection.broadcast(
                {
                    "type": "execution_progress",
                    "prompt_id": prompt_id,
                    "progress": progress,
                    "node_id": node_id,
                }
            )

    async def start_execution_tracking(self, prompt_id, workflow_id="current_active"):
        if not prompt_id:
            raise ValueError("missing prompt_id")

        existing = self.monitor_tasks.get(prompt_id)
        if existing and not existing.done():
            return

        ps_bridge = self._get_ps_bridge()
        ps_connection = self._get_ps_connection()

        if ps_bridge:
            ps_bridge.execution_status["is_executing"] = True
            ps_bridge.execution_status["prompt_id"] = prompt_id
            ps_bridge.execution_status["progress"] = 0
            ps_bridge.execution_status["error"] = False

        if ps_connection:
            await ps_connection.broadcast(
                {
                    "type": "execution_started",
                    "prompt_id": prompt_id,
                    "workflow_id": workflow_id,
                }
            )

        self._log_progress("track:start", {"prompt_id": prompt_id, "workflow_id": workflow_id})
        task = asyncio.create_task(self.monitor_execution(prompt_id, workflow_id))
        self.monitor_tasks[prompt_id] = task
        task.add_done_callback(lambda finished_task, pid=prompt_id: self._cleanup_monitor_task(pid, finished_task))

    async def execute_workflow(self, workflow_data, client_id=None):
        try:
            if not isinstance(workflow_data, dict):
                raise ValueError(f"工作流数据必须是字典类型，当前为: {type(workflow_data)}")

            cleaned_workflow = {}
            for node_id, node_data in workflow_data.items():
                if not isinstance(node_data, dict):
                    continue
                if "class_type" not in node_data:
                    continue
                if "inputs" not in node_data:
                    node_data["inputs"] = {}
                cleaned_workflow[str(node_id)] = node_data

            prompt_id = str(uuid.uuid4())
            if not client_id:
                client_id = str(uuid.uuid4())

            prompt_request = {
                "prompt": cleaned_workflow,
                "client_id": client_id,
            }

            async with aiohttp.ClientSession() as session:
                async with session.post("http://127.0.0.1:8188/prompt", json=prompt_request) as response:
                    if response.status == 200:
                        result = await response.json()
                        return {
                            "success": True,
                            "prompt_id": result.get("prompt_id", prompt_id),
                            "message": "工作流已提交执行",
                        }

                    error_text = await response.text()
                    return {
                        "success": False,
                        "error": f"执行失败: {response.status} - {error_text}",
                    }
        except Exception as exc:
            return {
                "success": False,
                "error": str(exc),
            }

    def inject_ps_parameters(self, workflow_data):
        ps_bridge = self._get_ps_bridge()
        if ps_bridge is None:
            return workflow_data

        try:
            workflow = copy.deepcopy(workflow_data)

            for _, node in workflow.items():
                if node.get("class_type") == "CLIPTextEncode" and "inputs" in node:
                    current_text = node["inputs"].get("text", "")
                    if isinstance(current_text, list):
                        continue

                    current_text_str = str(current_text) if current_text is not None else ""
                    if (
                        "negative" in current_text_str.lower()
                        or "neg" in current_text_str.lower()
                        or "负面" in current_text_str
                    ):
                        node["inputs"]["text"] = ps_bridge.parameters.get("negative_prompt", "")
                    else:
                        node["inputs"]["text"] = ps_bridge.parameters.get("positive_prompt", "")

                elif node.get("class_type") == "KSampler" and "inputs" in node:
                    inputs = node["inputs"]
                    if not isinstance(inputs.get("seed"), list):
                        inputs["seed"] = ps_bridge.parameters.get("seed", -1)
                    if not isinstance(inputs.get("steps"), list):
                        inputs["steps"] = ps_bridge.parameters.get("steps", 20)
                    if not isinstance(inputs.get("cfg"), list):
                        inputs["cfg"] = ps_bridge.parameters.get("cfg_scale", 7.0)
                    if not isinstance(inputs.get("denoise"), list):
                        inputs["denoise"] = ps_bridge.parameters.get("denoise", 1.0)

            return workflow
        except Exception:
            return workflow_data

    async def execute_workflow_api(self, request):
        try:
            data = await request.json()
            workflow_id = data.get("workflow_id")
            workflow_data = data.get("workflow")
            client_id = data.get("client_id", str(uuid.uuid4()))
            ps_bridge = self._get_ps_bridge()
            ps_connection = self._get_ps_connection()

            if workflow_id == "current_active":
                if ps_bridge is None or ps_bridge.last_image_data is None:
                    return web.json_response(
                        {"status": "error", "message": "请先从 PS 发送图像"},
                        status=400,
                    )

                current_workflow = None
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get("http://127.0.0.1:8188/graph") as response:
                            if response.status == 200:
                                graph_data = await response.json()
                                if graph_data and isinstance(graph_data, dict):
                                    current_workflow = graph_data
                except Exception:
                    pass

                if not current_workflow:
                    try:
                        async with aiohttp.ClientSession() as session:
                            async with session.get("http://127.0.0.1:8188/history?max_items=1") as response:
                                if response.status == 200:
                                    history = await response.json()
                                    if history:
                                        for _, item in history.items():
                                            if "prompt" not in item:
                                                continue
                                            prompt_data = item["prompt"]
                                            if isinstance(prompt_data, list) and len(prompt_data) > 1:
                                                current_workflow = prompt_data[1]
                                            elif isinstance(prompt_data, dict):
                                                current_workflow = prompt_data
                                            if current_workflow:
                                                break
                    except Exception:
                        pass

                if not current_workflow:
                    current_workflow = {
                        "1": {"class_type": "TuNanPSBridge", "inputs": {}},
                        "2": {"class_type": "PreviewImage", "inputs": {"images": ["1", 0]}},
                    }

                if not isinstance(current_workflow, dict):
                    return web.json_response(
                        {"status": "error", "message": "工作流数据格式错误，请检查 ComfyUI"},
                        status=400,
                    )

                workflow_to_execute = copy.deepcopy(current_workflow)
                has_ps_bridge = any(
                    isinstance(node, dict) and node.get("class_type") == "TuNanPSBridge"
                    for node in workflow_to_execute.values()
                )
                if not has_ps_bridge:
                    return web.json_response(
                        {"status": "error", "message": "当前工作流中没有图南 PS 桥接器节点，请添加后再试"},
                        status=400,
                    )

                prompt_request = {
                    "prompt": workflow_to_execute,
                    "client_id": client_id,
                }
                async with aiohttp.ClientSession() as session:
                    async with session.post("http://127.0.0.1:8188/prompt", json=prompt_request) as response:
                        if response.status == 200:
                            result = await response.json()
                            prompt_id = result.get("prompt_id")
                            await self.start_execution_tracking(prompt_id, "current_active")

                            return web.json_response(
                                {
                                    "status": "success",
                                    "prompt_id": prompt_id,
                                    "message": "工作流已提交执行",
                                }
                            )

                        error_text = await response.text()
                        return web.json_response(
                            {"status": "error", "message": f"执行失败: {error_text}"},
                            status=500,
                        )

            if workflow_id and not workflow_data and self.get_workflows_handler:
                workflows_response = await self.get_workflows_handler(request)
                workflows_data = json.loads(workflows_response.body)
                for workflow in workflows_data.get("workflows", []):
                    if workflow["id"] == workflow_id:
                        workflow_data = workflow["workflow"]
                        break

            if not workflow_data:
                return web.json_response(
                    {"status": "error", "message": "未找到工作流数据"},
                    status=400,
                )

            result = await self.execute_workflow(workflow_data, client_id)
            if result["success"]:
                await self.start_execution_tracking(result["prompt_id"], workflow_id or "current_active")
                return web.json_response(
                    {
                        "status": "success",
                        "prompt_id": result["prompt_id"],
                        "message": result["message"],
                    }
                )

            return web.json_response(
                {"status": "error", "message": result["error"]},
                status=500,
            )
        except Exception as exc:
            return web.json_response(
                {"status": "error", "message": str(exc)},
                status=500,
            )

    async def get_execution_status(self, request):
        prompt_id = request.match_info["prompt_id"]
        try:
            queue_running, queue_pending = self.prompt_server.instance.prompt_queue.get_current_queue()

            for running in queue_running:
                if running[1] == prompt_id:
                    candidate = self._extract_registry_progress(prompt_id)
                    progress = self._map_registry_progress_percent(candidate)
                    return web.json_response(
                        {
                            "status": "running",
                            "progress": progress if progress is not None else 0,
                        }
                    )

            for pending in queue_pending:
                if pending[1] == prompt_id:
                    return web.json_response(
                        {
                            "status": "pending",
                            "position": queue_pending.index(pending),
                        }
                    )

            history = self.prompt_server.instance.prompt_queue.get_history(prompt_id=prompt_id)
            if prompt_id in history:
                return web.json_response(
                    {
                        "status": "completed",
                        "outputs": history[prompt_id].get("outputs", {}),
                    }
                )

            return web.json_response({"status": "not_found"})
        except Exception as exc:
            return web.json_response(
                {"status": "error", "message": str(exc)},
                status=500,
            )

    async def monitor_execution(self, prompt_id, workflow_id="current_active"):
        try:
            max_attempts = 600
            attempt = 0
            last_progress = -1.0
            while attempt < max_attempts:
                await asyncio.sleep(0.25)
                attempt += 1
                queue_running, queue_pending = self.prompt_server.instance.prompt_queue.get_current_queue()
                history = self.prompt_server.instance.prompt_queue.get_history(prompt_id=prompt_id)

                if prompt_id in history:
                    ps_bridge = self._get_ps_bridge()
                    ps_connection = self._get_ps_connection()
                    if ps_bridge:
                        ps_bridge.execution_status["is_executing"] = False
                        ps_bridge.execution_status["prompt_id"] = prompt_id
                        ps_bridge.execution_status["progress"] = 100
                        ps_bridge.execution_status["error"] = False
                    if ps_connection:
                        await ps_connection.broadcast(
                            {
                                "type": "execution_complete",
                                "prompt_id": prompt_id,
                                "workflow_id": workflow_id,
                            }
                        )
                    self._log_progress("track:complete", {"prompt_id": prompt_id, "workflow_id": workflow_id})
                    break

                is_running = False
                for running in queue_running:
                    if running[1] == prompt_id:
                        is_running = True
                        candidate = self._extract_registry_progress(prompt_id)
                        progress = self._map_registry_progress_percent(candidate)
                        if progress is not None and progress > last_progress:
                            last_progress = progress
                            self._log_progress(
                                "track:progress",
                                {
                                    "prompt_id": prompt_id,
                                    "workflow_id": workflow_id,
                                    "node_id": candidate.get("node_id") if candidate else None,
                                    "progress": progress,
                                },
                            )
                            await self._broadcast_execution_progress(
                                prompt_id,
                                progress,
                                node_id=candidate.get("node_id") if candidate else None,
                            )
                        break

                if not is_running:
                    in_pending = any(pending[1] == prompt_id for pending in queue_pending)
                    if not in_pending and prompt_id not in history:
                        ps_bridge = self._get_ps_bridge()
                        ps_connection = self._get_ps_connection()
                        if ps_bridge:
                            ps_bridge.execution_status["is_executing"] = False
                            ps_bridge.execution_status["progress"] = 0
                            ps_bridge.execution_status["error"] = True
                        if ps_connection:
                            await ps_connection.broadcast(
                                {
                                    "type": "execution_error",
                                    "prompt_id": prompt_id,
                                    "error": "执行失败或被取消",
                                }
                            )
                        self._log_progress(
                            "track:error",
                            {"prompt_id": prompt_id, "workflow_id": workflow_id, "reason": "missing_from_queue"},
                        )
                        break
        except Exception as exc:
            self._log_progress(
                "track:exception",
                {"prompt_id": prompt_id, "workflow_id": workflow_id, "error": str(exc)},
            )
            ps_connection = self._get_ps_connection()
            if ps_connection:
                try:
                    await ps_connection.broadcast(
                        {
                            "type": "execution_error",
                            "prompt_id": prompt_id,
                            "error": str(exc),
                        }
                    )
                except Exception:
                    pass
        finally:
            self._cleanup_monitor_task(prompt_id)


def register_execution_routes(prompt_server, execution_backend):
    routes = prompt_server.instance.routes

    @routes.post("/tunan/ps/execute_workflow")
    async def execute_workflow_api(request):
        return await execution_backend.execute_workflow_api(request)

    @routes.post("/tunan/ps/execution_started")
    async def execution_started(request):
        try:
            data = await request.json()
            await execution_backend.start_execution_tracking(
                data.get("prompt_id"),
                data.get("workflow_id", "current_active"),
            )
            return web.json_response({"status": "success"})
        except Exception as exc:
            return web.json_response({"status": "error", "message": str(exc)}, status=500)

    @routes.get("/tunan/ps/execution_status/{prompt_id}")
    async def get_execution_status(request):
        return await execution_backend.get_execution_status(request)

    return {
        "execute_workflow_api": execute_workflow_api,
        "execution_started": execution_started,
        "get_execution_status": get_execution_status,
    }



