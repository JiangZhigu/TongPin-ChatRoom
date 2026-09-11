from __future__ import annotations

import hashlib
import hmac
import json
import re
import shutil
import sqlite3
import stat
import zipfile
from pathlib import Path

from tongpin import __version__
from tongpin.admin.authz import compact
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms
from tongpin.infra.paths import reject_links

MAX_BACKUP_BYTES = 10 * 1024**3
MAX_FILES = 100000
CHUNK = 1024 * 1024


def artifact_error(message="归档完整性检查失败。", code="ARTIFACT_INVALID"):
    return APIError(code, message, 409)


def checksum(path, check=lambda: None):
    digest = hashlib.sha256()
    reject_links(path)
    with path.open("rb") as stream:
        while block := stream.read(CHUNK):
            check()
            digest.update(block)
    return digest.hexdigest()


def private_directory(runtime, base, key, *, create=False):
    path = runtime.paths.private_file(base, key)
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    if path.exists() and not path.is_dir():
        raise artifact_error("任务私有目录状态异常。")
    return path


def remove_private_tree(runtime, path):
    path = Path(path).absolute()
    reject_links(path)
    allowed = (runtime.paths.exports, runtime.paths.backups)
    if path.parent not in allowed or not re.fullmatch(r"op-[0-9a-f-]{36}", path.name):
        raise ValueError("Refusing to remove an unowned artifact directory")
    if path.exists():
        # Validate descendants too: a replaced junction must never redirect GC.
        for child in path.rglob("*"):
            reject_links(child)
            if not child.resolve().is_relative_to(path.resolve()):
                raise ValueError("Artifact descendant escaped its private directory")
        shutil.rmtree(path)


def backup_file_entries(runtime, conn):
    entries, seen = [], set()
    for row in conn.execute("SELECT * FROM attachments WHERE quota_bytes>0"):
        keys = [row["preview_key"], row["thumbnail_key"], row["storage_key"]]
        for key in keys:
            if not key or key in seen:
                continue
            path = runtime.files.path(key)
            if not path.is_file():
                required = row["state"] in ("ready", "processing", "quarantined") and not (
                    key == row["storage_key"]
                    and row["purpose"] != "message"
                    and row["state"] == "ready"
                )
                if required:
                    raise artifact_error(
                        "备份需要的附件缺失，请先核对文件健康状态。", "FILE_MISSING"
                    )
                continue
            seen.add(key)
            entry = {"name": "files/" + key, "path": path, "bytes": path.stat().st_size}
            if key == row["storage_key"] and row["state"] in ("ready", "processing", "quarantined"):
                entry["expectedSha256"] = row["expected_sha256"]
            entries.append(entry)
            if len(entries) > MAX_FILES:
                raise artifact_error("备份文件数量超过当前有界任务预算。", "BACKUP_LIMIT")
    return entries


def write_archive(
    runtime, output, kind, operation_id, entries, check, progress, max_bytes, *, extra=None
):
    total, manifest_rows = 0, []
    if output.exists():
        raise artifact_error("任务临时归档已存在。")
    with zipfile.ZipFile(
        output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True
    ) as archive:
        for ordinal, entry in enumerate(entries, 1):
            check()
            path, name = entry["path"], entry["name"]
            reject_links(path)
            digest, size = hashlib.sha256(), 0
            with (
                path.open("rb") as source,
                archive.open(name, "w", force_zip64=True) as destination,
            ):
                while block := source.read(CHUNK):
                    check()
                    size += len(block)
                    total += len(block)
                    if total > max_bytes:
                        raise artifact_error(
                            "实际归档内容超过预览预算，未发布部分归档。", "ARTIFACT_LIMIT"
                        )
                    destination.write(block)
                    digest.update(block)
            if entry.get("expectedSha256") and not hmac.compare_digest(
                digest.hexdigest(), entry["expectedSha256"]
            ):
                raise artifact_error(
                    "原始文件与已验证的上传校验值不一致。", "FILE_INTEGRITY_FAILED"
                )
            manifest_rows.append({"name": name, "bytes": size, "sha256": digest.hexdigest()})
            progress(ordinal, len(entries), total)
        manifest = {
            "format": 1,
            "kind": kind,
            "operationId": operation_id,
            "createdAt": now_ms(),
            "applicationVersion": __version__,
            "files": manifest_rows,
            **(extra or {}),
        }
        signature = runtime.auth.security.digest(compact(manifest), "artifact-manifest")
        archive.writestr("manifest.json", compact({"manifest": manifest, "signature": signature}))
    check()
    if output.stat().st_size > max_bytes:
        raise artifact_error("归档及清单超过允许大小。", "ARTIFACT_LIMIT")
    return {
        "sha256": checksum(output, check),
        "bytes": output.stat().st_size,
        "files": len(entries),
        "manifest": manifest,
    }


