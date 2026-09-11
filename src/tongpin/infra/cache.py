from __future__ import annotations

import copy
import json
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from typing import TypeVar

from cachetools import TTLCache

T = TypeVar("T")


class BoundedCache:
    """TTL/LRU cache whose values are copied and whose active loaders are bounded."""

    def __init__(self, max_entries=10000, max_bytes=64 * 1024**2, ttl=60, clock=time.monotonic):
        self._cache = TTLCache(maxsize=max_entries, ttl=ttl, timer=clock)
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._lock = threading.RLock()
        self._flights: dict[str, Future] = {}

    def _size(self, key, value):
        return len(str(key).encode()) + len(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        )

    def _bytes(self):
        self._cache.expire()
        return sum(value[1] for value in self._cache.values())

    def get(self, key: str, default=None):
        with self._lock:
            value = self._cache.get(key)
            return copy.deepcopy(value[0]) if value is not None else default

    def set(self, key: str, value: T) -> bool:
        size = self._size(key, value)
        if size > self._max_bytes:
            return False
        with self._lock:
            self._cache.pop(key, None)
            while self._cache and self._bytes() + size > self._max_bytes:
                self._cache.popitem()
            self._cache[key] = (copy.deepcopy(value), size)
            return True

    def delete(self, key: str) -> None:
        with self._lock:
            self._cache.pop(key, None)

    def consume(self, key: str, callback: Callable[[T], object]):
        """Atomically inspect and consume or mutate a value without extending its TTL."""
        with self._lock:
            item = self._cache.get(key)
            if item is None:
                return None
            # Callback operates on the internal object under lock. It must not grow it.
            value = item[0]
            result = callback(value)
            if result is True:
                self._cache.pop(key, None)
            return result

    def get_or_load(self, key: str, loader: Callable[[], T]) -> T:
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                return copy.deepcopy(cached[0])
            future = self._flights.get(key)
            owner = future is None
            if owner:
                if len(self._flights) >= self._max_entries:
                    raise RuntimeError("Cache loader capacity reached")
                future = self._flights[key] = Future()
        if not owner:
            return copy.deepcopy(future.result())
        try:
            value = loader()
            self.set(key, value)
            future.set_result(value)
            return copy.deepcopy(value)
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self._lock:
                self._flights.pop(key, None)

    def stats(self):
        with self._lock:
            return {
                "entries": len(self._cache),
                "bytes": self._bytes(),
                "loading": len(self._flights),
                "maxEntries": self._max_entries,
                "maxBytes": self._max_bytes,
            }

    def clear(self):
        with self._lock:
            self._cache.clear()
