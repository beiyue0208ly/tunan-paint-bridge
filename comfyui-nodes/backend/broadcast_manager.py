"""Broadcast helpers for TuNan Paint Bridge."""

import json


class BroadcastManager:
    def __init__(self, prompt_server, ps_connection_getter):
        self.prompt_server = prompt_server
        self.ps_connection_getter = ps_connection_getter
        self.methods = []
        self._discover_methods()

    def _discover_methods(self):
        prompt_server_instance = self.prompt_server.instance
        if hasattr(prompt_server_instance, "send"):
            self.methods.append(("prompt_server_send", self._prompt_server_send))

        if hasattr(prompt_server_instance, "send_sync"):
            self.methods.append(("prompt_server_send_sync", self._prompt_server_send_sync))

        self.methods.append(("websocket", self._websocket_broadcast))

    def _get_ps_connection(self):
        return self.ps_connection_getter() if self.ps_connection_getter else None

    async def _prompt_server_send(self, message_type, data):
        try:
            await self.prompt_server.instance.send(message_type, data)
            return True
        except Exception:
            return False

    async def _prompt_server_send_sync(self, message_type, data):
        try:
            self.prompt_server.instance.send_sync(message_type, data)
            return True
        except Exception:
            return False

    async def _websocket_broadcast(self, message_type, data):
        try:
            ps_connection = self._get_ps_connection()
            if ps_connection and ps_connection.clients:
                await ps_connection.broadcast(
                    {
                        "type": message_type,
                        "data": data,
                    }
                )
                return True
            return False
        except Exception:
            return False

    async def broadcast(self, message_type, data=None, priority_method=None):
        if data is None:
            data = {}

        if priority_method:
            for name, method in self.methods:
                if name == priority_method and await method(message_type, data):
                    return True

        for _, method in self.methods:
            try:
                if await method(message_type, data):
                    return True
            except Exception:
                continue

        return False

    def broadcast_sync(self, message_type, data=None):
        try:
            prompt_server_instance = self.prompt_server.instance
            if hasattr(prompt_server_instance, "send_sync"):
                prompt_server_instance.send_sync(message_type, data)
                return True

            ps_connection = self._get_ps_connection()
            if not (ps_connection and ps_connection.clients):
                return False

            message = {"type": message_type, "data": data}
            payload = json.dumps(message)
            for client in list(ps_connection.clients):
                try:
                    if hasattr(client, "send_text"):
                        client.send_text(payload)
                    elif hasattr(client, "send"):
                        client.send(payload)
                except Exception:
                    continue

            return True
        except Exception:
            return False

    async def broadcast_to_all_websockets(self, data):
        ps_connection = self._get_ps_connection()
        if not (ps_connection and ps_connection.clients):
            return False

        try:
            await ps_connection.broadcast(data)
            return True
        except Exception:
            return False

