"""Main backend entry for TuNan Paint Bridge."""

from __future__ import annotations

try:
    from .backend import bridge_routes, node_runtime, sender_backend, workflow_backend, workflow_routes, ws_protocol
    from .backend.broadcast_manager import BroadcastManager
    from .backend.connection_manager import PSConnectionManager
    from .backend.execution_backend import ExecutionBackend, register_execution_routes
    from .backend.resource_manager import TunanResourceManager
    from .console_compat import safe_print
except ImportError:
    from backend import bridge_routes, node_runtime, sender_backend, workflow_backend, workflow_routes, ws_protocol
    from backend.broadcast_manager import BroadcastManager
    from backend.connection_manager import PSConnectionManager
    from backend.execution_backend import ExecutionBackend, register_execution_routes
    from backend.resource_manager import TunanResourceManager
    from console_compat import safe_print

from server import PromptServer

print = safe_print


workflow_cache_lock = workflow_backend.workflow_cache_lock
workflow_state = workflow_backend.workflow_state
opened_tabs = workflow_backend.opened_tabs
frontend_tab_sessions = workflow_backend.frontend_tab_sessions
frontend_control_preference = workflow_backend.frontend_control_preference
workflow_cache = workflow_backend.workflow_cache
check_workflow_directories_changed = workflow_backend.check_workflow_directories_changed
calculate_workflows_hash = workflow_backend.calculate_workflows_hash
update_workflow_cache_metadata = workflow_backend.update_workflow_cache_metadata
should_refresh_workflow_cache = workflow_backend.should_refresh_workflow_cache
_get_frontend_session = workflow_backend._get_frontend_session
_refresh_global_tabs_state = workflow_backend._refresh_global_tabs_state
_get_workflow_directories = workflow_backend._get_workflow_directories
_scan_saved_workflows = workflow_backend._scan_saved_workflows
_serialize_workflow_list_items = workflow_backend._serialize_workflow_list_items


resource_manager = TunanResourceManager()
ps_connection = None
broadcast_manager = BroadcastManager(PromptServer, lambda: ps_connection)
ps_connection = PSConnectionManager(
    PromptServer,
    workflow_backend,
    lambda: broadcast_manager,
)


workflow_route_exports = workflow_routes.register_workflow_routes(
    PromptServer,
    broadcast_manager,
    ps_connection,
)
workflow_service = workflow_route_exports["service"]
get_workflows = workflow_route_exports["get_workflows"]
load_workflow_api = workflow_route_exports["load_workflow_api"]
get_opened_tabs = workflow_route_exports["get_opened_tabs"]
update_control_target = workflow_route_exports["update_control_target"]
switch_tab = workflow_route_exports["switch_tab"]
handle_tab_update = workflow_route_exports["handle_tab_update"]
workflow_changed_handler = workflow_route_exports["workflow_changed_handler"]
get_current_graph = workflow_route_exports["get_current_graph"]
update_execution_time = workflow_route_exports["update_execution_time"]
get_current_workflow_info = workflow_route_exports["get_current_workflow_info"]
get_last_execution_time = workflow_route_exports["get_last_execution_time"]


sender_route_exports = sender_backend.register_sender_routes(
    PromptServer,
    resource_manager,
    lambda: ps_connection,
    lambda: ps_bridge,
    lambda: node_runtime.TunanPSSender,
)
send_image_to_ps = sender_route_exports["send_image_to_ps"]
get_sender_status = sender_route_exports["get_sender_status"]
get_sender_last_status = sender_route_exports["get_sender_last_status"]
get_sender_preview = sender_route_exports["get_sender_preview"]


node_runtime.configure_runtime(
    resource_manager=resource_manager,
    ps_connection=ps_connection,
    sender_helpers=sender_route_exports,
    prompt_server=PromptServer,
    get_last_execution_time=get_last_execution_time,
)

create_default_tunan_workflow = node_runtime.create_default_tunan_workflow
TunanPSBridge = node_runtime.TunanPSBridge
TunanSelectionCropper = node_runtime.TunanSelectionCropper
TunanPSSender = node_runtime.TunanPSSender
ps_bridge = node_runtime.get_or_create_ps_bridge()


