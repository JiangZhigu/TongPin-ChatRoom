from __future__ import annotations

import asyncio
import json
import tempfile
import threading

from tongpin.config import Settings
from tongpin.contracts.base import APIError
from tongpin.domain.access import AccessPolicy, blocked, user_summary
from tongpin.domain.auth import AuthService
from tongpin.domain.chat import ChatService
from tongpin.domain.contacts import ContactService
from tongpin.domain.events import EventService
from tongpin.domain.files import FileService
from tongpin.domain.groups import GroupService
from tongpin.domain.policy import PolicyService
from tongpin.infra.cache import BoundedCache
from tongpin.infra.db import Database
from tongpin.infra.executors import BlockingExecutor
from tongpin.infra.metrics import Metrics
from tongpin.infra.paths import DataPaths
from tongpin.infra.runtime_lock import RuntimeLock
from tongpin.jobs.repository import JobRepository
from tongpin.jobs.runner import JobRunner


class Runtime:
    def __init__(self, settings: Settings):
        settings.validate()
        self.settings = settings
        self.paths = DataPaths(settings.data_root)
        self.db = Database(self.paths.database)
        self.lock = RuntimeLock(self.paths.lock_file)
        self.cache = BoundedCache()
        self.executor = BlockingExecutor(settings.blocking_workers, settings.blocking_backlog)
        self.jobs = JobRepository(self.db)
        self.runner = JobRunner(self.jobs, self.executor, excluded_kinds=("files.process",))
        self.file_runner = JobRunner(self.jobs, self.executor, kinds=("files.process",))
        self.metrics = Metrics()
        self.ready = False
        self.auth = None
        self.policy = PolicyService(self)
        self.secret = settings.secret
        self.transport = None
        self._metric_task = None
        self._stopping = asyncio.Event()
        self._previous_tempdir = None
        self.connections = {}
        self._connection_lock = threading.RLock()
        self._presence_tasks = {}
        self._presence_cooldown = BoundedCache(max_entries=10000, max_bytes=1024 * 1024, ttl=300)
        self.loop = None
        self.access = AccessPolicy(self)
        self.events = EventService(self)
        self.contacts = ContactService(self)
        self.chat = ChatService(self)
        self.groups = GroupService(self)
        self.files = FileService(self)
        self.runner.handlers["events.dispatch"] = self._dispatch_job
        self.runner.handlers["groups.expire"] = self.groups.expire_job
        self.runner.handlers["files.cleanup"] = self.files.cleanup
        self.file_runner.handlers["files.process"] = self.files.process

    def initialize(self):
        self.paths.prepare()
        self.lock.acquire()
        try:
            self._previous_tempdir = tempfile.tempdir
            tempfile.tempdir = str(self.paths.temporary)
            self.db.migrate()
            self.db.health()
            if not self.secret:
                self.secret = self.paths.development_secret()
            self.auth = AuthService(self)
            self.files.initialize()
            self.ready = True
        except BaseException:
            tempfile.tempdir = self._previous_tempdir
            self.lock.release()
            raise

    async def start(self):
        self.loop = asyncio.get_running_loop()
        await self.executor.run(self.initialize)
        self.runner.start()
        self.file_runner.start()
        self._metric_task = asyncio.create_task(self._sample_metrics(), name="tongpin-metrics")

    async def _sample_metrics(self):
        while not self._stopping.is_set():
            await self.executor.run(self.metrics.sample)
            await self.validate_connections()
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=10)
            except TimeoutError:
                pass

    async def stop(self):
        self.ready = False
        self._stopping.set()
        if self._metric_task:
            await self._metric_task
        pending = list(self._presence_tasks.values())
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.runner.stop()
        await self.file_runner.stop()
        self.cache.clear()
        self.executor.close()
        self.lock.release()
        if tempfile.tempdir == str(self.paths.temporary):
            tempfile.tempdir = self._previous_tempdir

    @property
    def features(self):
        return {
            "accounts": self.auth is not None,
            "chat": self.auth is not None,
            "admin": self.auth is not None,
            "files": self.auth is not None,
        }

    def connections_snapshot(self):
        with self._connection_lock:
            return [(sid, dict(value)) for sid, value in self.connections.items()]

    def connection(self, sid):
        with self._connection_lock:
            value = self.connections.get(sid)
            return dict(value) if value else None

    def connection_count(self):
        with self._connection_lock:
            return len(self.connections)

    def is_connected(self, uid):
        with self._connection_lock:
            return any(value["userId"] == uid for value in self.connections.values())

    async def connected(self, sid, actor):
        with self._connection_lock:
            was_online = any(value["userId"] == actor.id for value in self.connections.values())
            self.connections[sid] = {
                "userId": actor.id,
                "sessionId": actor.session["id"],
                "tokenHash": actor.session["token_hash"],
            }
        pending = self._presence_tasks.pop(actor.id, None)
        if pending:
            pending.cancel()
        if not was_online and not pending:
            await self.emit_presence(actor.id)

    async def disconnected(self, sid):
        with self._connection_lock:
            old = self.connections.pop(sid, None)
            still_online = old and any(
                value["userId"] == old["userId"] for value in self.connections.values()
            )
        if old and not still_online and not self._stopping.is_set():
            uid = old["userId"]

            async def after_grace():
                try:
                    await asyncio.sleep(3)
                    if not self.is_connected(uid):
                        await self.emit_presence(uid)
                finally:
                    if self._presence_tasks.get(uid) is asyncio.current_task():
                        self._presence_tasks.pop(uid, None)

            self._presence_tasks[uid] = asyncio.create_task(after_grace())

    def _presence_audience(self, uid):
        with self.db.read() as conn:
            user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if not user:
                return []
            friends = conn.execute(
                "SELECT u.* FROM users u JOIN friendships f ON (f.low_id=? AND f.high_id=u.id) OR (f.high_id=? AND f.low_id=u.id) WHERE u.status='active'",
                (uid, uid),
            ).fetchall()
            result = []
            for friend in friends:
                if blocked(conn, uid, friend["id"]):
                    continue
                online = self.access.presence(conn, friend["id"], uid)
                preference = conn.execute(
                    "SELECT notify_online FROM friend_preferences WHERE user_id=? AND friend_id=?",
                    (friend["id"], uid),
                ).fetchone()
                notify = (
                    online
                    and preference
                    and preference[0]
                    and not json.loads(friend["preferences"]).get("doNotDisturb")
                )
                key = uid + ":" + friend["id"]
                if notify:
                    notify = not self._presence_cooldown.get(key, False)
                    self._presence_cooldown.set(key, True)
                result.append(
                    (
                        friend["id"],
                        {
                            "userId": uid,
                            "online": online,
                            "notify": bool(notify),
                            "user": user_summary(user),
                        },
                    )
                )
            return result

    async def emit_presence(self, uid):
        for recipient, payload in await self.executor.run(self._presence_audience, uid):
            await self.emit_to_user(recipient, "presence.changed", payload)

    def presence_changed(self, uid):
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(lambda: asyncio.create_task(self.emit_presence(uid)))

    async def emit_to_user(self, uid, event, payload):
        for sid, connection in self.connections_snapshot():
            if connection["userId"] != uid:
                continue
            try:
                await self.executor.run(self.auth.load_hash, connection["tokenHash"], False)
            except APIError:
                if self.transport:
                    await self.transport.disconnect(sid)
            else:
                if self.transport:
                    await self.transport.emit(event, payload, to=sid)

    def _dispatch_job(self, job):
        if not self.loop or self.loop.is_closed():
            raise RuntimeError("Event loop is unavailable")

        async def dispatch():
            for uid in job["payload"]["userIds"]:
                await self.emit_to_user(uid, "sync.available", {})

        future = asyncio.run_coroutine_threadsafe(dispatch(), self.loop)
        try:
            future.result(timeout=15)
        except BaseException:
            future.cancel()
            raise
        return {"hintDelivered": True}

    async def validate_connections(self):
        for sid, connection in self.connections_snapshot():
            try:
                await self.executor.run(self.auth.load_hash, connection["tokenHash"], False)
            except APIError:
                if self.transport:
                    await self.transport.disconnect(sid)

    def revalidate_connections(self):
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(lambda: asyncio.create_task(self.validate_connections()))
