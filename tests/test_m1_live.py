from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time

import httpx
import pytest
from websockets.asyncio.client import connect


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def test_real_server_ws_upgrade_lock_and_restart(tmp_path):
    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    environment = os.environ.copy()
    environment.update(
        TONGPIN_ENV="test",
        TONGPIN_PORT=str(port),
        TONGPIN_ORIGINS=origin,
        TONGPIN_DATA_DIR=str(tmp_path / "persistent"),
        TONGPIN_SECRET="isolated-live-test-" * 3,
    )
    logs = tmp_path / "server.log"

    def start():
        stream = logs.open("a", encoding="utf-8")
        process = subprocess.Popen(
            [sys.executable, "-m", "tongpin"],
            env=environment,
            stdout=stream,
            stderr=stream,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        for _ in range(100):
            if process.poll() is not None:
                stream.close()
                pytest.fail(logs.read_text(encoding="utf-8"))
            try:
                response = httpx.get(origin + "/health/ready", timeout=0.4)
                if response.status_code == 200:
                    return process, stream
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
        process.terminate()
        process.wait(timeout=10)
        stream.close()
        pytest.fail("Actual server did not become ready")

    async def ws():
        async with connect(
            origin.replace("http:", "ws:") + "/socket.io/?EIO=4&transport=websocket", origin=origin
        ) as connection:
            hello = await asyncio.wait_for(connection.recv(), 3)
            assert hello.startswith("0") and json.loads(hello[1:])["sid"]
            assert connection.response.status_code == 101
            await connection.send("40")
            rejected = await asyncio.wait_for(connection.recv(), 3)
            assert rejected.startswith("44")  # M1 deliberately does not authenticate clients.

    process, stream = start()
    try:
        asyncio.run(ws())
        other = environment.copy()
        other["TONGPIN_PORT"] = str(free_port())
        second = subprocess.run(
            [sys.executable, "-m", "tongpin"], env=other, capture_output=True, text=True, timeout=15, check=False
        )
        assert second.returncode != 0 and "already used by another" in second.stderr
        assert httpx.get(origin + "/health/ready").status_code == 200
    finally:
        process.terminate()
        process.wait(timeout=10)
        stream.close()
    # New process reacquires the OS lock after an ungraceful process termination.
    process, stream = start()
    try:
        assert (tmp_path / "persistent/data/tongpin.sqlite3").is_file()
        assert httpx.get(origin + "/health/ready").status_code == 200
    finally:
        process.terminate()
        process.wait(timeout=10)
        stream.close()
