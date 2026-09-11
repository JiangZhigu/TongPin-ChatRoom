from __future__ import annotations

import socketio
from asgiref.wsgi import WsgiToAsgi
from pydantic import ValidationError

from tongpin.config import Settings
from tongpin.contracts.base import APIError
from tongpin.contracts.chat import MessageInput, SocketMessageInput
from tongpin.runtime import Runtime
from tongpin.transports.asgi.body_limits import GuardedWSGI
from tongpin.transports.http import create_http_app


class Application:
    def __init__(self, settings: Settings):
        self.runtime = Runtime(settings)
        self.flask = create_http_app(self.runtime)
        self.sio = socketio.AsyncServer(
            async_mode="asgi",
            cors_allowed_origins=list(settings.origins),
            max_http_buffer_size=65536,
            ping_interval=20,
            ping_timeout=20,
            logger=False,
            engineio_logger=False,
        )
        self.runtime.transport = self.sio
        fallback = GuardedWSGI(WsgiToAsgi(self.flask), settings, upload_guard=self.upload_guard)
        self.application = socketio.ASGIApp(self.sio, other_asgi_app=fallback)

        @self.sio.event
        async def connect(sid, environ, auth):
            if (
                not self.runtime.auth
                or not isinstance(auth, dict)
                or set(auth) - {"ticket"}
                or not isinstance(auth.get("ticket"), str)
                or len(auth["ticket"]) > 128
            ):
                return False
            if (
                environ.get("HTTP_ORIGIN") not in settings.origins
                or self.runtime.connection_count() >= settings.max_connections
            ):
                return False
            try:
                credential = self.runtime.auth.cookie_from(environ.get("HTTP_COOKIE", ""))
                actor = await self.runtime.executor.run(
                    self.runtime.auth.authorize_ticket, auth["ticket"], credential
                )
                if self.runtime.connection_count() >= settings.max_connections:
                    return False
            except APIError:
                return False
            await self.sio.enter_room(sid, "user:" + actor.id)
            await self.runtime.connected(sid, actor)

        @self.sio.event
        async def disconnect(sid, reason=None):
            await self.runtime.disconnected(sid)

        @self.sio.on("message.send")
        async def message_send(sid, payload):
            request_id = "invalid-command"
            try:
                data = SocketMessageInput.model_validate(payload)
                request_id = data.requestId
                connection = self.runtime.connection(sid)
                if not connection:
                    raise APIError("AUTH_REQUIRED", "登录会话已失效。", 401)
                actor = await self.runtime.executor.run(
                    self.runtime.auth.load_hash, connection["tokenHash"]
                )
                message = MessageInput.model_validate(
                    data.model_dump(exclude={"v", "conversationId", "requestId"})
                )
                result = await self.runtime.executor.run(
                    self.runtime.chat.send, actor, data.conversationId, message
                )
                return {"ok": True, "requestId": request_id, "data": result}
            except ValidationError:
                error = APIError("VALIDATION_ERROR", "消息格式无效。", 422)
            except APIError as caught:
                error = caught
            except Exception:  # noqa: BLE001 -- Do not expose exception data in Socket.IO ACKs.
                error = APIError(
                    "TEMPORARY_UNAVAILABLE", "暂时无法确认消息结果，请使用原消息标识重试。", 503
                )
            return {
                "ok": False,
                "requestId": request_id,
                "status": error.status,
                "error": error.payload(request_id)["error"],
            }

    async def upload_guard(self, scope):
        if self.runtime.auth is None:
            raise APIError("AUTH_REQUIRED", "请先登录。", 401)
        await self.runtime.executor.run(self.runtime.auth.authorize_upload_scope, scope)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    try:
                        await self.runtime.start()
                    except Exception as error:  # noqa: BLE001 -- ASGI must report any startup failure.
                        await send(
                            {
                                "type": "lifespan.startup.failed",
                                "message": f"Tongpin startup failed: {type(error).__name__}: {error}",
                            }
                        )
                        return
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await self.sio.shutdown()
                    await self.runtime.stop()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        else:
            await self.application(scope, receive, send)


def create_application(settings: Settings | None = None) -> Application:
    return Application(settings or Settings.from_env())
