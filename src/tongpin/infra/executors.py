from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial


class CapacityExceeded(RuntimeError):
    pass


class BlockingExecutor:
    def __init__(self, workers=8, backlog=32):
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tongpin-domain")
        self._capacity = workers + backlog
        self._inflight = 0
        self._closed = False

    async def run(self, function, *args, **kwargs):
        if self._closed or self._inflight >= self._capacity:
            raise CapacityExceeded("Blocking work queue is full")
        self._inflight += 1
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self._pool, partial(function, *args, **kwargs))
        # Release capacity when the worker actually finishes, including cancelled callers.
        future.add_done_callback(lambda _: self._release())
        return await asyncio.shield(future)

    def _release(self):
        self._inflight -= 1

    def stats(self):
        return {"inflight": self._inflight, "capacity": self._capacity}

    def close(self):
        self._closed = True
        self._pool.shutdown(wait=True, cancel_futures=False)
