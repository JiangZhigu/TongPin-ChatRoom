from __future__ import annotations

import os
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path


def reject_links(path: Path) -> None:
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError("Data paths must not traverse symbolic links or junctions")


@dataclass
class DataPaths:
    root: Path

    def __post_init__(self) -> None:
        reject_links(self.root.absolute())
        self.root = self.root.resolve()
        self.database = self.root / "data/tongpin.sqlite3"
        self.uploads = self.root / "private-uploads"
        self.temporary = self.root / "upload-tmp"
        self.backups = self.root / "backups"
        self.exports = self.root / "exports"
        self.logs = self.root / "logs"
        self.lock_file = self.root / "instance.lock"

    def prepare(self) -> None:
        for path in (
            self.root,
            self.database.parent,
            self.uploads,
            self.temporary,
            self.backups,
            self.exports,
            self.logs,
        ):
            reject_links(path)
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not path.is_dir():
                raise ValueError("A required data path is not a directory")
        probe = self.temporary / ("probe-" + secrets.token_hex(16))
        descriptor = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        probe.unlink()

    def private_file(self, directory: Path, key: str) -> Path:
        if (
            not key
            or len(key) > 200
            or any(c not in "0123456789abcdefghijklmnopqrstuvwxyz-_." for c in key)
            or ".." in key
        ):
            raise ValueError("Invalid private storage key")
        target = directory / key
        reject_links(target)
        if target.resolve().parent != directory.resolve():
            raise ValueError("Private storage path escaped its directory")
        return target

    def disk_state(self) -> dict:
        usage = shutil.disk_usage(self.root)
        return {
            "totalBytes": usage.total,
            "freeBytes": usage.free,
            "usedPercent": 100 * usage.used / usage.total,
        }

    def development_secret(self) -> str:
        path = self.root / "development.key"
        reject_links(path)
        if not path.exists():
            try:
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(descriptor, "w", encoding="ascii") as stream:
                    stream.write(secrets.token_urlsafe(48))
        secret = path.read_text(encoding="ascii").strip()
        if len(secret) < 32:
            raise ValueError(
                "Development key is invalid; preserve it and investigate instead of replacing it"
            )
        return secret
