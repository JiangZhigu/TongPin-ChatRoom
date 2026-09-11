from __future__ import annotations

import asyncio
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

import httpx
import pytest
from websockets.asyncio.client import connect

from tongpin.config import Settings
from tongpin.contracts.chat import FriendRequestInput
from tongpin.runtime import Runtime


def test_two_live_clients_committed_ack_receiver_catchup_and_lost_ack_restart(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    data_root = tmp_path / "persistent"
    secret = "isolated-messaging-live-test-" * 3
    settings = Settings(data_root=data_root, environment="test", port=port, origins=(origin,), secret=secret)

    async def prepare():
        runtime = Runtime(settings)
        await runtime.start()
        try:
            identities = []
            with runtime.db.write() as conn:
                for index in range(2):
                    user = runtime.auth.create_user(conn, f"live_actor_{index}", f"实测 {index}", "test-only-unused-hash")
                    token, result = runtime.auth.issue_session(conn, user, False, "isolated live fixture")
                    identities.append((token, result["csrfToken"], user["id"]))
            one, two = [runtime.auth.load(item[0]) for item in identities]
            pending = runtime.contacts.request(one, FriendRequestInput(targetUserId=two.id))
            runtime.contacts.decide(two, pending["request"]["id"], "accept")
            conversation = runtime.chat.direct(one, two.id)
            return identities, conversation
        finally:
            await runtime.stop()

    identities, conversation = asyncio.run(prepare())
    database = data_root / "data/tongpin.sqlite3"
    log = tmp_path / "server.log"
    environment = os.environ.copy()
    environment.update(TONGPIN_ENV="test", TONGPIN_PORT=str(port), TONGPIN_ORIGINS=origin, TONGPIN_DATA_DIR=str(data_root), TONGPIN_SECRET=secret)

    def start():
        stream = log.open("a", encoding="utf-8")
        process = subprocess.Popen([sys.executable, "-m", "tongpin"], env=environment, stdout=stream, stderr=stream, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        for _ in range(100):
            if process.poll() is not None:
                stream.close()
                pytest.fail(log.read_text(encoding="utf-8"))
            try:
                if httpx.get(origin + "/health/ready", timeout=0.5).status_code == 200:
                    return process, stream
            except httpx.HTTPError:
                pass
            time.sleep(0.05)
        process.terminate()
        process.wait(timeout=10)
        stream.close()
        pytest.fail("Isolated messaging service did not become ready")

    def count(mid):
        with sqlite3.connect(database) as conn:
            return conn.execute("SELECT COUNT(*) FROM messages WHERE client_message_id=?", (mid,)).fetchone()[0]

    active = list(start())

    async def scenario():
        async with httpx.AsyncClient(base_url=origin, headers={"Origin": origin, "X-CSRF-Token": identities[0][1]}, cookies={"tp_session": identities[0][0]}) as one, httpx.AsyncClient(base_url=origin, headers={"Origin": origin, "X-CSRF-Token": identities[1][1]}, cookies={"tp_session": identities[1][0]}) as two:
            async def websocket(client, token):
                ticket = (await client.post("/api/v1/auth/ws-ticket", json={})).json()["data"]["ticket"]
                connection = await connect(origin.replace("http:", "ws:") + "/socket.io/?EIO=4&transport=websocket", origin=origin, additional_headers={"Cookie": "tp_session=" + token})
                assert connection.response.status_code == 101
                assert (await asyncio.wait_for(connection.recv(), 3)).startswith("0")
                await connection.send("40" + json.dumps({"ticket": ticket}))
                while not (await asyncio.wait_for(connection.recv(), 3)).startswith("40"):
                    pass
                return connection

            async def matching(connection, prefix):
                async with asyncio.timeout(8):
                    while True:
                        frame = await connection.recv()
                        if frame == "2":
                            await connection.send("3")
                        elif frame.startswith(prefix):
                            return frame

            def payload(text):
                return {"clientMessageId": str(uuid.uuid4()), "accessKey": conversation["accessKey"], "actorContext": identities[0][2], "text": text}

            endpoint = "/api/v1/conversations/" + conversation["id"] + "/messages"
            a = await websocket(one, identities[0][0])
            b = await websocket(two, identities[1][0])
            try:
                cursor = (await two.get("/api/v1/sync/snapshot")).json()["data"]["cursor"]
                first = payload("live websocket 中文消息")
                await a.send('421' + json.dumps(["message.send", {**first, "conversationId": conversation["id"], "v": 1, "requestId": "live-ack-1"}]))
                ack = json.loads((await matching(a, "431"))[3:])[0]
                assert ack["ok"] is True and ack["data"]["duplicate"] is False
                assert count(first["clientMessageId"]) == 1  # Visible in another DB connection after ACK.
                hint = json.loads((await matching(b, '42["sync.available"'))[2:])
                assert hint == ["sync.available", {}]
                events = (await two.get("/api/v1/sync", params={"after": cursor})).json()["data"]
                assert [event["message"]["text"] for event in events["items"] if event["type"] == "message.created"] == [first["text"]]
                cursor = events["cursor"]
                await b.close()
                offline = payload("receiver disconnected, durable catchup")
                assert (await one.post(endpoint, json=offline)).status_code == 201
                # Persist a third message, then kill the server without consuming its ACK.
                uncertain = payload("committed before process stop, ACK intentionally unread")
                await a.send('422' + json.dumps(["message.send", {**uncertain, "conversationId": conversation["id"], "v": 1, "requestId": "live-lost-ack"}]))
                for _ in range(100):
                    if count(uncertain["clientMessageId"]) == 1:
                        break
                    await asyncio.sleep(0.02)
                assert count(uncertain["clientMessageId"]) == 1
                active[0].terminate()
                await asyncio.to_thread(active[0].wait, timeout=10)
                active[1].close()
                active[:] = await asyncio.to_thread(start)
                retry = (await one.post(endpoint, json=uncertain)).json()["data"]
                assert retry["duplicate"] is True and count(uncertain["clientMessageId"]) == 1
                events = (await two.get("/api/v1/sync", params={"after": cursor})).json()["data"]
                catchup = [event["message"] for event in events["items"] if event["type"] == "message.created"]
                assert len(catchup) == 2 and len({row["id"] for row in catchup}) == 2
                assert {row["text"] for row in catchup} == {offline["text"], uncertain["text"]}
                history = (await two.get(endpoint)).json()["data"]["items"]
                assert len(history) == 3 and [row["seq"] for row in history] == ["1", "2", "3"]
                b = await websocket(two, identities[1][0])  # A new process accepts a fresh one-use ticket.
                assert (await two.get("/api/v1/auth/me")).status_code == 200
            finally:
                await a.close()
                await b.close()
    try:
        asyncio.run(scenario())
    finally:
        if active[0].poll() is None:
            active[0].terminate()
            active[0].wait(timeout=10)
        active[1].close()
