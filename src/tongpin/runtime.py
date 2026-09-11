from __future__ import annotations

import asyncio
import tempfile

from tongpin.config import Settings
from tongpin.contracts.base import APIError
from tongpin.domain.auth import AuthService
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
        self.runner = JobRunner(self.jobs, self.executor)
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
        self.loop = None

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
            self.ready = True
        except BaseException:
            tempfile.tempdir = self._previous_tempdir
            self.lock.release()
            raise

    async def start(self):
        self.loop = asyncio.get_running_loop()
        await self.executor.run(self.initialize)
        self.runner.start()
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
        await self.runner.stop()
        self.cache.clear()
        self.executor.close()
        self.lock.release()
        if tempfile.tempdir == str(self.paths.temporary):
            tempfile.tempdir = self._previous_tempdir

    @property
    def features(self):
        return {"accounts": self.auth is not None, "chat": False, "admin": self.auth is not None}

    async def validate_connections(self):
        for sid, connection in list(self.connections.items()):
            try:
                await self.executor.run(self.auth.load_hash, connection["tokenHash"], False)
            except APIError:
                if self.transport:
                    await self.transport.disconnect(sid)

    def revalidate_connections(self):
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(lambda: asyncio.create_task(self.validate_connections()))
