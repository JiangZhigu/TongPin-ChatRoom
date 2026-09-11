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
        self._ws_latencies = deque(maxlen=2000)
        self._db_waits = deque(maxlen=2000)
        self._lock = threading.Lock()

    def request(self, status, milliseconds, path=''):
        with self._lock:
            self._counts["requests"] += 1
            if status >= 500:
                self._counts["serverErrors"] += 1
            elif status >= 400:
                self._counts["clientErrors"] += 1
            self._latencies.append(milliseconds)
            if status >= 400 and path.endswith('/messages'):
                self._counts['messageFailures'] += 1

    def websocket(self, failed, milliseconds):
        with self._lock:
            self._counts['wsRequests'] += 1
            if failed:
                self._counts['wsErrors'] += 1
                self._counts['messageFailures'] += 1
            self._ws_latencies.append(milliseconds)

    def database_write(self, milliseconds, failed):
        with self._lock:
            self._counts['dbWrites'] += 1
            self._counts['dbWriteErrors'] += int(failed)
            self._db_waits.append(milliseconds)

    @staticmethod
    def p95(values):
        ordered = sorted(values)
        return round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))], 2) if ordered else None

    def sample(self):
        data = {
            "sampledAt": int(time.time() * 1000),
            "uptimeSeconds": int(time.time() - self.started_at),
            "rssBytes": self._process.memory_info().rss,
            "cpuPercent": self._process.cpu_percent(),
            "threads": self._process.num_threads(),
        }
        with self._lock:
            if not self._samples:
                data['cpuPercent'] = None
            data.update(dict.fromkeys(('requests', 'serverErrors', 'clientErrors', 'wsRequests', 'wsErrors', 'dbWrites', 'dbWriteErrors', 'messageFailures'), 0))
            data.update(self._counts)
            data['latencyP95Ms'] = self.p95(self._latencies)
            data['wsLatencyP95Ms'] = self.p95(self._ws_latencies)
            data['dbWaitP95Ms'] = self.p95(self._db_waits)
            self._samples.append(data)
        return data

    def history(self):
        with self._lock:
            return list(self._samples)
