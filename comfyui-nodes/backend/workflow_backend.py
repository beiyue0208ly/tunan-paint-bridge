"""Workflow and frontend-tab runtime state for TuNan Paint Bridge."""

import glob
import json
import os
import threading
import time
from pathlib import Path

import folder_paths


workflow_cache_lock = threading.Lock()

workflow_state = {
    "ps_selected": None,
    "ps_selected_name": None,
    "current_active": None,
    "current_active_name": None,
}

opened_tabs = {}
current_tab_id = None

frontend_tab_sessions = {}
frontend_control_preference = {
    "mode": "auto",
    "session_id": None,
}

workflow_cache = {
    "workflows": [],
    "last_update": 0,
    "cache_duration": 300,
    "directory_mtimes": {},
    "file_count": 0,
    "last_hash": None,
}


def _normalize_frontend_kind(frontend_kind):
    if frontend_kind == "desktop":
        return "desktop"
    if frontend_kind == "browser":
        return "browser"
    return "unknown"


def _get_frontend_session(frontend_session_id=None, frontend_kind=None):
    session_id = frontend_session_id or "default_session"
    session = frontend_tab_sessions.get(session_id)

    if session is None:
        session = {
            "session_id": session_id,
            "kind": _normalize_frontend_kind(frontend_kind),
            "tabs": {},
            "current_tab": None,
            "last_seen": 0,
        }
        frontend_tab_sessions[session_id] = session
    else:
        normalized_kind = _normalize_frontend_kind(frontend_kind)
        if normalized_kind != "unknown":
            session["kind"] = normalized_kind

    session["last_seen"] = time.time()
    return session


def _get_available_frontend_counts():
    counts = {"desktop": 0, "browser": 0, "unknown": 0}

    for session in frontend_tab_sessions.values():
        if not session.get("tabs"):
            continue
        kind = session.get("kind") or "unknown"
        counts[kind] = counts.get(kind, 0) + 1

    return counts


def _clear_frontend_control_preference():
    frontend_control_preference["mode"] = "auto"
    frontend_control_preference["session_id"] = None


def _serialize_frontend_sessions():
    sessions = []
    for session in frontend_tab_sessions.values():
        tabs = list(session.get("tabs", {}).values())
        if not tabs:
            continue

        selected_tab_id = session.get("current_tab")
        current_tab = next((tab for tab in tabs if tab.get("id") == selected_tab_id), None)
        if current_tab is None and tabs:
            current_tab = tabs[0]

        sessions.append(
            {
                "session_id": session.get("session_id"),
                "kind": session.get("kind") or "unknown",
                "tab_count": len(tabs),
                "current_tab_id": selected_tab_id,
                "current_tab_name": current_tab.get("name") if current_tab else None,
                "last_seen": session.get("last_seen", 0),
            }
        )

    kind_rank = {"desktop": 0, "browser": 1, "unknown": 2}
    sessions.sort(key=lambda item: (kind_rank.get(item.get("kind"), 9), -item.get("last_seen", 0)))
    return sessions


def _select_authoritative_frontend_session():
    sessions = [session for session in frontend_tab_sessions.values() if session.get("tabs")]

    if not sessions:
        return None

    preferred_session_id = frontend_control_preference.get("session_id")
    if preferred_session_id:
        preferred_session = frontend_tab_sessions.get(preferred_session_id)
        if preferred_session and preferred_session.get("tabs"):
            return preferred_session

        # A manual target that no longer exists should not deadlock the bridge.
        if preferred_session is None:
            _clear_frontend_control_preference()
        else:
            return None

    desktop_sessions = [session for session in sessions if session.get("kind") == "desktop"]
    browser_sessions = [session for session in sessions if session.get("kind") == "browser"]

    control_mode = frontend_control_preference.get("mode", "auto")
    if control_mode == "desktop":
        preferred_sessions = desktop_sessions
    elif control_mode == "browser":
        preferred_sessions = browser_sessions
    else:
        preferred_sessions = desktop_sessions or sessions

    if not preferred_sessions:
        return None

    return max(preferred_sessions, key=lambda session: session.get("last_seen", 0))


def _refresh_global_tabs_state():
    global current_tab_id

    authoritative_session = _select_authoritative_frontend_session()
    if not authoritative_session:
        opened_tabs.clear()
        current_tab_id = None
        return {
            "session_id": None,
            "session_kind": None,
            "current_tab": None,
            "tabs": [],
            "control_mode": frontend_control_preference.get("mode", "auto"),
            "selected_session_id": frontend_control_preference.get("session_id"),
            "available_frontends": _get_available_frontend_counts(),
            "frontend_sessions": _serialize_frontend_sessions(),
            "has_control_target": False,
        }

    tabs = list(authoritative_session.get("tabs", {}).values())
    opened_tabs.clear()
    opened_tabs.update({tab["id"]: tab for tab in tabs})
    current_tab_id = authoritative_session.get("current_tab")

    return {
        "session_id": authoritative_session.get("session_id"),
        "session_kind": authoritative_session.get("kind"),
        "current_tab": current_tab_id,
        "tabs": tabs,
        "control_mode": frontend_control_preference.get("mode", "auto"),
        "selected_session_id": frontend_control_preference.get("session_id"),
        "available_frontends": _get_available_frontend_counts(),
        "frontend_sessions": _serialize_frontend_sessions(),
        "has_control_target": True,
    }


