from __future__ import annotations

import asyncio
import logging


class JobRunner:
    def __init__(self, repository, executor):
        self.repository = repository
        self.executor = executor
        self.handlers = {}
        self._task = None
        self._stop = asyncio.Event()

    def start(self):
        self._task = asyncio.create_task(self._run(), name="tongpin-jobs")

    async def stop(self):
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self):
        while not self._stop.is_set():
            try:
                job = await self.executor.run(self.repository.claim)
                if job:
                    handler = self.handlers.get(job["kind"])
                    if handler is None:
                        await self.executor.run(
                            self.repository.fail,
                            job["id"],
                            "UNKNOWN_JOB_KIND",
                            job["attempts"],
                            False,
                        )
                    else:
                        try:
                            result = await self.executor.run(handler, job)
                        except Exception:  # noqa: BLE001 -- A failed durable job must not stop the runner.
                            await self.executor.run(
                                self.repository.fail,
                                job["id"],
                                "JOB_EXECUTION_FAILED",
                                job["attempts"],
                            )
                        else:
                            await self.executor.run(self.repository.complete, job["id"], result)
                    continue
            except Exception:  # noqa: BLE001 -- Poll failures are isolated and retried with a delay.
                logging.getLogger("tongpin").error("Background job polling failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=1)
            except TimeoutError:
                pass