class TuNanBackendPSBridgeNode(node_runtime.TunanPSBridge):
    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT", "INT", "STRING", "STRING", "FLOAT", "INT")
    RETURN_NAMES = ("图像", "选区", "降噪强度", "种子", "正面提示词", "负面提示词", "CFG", "步数")
    FUNCTION = "bridge_ps_data"
    OUTPUT_NODE = True
    CATEGORY = "图南画桥"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "current_image_url": ("STRING", {"default": ""}),
                "connection_status": ("STRING", {"default": ""}),
            },
        }

    def bridge_ps_data(self, current_image_url="", connection_status=""):
        result = super().bridge_ps_data("图像和参数", "RGB", current_image_url, connection_status)
        output = result.get("result") if isinstance(result, dict) else None
        if isinstance(output, tuple) and len(output) > 8:
            result["result"] = output[:8]
        return result


class TuNanBackendPSSenderNode(node_runtime.TunanPSSender):
    RETURN_TYPES = ()
    FUNCTION = "process_and_send"
    CATEGORY = "图南画桥"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE",),
                "回贴模式": (["选区还原模式", "整图模式"], {"default": "选区还原模式"}),
                "边缘收缩": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
                "边缘柔化": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
            },
        }

    def process_and_send(self, **kwargs):
        image = kwargs["图像"]
        return_mode = kwargs.get("回贴模式", "选区还原模式")
        edge_shrink = kwargs.get("边缘收缩", 0)
        edge_feather = kwargs.get("边缘柔化", 0)
        return super().process_and_send(
            image,
            "PNG",
            return_mode,
            edge_shrink,
            edge_feather,
            "图南画桥",
            95,
            1,
        )


bridge_route_exports = bridge_routes.register_bridge_routes(
    PromptServer,
    resource_manager,
    lambda: ps_connection,
    lambda: ps_bridge,
    sender_route_exports,
    lambda: broadcast_manager,
)
get_current_image = bridge_route_exports["get_current_image"]
get_waiting_image = bridge_route_exports["get_waiting_image"]
handle_ps_upload = bridge_route_exports["handle_ps_upload"]
receive_ps_parameters_http = bridge_route_exports["receive_ps_parameters_http"]
receive_crop_parameters_http = bridge_route_exports["receive_crop_parameters_http"]
get_status = bridge_route_exports["get_status"]
cleanup_temp_files = bridge_route_exports["cleanup_temp_files"]
cleanup_all_cache = bridge_route_exports["cleanup_all_cache"]
debug_status = bridge_route_exports["debug_status"]
get_port_info = bridge_route_exports["get_port_info"]
ready_check = bridge_route_exports["ready_check"]
handle_execution_complete = bridge_route_exports["handle_execution_complete"]
get_actual_comfyui_port = bridge_route_exports["get_actual_comfyui_port"]


ws_route_exports = ws_protocol.register_ws_routes(
    PromptServer,
    ps_connection,
    lambda: ps_bridge,
    resource_manager,
    workflow_service,
    broadcast_manager,
)
websocket_handler = ws_route_exports["websocket_handler"]


execution_backend = ExecutionBackend(
    PromptServer,
    lambda: ps_bridge,
    lambda: ps_connection,
    get_workflows,
)
execution_route_exports = register_execution_routes(PromptServer, execution_backend)
execute_workflow_api = execution_route_exports["execute_workflow_api"]
execution_started = execution_route_exports["execution_started"]
get_execution_status = execution_route_exports["get_execution_status"]
execute_workflow = execution_backend.execute_workflow
inject_ps_parameters = execution_backend.inject_ps_parameters
monitor_execution = execution_backend.monitor_execution


NODE_CLASS_MAPPINGS = {
    "TunanPSBridge": TuNanBackendPSBridgeNode,
    "TunanPSSender": TuNanBackendPSSenderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TunanPSBridge": "图南PS桥接器",
    "TunanPSSender": "图南PS发送器",
}
