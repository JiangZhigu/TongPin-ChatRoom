from __future__ import annotations

import socketio
from asgiref.wsgi import WsgiToAsgi

from tongpin.config import Settings
from tongpin.contracts.base import APIError
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
            # M2 adds authenticated tickets. A running transport does not imply login exists.
            return False

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
