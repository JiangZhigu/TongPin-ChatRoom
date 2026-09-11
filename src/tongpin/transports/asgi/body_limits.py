from __future__ import annotations

import asyncio
import json
import secrets
import time

from asgiref.sync import ThreadSensitiveContext

from tongpin.contracts.base import APIError
from tongpin.infra.executors import CapacityExceeded


class BodyTooLarge(Exception):
    pass


class ClientDisconnected(Exception):
    pass


class GuardedWSGI:
    """Bounds accepted body bytes and concurrent per-request WSGI thread contexts."""

    def __init__(self, application, settings, upload_guard=None):
        self.application = application
        self.settings = settings
        self.upload_guard = upload_guard
        self.slots = asyncio.Semaphore(settings.http_concurrency)

    async def reject(self, send, error):
        request_id = secrets.token_hex(12)
        body = json.dumps(error.payload(request_id), ensure_ascii=False).encode()
        headers = [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"cache-control", b"no-store"),
            (b"content-length", str(len(body)).encode()),
            (b"x-request-id", request_id.encode()),
        ]
        if error.retry_after_ms:
            headers.append((b"retry-after", str(max(1, error.retry_after_ms // 1000)).encode()))
        await send({"type": "http.response.start", "status": error.status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        is_upload = scope.get("path") == "/api/v1/attachments" and scope.get("method") == "POST"
        maximum = self.settings.upload_limit if is_upload else self.settings.json_limit
        deadline = time.monotonic() + (
            self.settings.upload_timeout if is_upload else self.settings.request_timeout
        )
        lengths = [
            value for name, value in scope.get("headers", []) if name.lower() == b"content-length"
        ]
        try:
            if len(lengths) > 1 or (lengths and not lengths[0].isdigit()):
                raise APIError("INVALID_LENGTH", "请求长度格式无效。", 400)
            if lengths and int(lengths[0]) > maximum:
                raise APIError("PAYLOAD_TOO_LARGE", "请求内容超过允许大小。", 413)
            try:
                await asyncio.wait_for(self.slots.acquire(), timeout=0.25)
            except TimeoutError as error:
                raise APIError(
                    "TEMPORARY_UNAVAILABLE", "服务繁忙，请稍后重试。", 503, retry_after_ms=1000
                ) from error
        except APIError as error:
            await self.reject(send, error)
            return

        accepted = 0
        response_started = False

        async def counted_receive():
            nonlocal accepted
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            message = await asyncio.wait_for(receive(), remaining)
            if message["type"] == "http.disconnect":
                raise ClientDisconnected()
            if message["type"] == "http.request":
                accepted += len(message.get("body", b""))
                if accepted > maximum:
                    raise BodyTooLarge()
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            if is_upload:
                if self.upload_guard is None:
                    raise APIError("AUTH_REQUIRED", "请先登录。", 401)
                await self.upload_guard(scope)
            async with ThreadSensitiveContext():
                await self.application(scope, counted_receive, tracked_send)
        except BodyTooLarge:
            if not response_started:
                await self.reject(
                    send, APIError("PAYLOAD_TOO_LARGE", "请求内容超过允许大小。", 413)
                )
        except TimeoutError:
            if not response_started:
                await self.reject(send, APIError("REQUEST_TIMEOUT", "请求接收超时，请重试。", 408))
        except APIError as error:
            if not response_started:
                await self.reject(send, error)
        except CapacityExceeded:
            if not response_started:
                await self.reject(
                    send, APIError("TEMPORARY_UNAVAILABLE", "服务繁忙，请稍后重试。", 503)
                )
        except ClientDisconnected:
            return
        finally:
            self.slots.release()
