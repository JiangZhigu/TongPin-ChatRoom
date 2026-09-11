from __future__ import annotations

import asyncio
import hashlib
import io
import os
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

import httpx
import pytest
from PIL import Image

from tongpin.config import Settings
from tongpin.contracts.chat import FriendRequestInput
from tongpin.runtime import Runtime


def test_real_upload_jobs_download_restart_replay_and_two_body_slots(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    data_root = tmp_path / "persistent"
    secret = "isolated-file-live-test-" * 3
    settings = Settings(data_root=data_root, environment="test", port=port, origins=(origin,), secret=secret)

    async def prepare():
        runtime = Runtime(settings)
        await runtime.start()
        try:
            identities = []
            with runtime.db.write() as conn:
                for index in range(3):
                    user = runtime.auth.create_user(conn, f"live_file_{index}", f"附件实测 {index}", "isolated-unused-hash")
                    token, result = runtime.auth.issue_session(conn, user, False, "isolated live file fixture")
                    identities.append((token, result["csrfToken"], user["id"]))
            one, two = [runtime.auth.load(item[0]) for item in identities[:2]]
            pending = runtime.contacts.request(one, FriendRequestInput(targetUserId=two.id))
            runtime.contacts.decide(two, pending["request"]["id"], "accept")
            return identities, runtime.chat.direct(one, two.id)
        finally:
            await runtime.stop()

    identities, conversation = asyncio.run(prepare())
    environment = os.environ.copy()
    environment.update(TONGPIN_ENV="test", TONGPIN_PORT=str(port), TONGPIN_ORIGINS=origin, TONGPIN_DATA_DIR=str(data_root), TONGPIN_SECRET=secret, TONGPIN_ALLOW_UNSCANNED_FILES="1")
    log = tmp_path / "server.log"

    def start():
        stream = log.open("a", encoding="utf-8")
        process = subprocess.Popen([sys.executable, "-m", "tongpin"], env=environment, stdout=stream, stderr=stream, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        for _ in range(120):
            if process.poll() is not None:
                stream.close()
                pytest.fail(log.read_text(encoding="utf-8"))
            try:
                if httpx.get(origin + "/health/ready", timeout=0.4).status_code == 200:
                    return process, stream
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
        process.terminate()
        process.wait(timeout=10)
        stream.close()
        pytest.fail("Isolated attachment service did not become ready")

    active = list(start())

    async def scenario():
        output = io.BytesIO()
        Image.new("RGB", (240, 140), (70, 120, 180)).save(output, "PNG")
        image = output.getvalue()
        text = "真实HTTP文件原件，重启后逐字节相同。\n".encode() * 300
        async with httpx.AsyncClient(base_url=origin, headers={"Origin": origin, "X-CSRF-Token": identities[0][1]}, cookies={"tp_session": identities[0][0]}, timeout=10) as one, httpx.AsyncClient(base_url=origin, headers={"Origin": origin, "X-CSRF-Token": identities[1][1]}, cookies={"tp_session": identities[1][0]}, timeout=10) as two:
            async def reserve(data, name):
                command = {"clientUploadId": str(uuid.uuid4()), "actorContext": identities[0][2], "name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mime": "", "purpose": "message", "conversationId": conversation["id"], "accessKey": conversation["accessKey"]}
                response = await one.post("/api/v1/attachment-uploads", json=command)
                assert response.status_code == 201, response.text
                return response.json()["data"], command

            first, first_command = await reserve(image, "真实图片.png")
            second, _ = await reserve(text, "真实文件.txt")
            third, _ = await reserve(image, "限流检查.png")
            gates = [asyncio.Event(), asyncio.Event()]
            release = asyncio.Event()

            async def held_body(data, gate):
                yield data[:10]
                gate.set()
                await release.wait()
                yield data[10:]

            async def raw(record, content):
                return await one.post("/api/v1/attachments", content=content, headers={"Content-Type": "application/octet-stream", "X-Upload-Id": record["id"]})

            bodies = [asyncio.create_task(raw(first, held_body(image, gates[0]))), asyncio.create_task(raw(second, held_body(text, gates[1])))]
            try:
                await asyncio.gather(*(gate.wait() for gate in gates))
                await asyncio.sleep(0.1)
                limited = await raw(third, image)
                assert limited.status_code == 503 and limited.json()["error"]["code"] == "UPLOAD_BUSY"
                plain = {"clientMessageId": str(uuid.uuid4()), "actorContext": identities[0][2], "accessKey": conversation["accessKey"], "text": "两条文件请求体等待时，文字仍成功。"}
                sent = await one.post(f"/api/v1/conversations/{conversation['id']}/messages", json=plain)
                assert sent.status_code == 201
                assert not any(task.done() for task in bodies)
            finally:
                release.set()
                uploaded = await asyncio.gather(*bodies)
            assert all(response.status_code == 202 for response in uploaded)
            for record in (first, second):
                for _ in range(120):
                    current = (await one.get(f"/api/v1/attachments/{record['id']}")).json()["data"]
                    if current["state"] != "processing":
                        break
                    await asyncio.sleep(0.05)
                assert current["state"] == "ready" and current["scanStatus"] == "not_scanned"
            message = {"clientMessageId": str(uuid.uuid4()), "actorContext": identities[0][2], "accessKey": conversation["accessKey"], "text": "", "attachmentIds": [first["id"], second["id"]]}
            endpoint = f"/api/v1/conversations/{conversation['id']}/messages"
            accepted = await one.post(endpoint, json=message)
            assert accepted.status_code == 201
            assert len(accepted.json()["data"]["message"]["attachments"]) == 2
            # The actual process is terminated after persisted reserve and ready/send states.
            # The next process must recover the reserved third record and retain the bytes.
            active[0].terminate()
            await asyncio.to_thread(active[0].wait, timeout=10)
            active[1].close()
            active[:] = await asyncio.to_thread(start)
            replay = await one.post(endpoint, json=message)
            assert replay.status_code == 201 and replay.json()["data"]["duplicate"]
            same_upload = (await one.post("/api/v1/attachment-uploads", json=first_command)).json()["data"]
            assert same_upload["id"] == first["id"] and same_upload["bound"]
            for record, expected in ((first, image), (second, text)):
                downloaded = await two.get(f"/api/v1/attachments/{record['id']}/content")
                assert downloaded.status_code == 200 and downloaded.content == expected
                assert hashlib.sha256(downloaded.content).hexdigest() == hashlib.sha256(expected).hexdigest()
                assert downloaded.headers["Content-Disposition"].startswith("attachment;")
            assert (await two.get(f"/api/v1/attachments/{third['id']}/content")).status_code == 404
            assert (await raw(third, image)).status_code == 202
            assert (await one.post(f"/api/v1/attachments/{third['id']}/cancel", json={})).status_code == 200
            for _ in range(120):
                policy = (await one.get("/api/v1/files/policy")).json()["data"]
                if policy["usedBytes"] == len(image) + len(text) and not policy["reservedBytes"]:
                    break
                await asyncio.sleep(0.05)
            assert policy["usedBytes"] == len(image) + len(text) and policy["reservedBytes"] == 0
            visible = (await two.get("/api/v1/files")).json()["data"]["items"]
            assert {record["id"] for record in visible} == {first["id"], second["id"]}
            with sqlite3.connect(data_root / "data/tongpin.sqlite3") as conn:
                assert conn.execute("SELECT COUNT(*) FROM messages WHERE client_message_id=?", (message["clientMessageId"],)).fetchone()[0] == 1
                assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                assert not conn.execute("PRAGMA foreign_key_check").fetchall()

    try:
        asyncio.run(scenario())
    finally:
        if active[0].poll() is None:
            active[0].terminate()
            active[0].wait(timeout=10)
        active[1].close()
