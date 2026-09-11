from __future__ import annotations

import asyncio
import threading
from dataclasses import replace

import httpx
import pytest
from asgiref.wsgi import WsgiToAsgi
from flask import Flask, request

from tongpin.asgi import create_application
from tongpin.contracts.base import APIError
from tongpin.transports.asgi.body_limits import GuardedWSGI


@pytest.mark.asyncio
async def test_health_real_flask_adapter_and_admin_disabled(settings):
    app = create_application(settings)
    await app.runtime.start()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
        ) as client:
            ready = await client.get("/health/ready")
            assert ready.status_code == 200
            assert ready.json()["data"]["features"]["accounts"] is True
            assert (await client.get("/api/v1/auth/bootstrap")).json()["data"][
                "accountsEnabled"
            ] is True
            assert (await client.get("/api/v1/admin/users")).status_code == 503
            assert (await client.post("/api/v1/admin/users", json={})).status_code == 403
    finally:
        await app.runtime.stop()


async def invoke_guard(guard, messages, path="/", headers=()):
    responses = []
    calls = 0

    async def receive():
        nonlocal calls
        calls += 1
        return messages.pop(0)

    async def send(message):
        responses.append(message)

    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "path": path,
        "root_path": "",
        "scheme": "http",
        "headers": list(headers),
        "server": ("127.0.0.1", 8765),
        "client": ("127.0.0.1", 1234),
        "query_string": b"",
    }
    await guard(scope, receive, send)
    return responses, calls


@pytest.mark.asyncio
async def test_chunked_limit_prevents_wsgi_call_and_declared_limit_does_not_read(settings):
    app = Flask("body-test")
    reached = []

    @app.post("/")
    def body():
        reached.append(True)
        return {"length": len(request.get_data())}

    guard = GuardedWSGI(WsgiToAsgi(app), replace(settings, json_limit=10))
    responses, calls = await invoke_guard(
        guard,
        [
            {"type": "http.request", "body": b"123456", "more_body": True},
            {"type": "http.request", "body": b"123456", "more_body": False},
        ],
    )
    assert calls == 2 and responses[0]["status"] == 413 and not reached
    responses, calls = await invoke_guard(guard, [], headers=[(b"content-length", b"999")])
    assert calls == 0 and responses[0]["status"] == 413
    responses, calls = await invoke_guard(guard, [], headers=[(b"content-length", b"1,2")])
    assert calls == 0 and responses[0]["status"] == 400


@pytest.mark.asyncio
async def test_upload_auth_happens_before_body_is_read(settings):
    called = []

    async def application(scope, receive, send):
        called.append(True)

    async def unauthorized(scope):
        raise APIError("AUTH_REQUIRED", "请先登录。", 401)

    guard = GuardedWSGI(application, settings, upload_guard=unauthorized)
    responses, calls = await invoke_guard(guard, [], path="/api/v1/attachments")
    assert calls == 0 and not called and responses[0]["status"] == 401


@pytest.mark.asyncio
async def test_wsgi_requests_can_overlap_but_thread_count_is_bounded(settings):
    app = Flask("concurrency-test")
    guard_lock = threading.Lock()
    release = threading.Event()
    entered = []

    @app.get("/")
    def block():
        with guard_lock:
            entered.append(threading.get_ident())
        assert release.wait(timeout=3)
        return {"ok": True}

    guard = GuardedWSGI(WsgiToAsgi(app), replace(settings, http_concurrency=2))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=guard), base_url="http://127.0.0.1:8765"
    ) as client:
        tasks = [asyncio.create_task(client.get("/")) for _ in range(3)]
        for _ in range(80):
            if len(entered) == 2:
                break
            await asyncio.sleep(0.01)
        assert len(set(entered)) == 2
        release.set()
        responses = await asyncio.gather(*tasks)
        assert all(response.status_code == 200 for response in responses)