def check_workflow_directories_changed():
    try:
        workflow_dirs = []

        user_dir = folder_paths.get_user_directory()
        if user_dir:
            user_workflows_dir = os.path.join(user_dir, "workflows")
            if os.path.exists(user_workflows_dir):
                workflow_dirs.append(user_workflows_dir)

        base_dir = os.path.dirname(os.path.dirname(folder_paths.__file__))
        built_in_workflows = os.path.join(base_dir, "user", "default", "workflows")
        if os.path.exists(built_in_workflows):
            workflow_dirs.append(built_in_workflows)

        current_mtimes = {}
        current_file_count = 0

        for dir_path in workflow_dirs:
            if os.path.exists(dir_path):
                current_mtimes[dir_path] = os.path.getmtime(dir_path)
                current_file_count += len(glob.glob(os.path.join(dir_path, "*.json")))

        if workflow_cache["directory_mtimes"] != current_mtimes:
            return True

        if workflow_cache["file_count"] != current_file_count:
            return True

        return False
    except Exception:
        return False


def calculate_workflows_hash(workflows):
    try:
        import hashlib

        hash_string = ""
        for workflow in workflows:
            hash_string += (
                f"{workflow.get('id', '')}"
                f"{workflow.get('name', '')}"
                f"{workflow.get('last_modified', 0)}"
            )

        return hashlib.md5(hash_string.encode()).hexdigest()
    except Exception:
        return None


def update_workflow_cache_metadata(workflows, directories):
    try:
        current_mtimes = {}
        current_file_count = 0

        for dir_path in directories:
            if os.path.exists(dir_path):
                current_mtimes[dir_path] = os.path.getmtime(dir_path)
                current_file_count += len(glob.glob(os.path.join(dir_path, "*.json")))

        workflow_cache["directory_mtimes"] = current_mtimes
        workflow_cache["file_count"] = current_file_count
        workflow_cache["last_hash"] = calculate_workflows_hash(workflows)
    except Exception:
        pass


def should_refresh_workflow_cache(force_check_files=False):
    current_time = time.time()

    if not workflow_cache["workflows"]:
        return True

    if current_time - workflow_cache["last_update"] > workflow_cache["cache_duration"]:
        return True

    if force_check_files or (current_time - workflow_cache["last_update"] > 30):
        if check_workflow_directories_changed():
            return True

    return False


def _get_workflow_directories():
    workflow_dirs = []
    seen_dirs = set()

    def add_dir(path):
        if not path:
            return
        normalized = os.path.normpath(path)
        if normalized in seen_dirs or not os.path.exists(normalized):
            return
        seen_dirs.add(normalized)
        workflow_dirs.append(normalized)

    user_dir = folder_paths.get_user_directory()
    if user_dir:
        add_dir(os.path.join(user_dir, "workflows"))
        add_dir(os.path.join(user_dir, "default", "workflows"))

    base_candidates = []
    base_path = getattr(folder_paths, "base_path", None)
    if base_path:
        base_candidates.append(base_path)

    folder_paths_dir = os.path.dirname(folder_paths.__file__)
    base_candidates.append(os.path.abspath(os.path.join(folder_paths_dir, "..")))
    base_candidates.append(os.path.abspath(os.path.join(folder_paths_dir, "..", "..")))
    base_candidates.append(str(Path(__file__).resolve().parents[2]))

    for base_dir in base_candidates:
        add_dir(os.path.join(base_dir, "user", "default", "workflows"))
        add_dir(os.path.join(base_dir, "user", "workflows"))
        add_dir(os.path.join(base_dir, "workflows"))

    return workflow_dirs


def _build_workflow_id(json_path):
    try:
        normalized = Path(json_path).resolve().as_posix().lower()
    except Exception:
        normalized = Path(os.path.normpath(json_path)).as_posix().lower()
    return f"saved::{normalized}"


def _scan_saved_workflows():
    workflows = []
    seen_workflow_ids = set()
    workflow_dirs = _get_workflow_directories()

    for dir_path in workflow_dirs:
        for json_path in sorted(glob.glob(os.path.join(dir_path, "*.json"))):
            workflow_name = Path(json_path).stem
            workflow_id = _build_workflow_id(json_path)
            if not workflow_name or workflow_id in seen_workflow_ids:
                continue

            try:
                with open(json_path, "r", encoding="utf-8") as file_obj:
                    workflow_data = json.load(file_obj)
            except UnicodeDecodeError:
                with open(json_path, "r", encoding="utf-8-sig") as file_obj:
                    workflow_data = json.load(file_obj)
            except Exception:
                continue

            workflows.append(
                {
                    "id": workflow_id,
                    "name": workflow_name,
                    "filename": Path(json_path).name,
                    "type": "saved",
                    "path": json_path,
                    "last_modified": os.path.getmtime(json_path),
                    "workflow": workflow_data,
                }
            )
            seen_workflow_ids.add(workflow_id)

    workflows.sort(key=lambda item: (item.get("name", "").lower(), item.get("path", "").lower()))
    return workflows, workflow_dirs


def _serialize_workflow_list_items(workflows):
    serialized = []
    for item in workflows or []:
        serialized.append(
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "filename": item.get("filename"),
                "type": item.get("type", "saved"),
                "path": item.get("path"),
                "last_modified": item.get("last_modified"),
            }
        )
    return serialized

