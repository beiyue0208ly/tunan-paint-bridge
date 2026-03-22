"""Photoshop connection runtime for TuNan Paint Bridge."""

from __future__ import annotations

import asyncio
import json
import logging
import time

LOGGER = logging.getLogger("tunan.paint.bridge.connection")


class PSConnectionManager:
    def __init__(self, prompt_server, workflow_backend, broadcast_manager_getter):
        self.prompt_server = prompt_server
        self.workflow_backend = workflow_backend
        self.broadcast_manager_getter = broadcast_manager_getter
        self.clients = set()
        self.ps_connected = False
        self.available_documents = ["当前活动文档"]
        self.last_activity = time.time()
        self.current_file = None
        self.file_buffer = bytearray()

    def _get_broadcast_manager(self):
        return self.broadcast_manager_getter() if self.broadcast_manager_getter else None

    async def add_client(self, ws):
        self.clients.add(ws)
        self.ps_connected = True
        self.last_activity = time.time()

        broadcast_manager = self._get_broadcast_manager()
        if broadcast_manager:
            await broadcast_manager.broadcast(
                "ps_connection_changed",
                {
                    "connected": True,
                    "client_count": len(self.clients),
                    "timestamp": time.time(),
                },
            )

    async def remove_client(self, ws):
        self.clients.discard(ws)
        if not self.clients:
            self.ps_connected = False

        broadcast_manager = self._get_broadcast_manager()
        if broadcast_manager:
            await broadcast_manager.broadcast(
                "ps_connection_changed",
                {
                    "connected": self.ps_connected,
                    "client_count": len(self.clients),
                    "timestamp": time.time(),
                },
            )

    async def broadcast(self, message):
        if not self.clients:
            return

        self.last_activity = time.time()
        payload = json.dumps(message, ensure_ascii=False)
        await asyncio.gather(
            *[client.send_str(payload) for client in self.clients],
            return_exceptions=True,
        )

    def update_documents(self, docs):
        self.available_documents = ["当前活动文档"] + list(docs or [])
        self.last_activity = time.time()

    def get_connection_status(self):
        return {
            "connected": self.ps_connected,
            "client_count": len(self.clients),
            "last_activity": self.last_activity,
            "status_text": "已连接" if self.ps_connected else "未连接",
            "status_color": "#4caf50" if self.ps_connected else "#ff6b6b",
        }

    def reset_file_transfer(self):
        self.current_file = None
        self.file_buffer = bytearray()

    @property
    def websocket_connected(self):
        return self.ps_connected

    @property
    def websocket_clients(self):
        return len(self.clients)

    async def send_initial_workflow_state(self, ws):
        try:
            await asyncio.sleep(0.5)
            current_time = time.time()
            authoritative_state = self.workflow_backend._refresh_global_tabs_state()
            LOGGER.debug(
                "[PSConnection] send_initial_workflow_state current_tab=%s tabs=%s session=%s",
                authoritative_state.get("current_tab"),
                len(authoritative_state.get("tabs", [])),
                authoritative_state.get("session_id"),
            )

            initial_state = {
                "type": "workflow_sync",
                "data": {
                    "tabs": authoritative_state.get("tabs", []),
                    "current_tab": authoritative_state.get("current_tab"),
                    "timestamp": current_time,
                    "source": "initial_connection",
                    "frontend_session_id": authoritative_state.get("session_id"),
                    "frontend_kind": authoritative_state.get("session_kind"),
                    "control_mode": authoritative_state.get("control_mode"),
                    "selected_session_id": authoritative_state.get("selected_session_id"),
                    "frontend_sessions": authoritative_state.get("frontend_sessions", []),
                    "available_frontends": authoritative_state.get("available_frontends"),
                },
            }
            await ws.send_str(json.dumps(initial_state, ensure_ascii=False))

            request_payload = {
                "requesting_client": "photoshop",
                "timestamp": current_time,
            }

            for event_name in ("tunan_request_current_workflow", "tunan_request_tabs"):
                try:
                    LOGGER.debug("[PSConnection] request_frontend_sync event=%s", event_name)
                    await self.prompt_server.instance.send(event_name, request_payload)
                except Exception:
                    LOGGER.exception("[PSConnection] request_frontend_sync_failed event=%s", event_name)
                    pass
        except Exception:
            LOGGER.exception("[PSConnection] send_initial_workflow_state_failed")
            try:
                await ws.send_str(
                    json.dumps(
                        {
                            "type": "workflow_sync",
                            "data": {
                                "tabs": [],
                                "current_tab": None,
                                "timestamp": time.time(),
                                "source": "initial_connection_fallback",
                            },
                        },
                        ensure_ascii=False,
                    )
                )
            except Exception:
                pass

