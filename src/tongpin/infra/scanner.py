from __future__ import annotations

import socket
import struct
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class ScanResult:
    status: str
    code: str | None = None


class ClamdScanner:
    """Local INSTREAM adapter: transport success is never a clean verdict."""

    def __init__(self, host="127.0.0.1", port=0, timeout=8.0):
        if host not in {"127.0.0.1", "::1"}:
            raise ValueError("Clamd must use an explicit loopback address")
        if not 0 <= port <= 65535 or not 0.1 <= timeout <= 15:
            raise ValueError("Invalid bounded scanner configuration")
        self.host, self.port, self.timeout = host, port, timeout

    @staticmethod
    def remaining(connection, deadline):
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError()
        connection.settimeout(left)

    def response(self, connection, deadline):
        result = bytearray()
        while True:
            self.remaining(connection, deadline)
            chunk = connection.recv(513 - len(result))
            if not chunk:
                break
            result.extend(chunk)
            if len(result) > 512:
                raise ValueError("Scanner response exceeded budget")
        if not result.endswith(b"\0") or result.count(b"\0") != 1:
            raise ValueError("Invalid scanner record framing")
        return bytes(result[:-1])

    def health(self):
        if not self.port:
            return {"status": "disabled", "code": "SCANNER_DISABLED"}
        deadline = time.monotonic() + self.timeout
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as conn:
                self.remaining(conn, deadline)
                conn.sendall(b"zPING\0")
                if self.response(conn, deadline) != b"PONG":
                    raise ValueError("Unexpected PING response")
        except (OSError, ValueError, TimeoutError):
            return {"status": "unavailable", "code": "SCANNER_UNAVAILABLE"}
        return {"status": "reachable", "code": None}

    def scan(self, path, maximum):
        if not self.port:
            return ScanResult("unknown", "SCANNER_DISABLED")
        deadline = time.monotonic() + self.timeout
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as conn:
                self.remaining(conn, deadline)
                conn.sendall(b"zINSTREAM\0")
                size = 0
                with path.open("rb") as stream:
                    while chunk := stream.read(65536):
                        size += len(chunk)
                        if size > maximum:
                            raise ValueError("File exceeded scan budget")
                        self.remaining(conn, deadline)
                        conn.sendall(struct.pack("!I", len(chunk)) + chunk)
                self.remaining(conn, deadline)
                conn.sendall(b"\0\0\0\0")
                result = self.response(conn, deadline)
        except (OSError, ValueError, TimeoutError):
            return ScanResult("unknown", "SCANNER_UNAVAILABLE")
        if result == b"stream: OK":
            return ScanResult("clean")
        if result.startswith(b"stream: ") and result.endswith(b" FOUND") and len(result) > 15:
            return ScanResult("infected", "FILE_INFECTED")
        return ScanResult("unknown", "SCANNER_INVALID_RESULT")

