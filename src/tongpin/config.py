from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

PROJECT_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_POLICY = {
    "registration_mode": "closed",
    "group_limit": 200,
    "owned_group_limit": 20,
    "image_limit_bytes": 10 * 1024**2,
    "file_limit_bytes": 25 * 1024**2,
    "attachment_count": 6,
    "message_attachment_bytes": 50 * 1024**2,
    "user_quota_bytes": 1024**3,
    "disk_high_watermark": 90,
    "message_codepoints": 4000,
    "message_bytes": 16384,
    "recall_seconds": 120,
    "deleted_content_days": 30,
    "audit_days": 180,
    "log_days": 30,
    "events_days": 30,
    "export_hours": 24,
    "deletion_cooling_days": 30,
    "maintenance": False,
    "strict_files": True,
    "operator_name": "",
    "operator_contact": "",
    "terms_version": "development-1",
    "site_name": "同频",
    "registration_per_hour": 20,
    "login_ip_per_15m": 100,
    "login_user_per_15m": 15,
    "message_per_minute": 120,
    "group_create_per_hour": 30,
    "online_notifications": True,
}


@dataclass(frozen=True)
class Settings:
    data_root: Path = field(default_factory=lambda: PROJECT_ROOT / "var")
    environment: str = "development"
    host: str = "127.0.0.1"
    port: int = 8765
    origins: tuple[str, ...] = (
        "http://127.0.0.1:8765",
        "http://localhost:8765",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    )
    secret: str = ""
    http_concurrency: int = 8
    blocking_workers: int = 8
    blocking_backlog: int = 32
    request_timeout: float = 30
    upload_timeout: float = 120
    json_limit: int = 65536
    upload_limit: int = 26 * 1024**2
    upload_concurrency: int = 2
    scanner_host: str = "127.0.0.1"
    scanner_port: int = 0
    scanner_timeout: float = 8.0
    allow_unscanned_files: bool = False
    max_connections: int = 200
    web_dist: Path = field(default_factory=lambda: PROJECT_ROOT / "apps/web/dist")

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ
        root = Path(env.get("TONGPIN_DATA_DIR", str(PROJECT_ROOT / "var"))).expanduser()
        if not root.is_absolute():
            root = PROJECT_ROOT / root
        port = int(env.get("TONGPIN_PORT", "8765"))
        defaults = (
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
        )
        origins = tuple(
            filter(
                None,
                (
                    s.strip().rstrip("/")
                    for s in env.get("TONGPIN_ORIGINS", ",".join(defaults)).split(",")
                ),
            )
        )
        result = cls(
            data_root=root,
            environment=env.get("TONGPIN_ENV", "development"),
            host=env.get("TONGPIN_HOST", "127.0.0.1"),
            port=port,
            origins=origins,
            secret=env.get("TONGPIN_SECRET", ""),
            scanner_host=env.get("TONGPIN_CLAMD_HOST", "127.0.0.1"),
            scanner_port=int(env.get("TONGPIN_CLAMD_PORT", "0")),
            allow_unscanned_files=env.get("TONGPIN_ALLOW_UNSCANNED_FILES", "0") == "1",
        )
        result.validate()
        return result

    @property
    def production(self) -> bool:
        return self.environment == "production"

    def validate(self) -> None:
        if self.environment not in {"development", "test", "production"}:
            raise ValueError("TONGPIN_ENV must be development, test, or production")
        if not 1 <= self.port <= 65535 or self.http_concurrency < 1:
            raise ValueError("Invalid server port or concurrency")
        if (
            self.data_root.resolve() == Path(self.data_root.anchor)
            or self.data_root.resolve() == PROJECT_ROOT
        ):
            raise ValueError("A dedicated data directory is required")
        if not self.origins:
            raise ValueError("At least one explicit origin is required")
        for origin in self.origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.username
            ):
                raise ValueError(
                    "Origins must be exact http(s) origins, without paths or wildcards"
                )
            if self.production and parsed.scheme != "https":
                raise ValueError("Production requires HTTPS origins")
        if self.production and len(self.secret.encode()) < 32:
            raise ValueError(
                "Production requires an externally provided secret of at least 32 bytes"
            )
        if self.production and self.allow_unscanned_files:
            raise ValueError("Unscanned closed-test files cannot be enabled in production")
        if self.scanner_host not in {"127.0.0.1", "::1"} or not 0 <= self.scanner_port <= 65535:
            raise ValueError("Clamd must use a loopback address and valid port")
        if not 0.1 <= self.scanner_timeout <= 15 or not 1 <= self.upload_concurrency <= 2:
            raise ValueError("Invalid bounded file processing configuration")
        if not self.production and self.host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Development and test servers bind to loopback only")
