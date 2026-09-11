from __future__ import annotations

import os
from pathlib import Path

import portalocker

from .paths import reject_links


class RuntimeLock:
    def __init__(self, path: Path):
        self.path = path
        self._lock = None

    def acquire(self) -> None:
        reject_links(self.path)
        lock = portalocker.Lock(
            str(self.path), mode="a+", timeout=0, flags=portalocker.LOCK_EX | portalocker.LOCK_NB
        )
        try:
            stream = lock.acquire()
        except portalocker.exceptions.LockException as exc:
            raise RuntimeError(
                "This data directory is already used by another Tongpin process"
            ) from exc
        stream.seek(0)
        stream.truncate()
        stream.write(f"pid={os.getpid()}\n")
        stream.flush()
        self._lock = lock

    def release(self) -> None:
        if self._lock is not None:
            self._lock.release()
            self._lock = None
