from __future__ import annotations

import threading
import time
from collections import Counter, deque

import psutil


class Metrics:
    def __init__(self):
        self.started_at = time.time()
        self._process = psutil.Process()
        self._counts = Counter()
        self._latencies = deque(maxlen=2000)
        self._samples = deque(maxlen=720)
        self._lock = threading.Lock()

    def request(self, status, milliseconds):
        with self._lock:
            self._counts["requests"] += 1
            if status >= 500:
                self._counts["serverErrors"] += 1
            elif status >= 400:
                self._counts["clientErrors"] += 1
            self._latencies.append(milliseconds)

    def sample(self):
        data = {
            "sampledAt": int(time.time() * 1000),
            "uptimeSeconds": int(time.time() - self.started_at),
            "rssBytes": self._process.memory_info().rss,
            "cpuPercent": self._process.cpu_percent(),
            "threads": self._process.num_threads(),
        }
        with self._lock:
            ordered = sorted(self._latencies)
            data.update(self._counts)
            data["latencyP95Ms"] = (
                round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 2)
                if ordered
                else None
            )
            self._samples.append(data)
        return data

    def history(self):
        with self._lock:
            return list(self._samples)