def read_verified_manifest(runtime, archive_path, expected_sha, check):
    if not expected_sha or not hmac.compare_digest(checksum(archive_path, check), expected_sha):
        raise artifact_error("归档整体校验值不一致。")
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_FILES + 2 or len({row.filename for row in infos}) != len(infos):
            raise artifact_error("归档文件数量或重名检查失败。")
        manifest_info = archive.getinfo("manifest.json")
        if manifest_info.file_size > 32 * CHUNK:
            raise artifact_error("归档清单超出预算。")
        envelope = json.loads(archive.read(manifest_info))
        manifest = envelope["manifest"]
        signature = runtime.auth.security.digest(compact(manifest), "artifact-manifest")
        if (
            not hmac.compare_digest(signature, envelope["signature"])
            or manifest["format"] != 1
            or manifest["kind"] != "backup"
        ):
            raise artifact_error("清单签名或备份格式无效，请核对原实例密钥。")
        expected = {row["name"]: row for row in manifest["files"]}
        if (
            len(expected) != len(manifest["files"])
            or set(expected) != {row.filename for row in infos} - {"manifest.json"}
            or "database.sqlite3" not in expected
        ):
            raise artifact_error("归档条目与签名清单不一致。")
        total = 0
        for info in infos:
            if info.filename == "manifest.json":
                continue
            if info.filename != "database.sqlite3" and not re.fullmatch(
                r"files/[a-z0-9_.-]{1,200}", info.filename
            ):
                raise artifact_error("备份包含不允许的目录。")
            if (
                ".." in info.filename
                or stat.S_ISLNK(info.external_attr >> 16)
                or info.flag_bits & 1
            ):
                raise artifact_error("备份包含不允许的链接或加密条目。")
            row = expected[info.filename]
            if type(row["bytes"]) is not int or row["bytes"] < 0 or info.file_size != row["bytes"]:
                raise artifact_error("备份文件大小不一致。")
            total += row["bytes"]
            if total > MAX_BACKUP_BYTES:
                raise artifact_error("解包大小超过任务预算。")
            digest, size = hashlib.sha256(), 0
            with archive.open(info) as source:
                while block := source.read(CHUNK):
                    check()
                    size += len(block)
                    digest.update(block)
            if size != row["bytes"] or not hmac.compare_digest(digest.hexdigest(), row["sha256"]):
                raise artifact_error("附件或数据库逐文件校验失败。")
    return manifest


def extract_entry(archive, name, destination, check):
    reject_links(destination)
    if destination.exists():
        raise artifact_error("恢复目标文件必须不存在。")
    with archive.open(name) as source, destination.open("xb") as target:
        while block := source.read(CHUNK):
            check()
            target.write(block)


def verify_database(runtime, path):
    conn = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    try:
        if (
            conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
            or conn.execute("PRAGMA foreign_key_check").fetchall()
        ):
            raise artifact_error("恢复数据库的完整性或外键检查失败。")
        versions = dict(conn.execute("SELECT version,checksum FROM schema_migrations"))
        known = {
            int(p.name.split("_")[0]): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in runtime.db.migrations.glob("[0-9]*.sql")
        }
        if not versions or any(
            known.get(version) != digest for version, digest in versions.items()
        ):
            raise artifact_error("备份迁移版本与当前应用不兼容。", "BACKUP_VERSION")
        return {"schemaVersion": max(versions), "integrity": "ok", "foreignKeyViolations": 0}
    finally:
        conn.close()
