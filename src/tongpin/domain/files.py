from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
from itertools import islice

from tongpin.contracts.base import APIError
from tongpin.domain.auth import public_user
from tongpin.domain.chat import activity_cursor, next_activity
from tongpin.domain.security import audit, identifier
from tongpin.infra.db import now_ms
from tongpin.infra.file_validation import (
    MIMES,
    digest_file,
    filename,
    image_versions,
    validate_document,
)
from tongpin.infra.scanner import ClamdScanner

DAY = 86400000
ERRORS = {
    "SCANNER_DISABLED": "文件尚未经过恶意软件扫描，当前保持隔离；可取消或在扫描服务可用后重试。",
    "SCANNER_UNAVAILABLE": "扫描服务暂不可用，文件仍在隔离中。",
    "SCANNER_INVALID_RESULT": "扫描结果无法确认，文件仍在隔离中。",
    "FILE_INFECTED": "扫描发现风险，已拒绝此文件。",
    "FILE_SIZE_MISMATCH": "实际上传大小与申请不符，请重新选择文件。",
    "FILE_HASH_MISMATCH": "上传字节校验不符，请重新选择文件。",
    "FILE_CANCELLED": "上传已取消。",
    "UPLOAD_EXPIRED": "未发送附件已过期，请重新选择文件。",
    "FILE_TYPE_MISMATCH": "文件类型或内容校验失败，请重新导出后选择。",
    "IMAGE_INVALID": "图片无法完成解码校验，请重新导出。",
    "IMAGE_LIMIT": "图片尺寸、帧数或解码预算超出限制。",
    "ARCHIVE_LIMIT": "压缩容器的目录、条目或声明大小超出限制。",
    "ARCHIVE_PATH": "压缩容器中含不允许的路径。",
    "FILE_ENCODING": "文本文件不是有效的UTF-8编码。",
    "FILE_PROCESSING_FAILED": "文件校验暂时失败，请保留本机副本。",
}


class FileService:
    def __init__(self, runtime):
        self.runtime = runtime
        self.scanner = ClamdScanner(
            runtime.settings.scanner_host, runtime.settings.scanner_port, runtime.settings.scanner_timeout
        )
        self.storage_lock = threading.RLock()

    def initialize(self):
        with self.runtime.db.write() as conn:
            # An interrupted body can safely be replayed with the same ID and
            # expected digest. Committed processing jobs already survive restart.
            conn.execute("UPDATE attachments SET state='reserved',lease_token=NULL,lease_until=NULL WHERE state='uploading'")
            self.schedule_cleanup(conn)

    def schedule_cleanup(self, conn, delay=3600000):
        pending = conn.execute("SELECT id,run_after FROM jobs WHERE kind='files.cleanup' AND status='pending' ORDER BY run_after LIMIT 1").fetchone()
        if pending and pending["run_after"] > now_ms() + delay:
            conn.execute("UPDATE jobs SET run_after=? WHERE id=?", (now_ms() + delay, pending["id"]))
        elif not pending:
            self.runtime.jobs.enqueue_in_transaction(conn, "files.cleanup", run_after=now_ms() + delay)

    @staticmethod
    def row(conn, fid):
        row = conn.execute("SELECT * FROM attachments WHERE id=?", (fid,)).fetchone()
        if not row:
            raise APIError("RESOURCE_UNAVAILABLE", "附件不存在或无法访问。", 404)
        return row

    def path(self, key, *, temporary=False):
        return self.runtime.paths.private_file(self.runtime.paths.temporary if temporary else self.runtime.paths.uploads, key)

    def scope(self, conn, actor, purpose, cid, access_key, *, write=True):
        actor = self.runtime.auth.current_in_transaction(conn, actor)
        if write and actor.user['upload_disabled']:
            raise APIError('UPLOAD_DISABLED', '账号当前不能上传文件。' + (actor.user['restriction_reason'] or ''), 403)
        if purpose == "user_avatar":
            if write and self.runtime.policy.get(conn)["maintenance"]:
                raise APIError("MAINTENANCE", "维护期间暂不能上传头像。", 503)
        else:
            if purpose == "group_avatar" and write:
                meta = self.runtime.groups.meta(conn, actor, cid, manage=True, active=True)
            else:
                meta = self.runtime.access.conversation(conn, actor.id, cid, write=write)
            if meta["accessKey"] != access_key:
                raise APIError("STALE_ACCESS", "会话权限已改变，请重新选择附件。", 409)
        return actor

    def disk_guard(self, conn, extra=0):
        disk = self.runtime.paths.disk_state()
        reserved = conn.execute("SELECT COALESCE(SUM(quota_bytes),0) FROM attachments WHERE state IN ('reserved','uploading')").fetchone()[0]
        # Account for bounded request spools and atomic-write temporary copies.
        required = (reserved + extra) * 2 + 8 * 1024**2
        if (disk["totalBytes"] - disk["freeBytes"] + required) * 100 >= disk["totalBytes"] * self.runtime.policy.get(conn)["disk_high_watermark"] or disk["freeBytes"] - required < 64 * 1024**2:
            raise APIError("DISK_HIGH_WATERMARK", "服务端可用空间不足，暂不能上传新附件。", 507)

    def policy(self, actor):
        with self.runtime.db.read() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            policy = self.runtime.policy.get(conn)
            reserved, total = conn.execute("SELECT COALESCE(SUM(CASE WHEN state IN ('reserved','uploading') THEN quota_bytes ELSE 0 END),0),COALESCE(SUM(quota_bytes),0) FROM attachments WHERE owner_id=?", (actor.id,)).fetchone()
            return {"imageLimit": policy["image_limit_bytes"], "fileLimit": policy["file_limit_bytes"], "attachmentCount": policy["attachment_count"], "messageBytes": policy["message_attachment_bytes"], "userQuota": actor.user['quota_bytes'] if actor.user['quota_bytes'] is not None else policy["user_quota_bytes"], "usedBytes": total - reserved, "reservedBytes": reserved, "uploadAllowed": not bool(actor.user['upload_disabled']), "uploadReason": actor.user['restriction_reason'] if actor.user['upload_disabled'] else '', "supportedExtensions": sorted(MIMES), "scanPolicy": "closed-test-unscanned" if self.runtime.settings.allow_unscanned_files else "strict", "scanner": "configured" if self.scanner.port else "disabled"}

    def metadata(self, row):
        restricted = row["governance"] != "available"
        ready = row["state"] == "ready" and not restricted
        image = ready and row["kind"] == "image"
        root = "/api/v1/attachments/" + row["id"]
        view = {
            "id": row["id"], "name": row["name"], "size": row["size"] or row["expected_size"], "mime": row["mime"], "kind": row["kind"],
            "purpose": row["purpose"], "conversationId": row["conversation_id"], "state": row["state"], "scanStatus": row["scan_status"],
            "errorCode": row["error_code"], "error": ERRORS.get(row["error_code"], "文件无法使用，请重新选择。") if row["error_code"] else None,
            "createdAt": row["created_at"], "expiresAt": row["expires_at"], "bound": bool(row["message_id"] or row["avatar_bound"]),
            "contentUrl": root + "/content" if ready and row["purpose"] == "message" else "",
        }
        if image:
            view.update(previewUrl=root + "/preview", thumbnailUrl=root + "/thumbnail", width=row["width"], height=row["height"], frameCount=row["frame_count"])
        if restricted:
            view.update(state="quarantined", errorCode="FILE_RESTRICTED", error="此文件已限制访问：" + row["governance_reason"])
        return view

    def reserve(self, actor, data):
        self.runtime.auth.security.rate("file-reserve", actor.id, 120, 3600)
        ext, kind, mime = filename(data.name, data.mime)
        payload_hash = hashlib.sha256(json.dumps(data.model_dump(exclude={"clientUploadId"}), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.runtime.db.write() as conn:
            actor = self.scope(conn, actor, data.purpose, data.conversationId, data.accessKey)
            if data.actorContext != actor.id:
                raise APIError("AUTH_REQUIRED", "浏览器账号已改变，请重新连接。", 401)
            previous = conn.execute("SELECT * FROM attachments WHERE owner_id=? AND client_upload_id=?", (actor.id, data.clientUploadId)).fetchone()
            if previous:
                if previous["payload_hash"] != payload_hash:
                    raise APIError("IDEMPOTENCY_CONFLICT", "上传标识已用于其他文件，请重新选择。", 409)
                return self.metadata(previous)
            policy = self.runtime.policy.get(conn)
            if data.size > policy["image_limit_bytes" if kind == "image" else "file_limit_bytes"]:
                raise APIError("PAYLOAD_TOO_LARGE", "文件超过当前单件上传限制。", 413)
            if data.purpose != "message" and kind != "image":
                raise APIError("FILE_TYPE_UNSUPPORTED", "头像只能使用支持的图片。", 422)
            total, active = conn.execute("SELECT COALESCE(SUM(quota_bytes),0),COALESCE(SUM(state IN ('reserved','uploading','processing')),0) FROM attachments WHERE owner_id=?", (actor.id,)).fetchone()
            quota = actor.user['quota_bytes'] if actor.user['quota_bytes'] is not None else policy["user_quota_bytes"]
            if total + data.size > quota:
                raise APIError("USER_QUOTA_EXCEEDED", "本人附件空间不足，请先处理不需要的未发送附件。", 507)
            if active >= 12:
                raise APIError("UPLOAD_BUSY", "待处理附件过多，请等待或取消部分上传。", 429, retry_after_ms=3000)
            self.disk_guard(conn, data.size)
            fid, stamp = identifier("f_"), now_ms()
            storage_key = secrets.token_hex(24) + ".bin"
            conn.execute("INSERT INTO attachments(id,owner_id,client_upload_id,payload_hash,conversation_id,access_key,purpose,name,extension,kind,mime,expected_size,expected_sha256,quota_bytes,state,storage_key,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?)", (fid, actor.id, data.clientUploadId, payload_hash, data.conversationId, data.accessKey, data.purpose, data.name, ext, kind, mime, data.size, data.sha256, data.size, storage_key, stamp, stamp, stamp + DAY))
            return self.metadata(self.row(conn, fid))

    def guard_upload(self, actor, fid):
        with self.runtime.db.read() as conn:
            return self.guard_upload_in(conn, actor, fid)

    def guard_upload_in(self, conn, actor, fid):
        row = self.row(conn, fid)
        if row["owner_id"] != actor.id:
            raise APIError("RESOURCE_UNAVAILABLE", "这份上传不属于当前账号。", 404)
        self.scope(conn, actor, row["purpose"], row["conversation_id"], row["access_key"])
        if row["governance"] != "available":
            raise APIError("FILE_RESTRICTED", "此上传已由管理员限制。", 403)
        if row["state"] not in {"reserved", "uploading", "processing", "ready", "quarantined"} or row["expires_at"] <= now_ms() and not (row["message_id"] or row["avatar_bound"]):
            raise APIError("UPLOAD_EXPIRED", "上传已结束或过期，请重新选择。", 409)
        if row["state"] == "uploading" and (row["lease_until"] or 0) > now_ms():
            raise APIError("UPLOAD_BUSY", "同一附件正在接收中，请稍后确认结果。", 409, retry_after_ms=1000)
        self.disk_guard(conn)
        return row["expected_size"]

    def receive(self, actor, fid, stream):
        lease = secrets.token_hex(24)
        with self.runtime.db.write() as conn:
            self.guard_upload_in(conn, actor, fid)
            row = self.row(conn, fid)
            if row["state"] in {"processing", "ready", "quarantined"}:
                return self.metadata(row)
            conn.execute("UPDATE attachments SET state='uploading',lease_token=?,lease_until=?,updated_at=? WHERE id=?", (lease, now_ms() + 150000, now_ms(), fid))
        temporary = self.path("upload-" + secrets.token_hex(24) + ".part", temporary=True)
        try:
            size, digest = 0, hashlib.sha256()
            with temporary.open("xb") as destination:
                while chunk := stream.read(65536):
                    size += len(chunk)
                    if size > row["expected_size"]:
                        raise APIError("FILE_SIZE_MISMATCH", ERRORS["FILE_SIZE_MISMATCH"], 413)
                    digest.update(chunk)
                    destination.write(chunk)
                destination.flush()
                os.fsync(destination.fileno())
            if size != row["expected_size"]:
                raise APIError("FILE_SIZE_MISMATCH", ERRORS["FILE_SIZE_MISMATCH"], 422)
            if digest.hexdigest() != row["expected_sha256"]:
                raise APIError("FILE_HASH_MISMATCH", ERRORS["FILE_HASH_MISMATCH"], 422)
            with self.storage_lock, self.runtime.db.write() as conn:
                current = self.row(conn, fid)
                self.scope(conn, actor, row["purpose"], row["conversation_id"], row["access_key"])
                if current["state"] != "uploading" or current["lease_token"] != lease:
                    raise APIError("FILE_CANCELLED", "上传已取消或由新请求接管。", 409)
                os.replace(temporary, self.path(row["storage_key"]))
                conn.execute("UPDATE attachments SET state='processing',size=?,lease_token=NULL,lease_until=NULL,updated_at=?,error_code=NULL WHERE id=?", (size, now_ms(), fid))
                self.runtime.jobs.enqueue_in_transaction(conn, "files.process", {"attachmentId": fid}, entity_id=fid)
                return self.metadata(self.row(conn, fid))
        except APIError as error:
            with self.runtime.db.write() as conn:
                conn.execute("UPDATE attachments SET state='rejected',error_code=?,lease_token=NULL,lease_until=NULL,expires_at=? WHERE id=? AND state='uploading' AND lease_token=?", (error.code, now_ms(), fid, lease))
                self.schedule_cleanup(conn, 0)
            raise
        except OSError as error:
            with self.runtime.db.write() as conn:
                conn.execute("UPDATE attachments SET state='reserved',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?", (fid, lease))
            raise APIError("STORAGE_UNAVAILABLE", "服务端无法保存文件，请保留本机副本并稍后重试。", 503) from error
        finally:
            temporary.unlink(missing_ok=True)

    def authorize(self, conn, actor, row):
        self.runtime.auth.current_in_transaction(conn, actor)
        if row["message_id"]:
            message, _ = self.runtime.access.message(conn, actor.id, row["message_id"])
            if message["status"] != "sent":
                raise APIError("RESOURCE_UNAVAILABLE", "这条消息的附件已无法访问。", 404)
        elif row["avatar_bound"]:
            if row["purpose"] == "group_avatar":
                meta = self.runtime.access.conversation(conn, actor.id, row["conversation_id"])
                if meta["row"]["avatar_id"] != row["id"]:
                    raise APIError("RESOURCE_UNAVAILABLE", "头像已更新。", 404)
            else:
                user = conn.execute("SELECT avatar_id,status FROM users WHERE id=?", (row["owner_id"],)).fetchone()
                if user["avatar_id"] != row["id"] or user["status"] != "active":
                    raise APIError("RESOURCE_UNAVAILABLE", "头像已无法访问。", 404)
        elif row["owner_id"] == actor.id:
            self.scope(conn, actor, row["purpose"], row["conversation_id"], row["access_key"], write=False)
        else:
            raise APIError("RESOURCE_UNAVAILABLE", "附件不存在或无法访问。", 404)

    def get(self, actor, fid):
        with self.runtime.db.read() as conn:
            row = self.row(conn, fid)
            self.authorize(conn, actor, row)
            return self.metadata(row)

    def content(self, actor, fid, variant):
        with self.runtime.db.read() as conn:
            row = self.row(conn, fid)
            self.authorize(conn, actor, row)
            if row["governance"] != "available":
                raise APIError("FILE_RESTRICTED", "此文件已限制访问：" + row["governance_reason"], 403)
            if row["state"] != "ready" or not (row["message_id"] or row["avatar_bound"]) and row["expires_at"] <= now_ms():
                raise APIError("RESOURCE_UNAVAILABLE", "附件还未就绪或已无法访问。", 404)
            key = row["storage_key"] if variant == "content" else row[variant + "_key"]
            if variant == "content" and row["purpose"] != "message" or not key:
                raise APIError("RESOURCE_UNAVAILABLE", "此附件不提供该访问方式。", 404)
            path = self.path(key)
            if not path.is_file():
                raise APIError("RESOURCE_UNAVAILABLE", "附件文件暂不可用。", 404)
            return path, row["mime"] if variant == "content" else "image/webp", row["name"]

    def cancel(self, actor, fid):
        with self.runtime.db.write() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            row = self.row(conn, fid)
            if row["owner_id"] != actor.id:
                raise APIError("RESOURCE_UNAVAILABLE", "上传不存在或不可管理。", 404)
            if row["message_id"] or row["avatar_bound"]:
                raise APIError("FILE_IN_USE", "附件已被消息或头像使用，不能按未发送附件取消。", 409)
            conn.execute("UPDATE attachments SET state='cancelled',error_code='FILE_CANCELLED',expires_at=?,updated_at=? WHERE id=?", (now_ms(), now_ms(), fid))
            self.schedule_cleanup(conn, 0)
            return self.metadata(self.row(conn, fid))

    def retry(self, actor, fid):
        self.runtime.auth.security.rate("file-retry", actor.id, 30, 3600)
        with self.runtime.db.write() as conn:
            row = self.row(conn, fid)
            if row["owner_id"] != actor.id or row["message_id"] or row["avatar_bound"]:
                raise APIError("RESOURCE_UNAVAILABLE", "此附件无法重新校验。", 404)
            self.scope(conn, actor, row["purpose"], row["conversation_id"], row["access_key"])
            if row["state"] == "quarantined" and row["expires_at"] > now_ms():
                if row["governance"] != "available":
                    raise APIError("FILE_RESTRICTED", "此文件的管理限制尚未解除。", 403)
                conn.execute("UPDATE attachments SET state='processing',error_code=NULL,updated_at=? WHERE id=?", (now_ms(), fid))
                self.runtime.jobs.enqueue_in_transaction(conn, "files.process", {"attachmentId": fid}, entity_id=fid)
            return self.metadata(self.row(conn, fid))

    def _write_derived(self, data, key):
        temporary = self.path("upload-" + secrets.token_hex(24) + ".part", temporary=True)
        try:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path(key))
            return key
        finally:
            temporary.unlink(missing_ok=True)

    def process(self, job):
        fid = job["payload"]["attachmentId"]
        with self.runtime.db.read() as conn:
            row = self.row(conn, fid)
            if row["state"] != "processing":
                return {"state": row["state"]}
        source = self.path(row["storage_key"])
        derived = []
        try:
            size, digest = digest_file(source)
            if size != row["expected_size"]:
                raise APIError("FILE_SIZE_MISMATCH", ERRORS["FILE_SIZE_MISMATCH"], 422)
            if digest != row["expected_sha256"]:
                raise APIError("FILE_HASH_MISMATCH", ERRORS["FILE_HASH_MISMATCH"], 422)
            info = image_versions(source, row["extension"], row["purpose"] != "message") if row["kind"] == "image" else None
            if info is None:
                validate_document(source, row["extension"])
            scan = self.scanner.scan(source, row["expected_size"])
            scan_status, error = scan.status, scan.code
            if scan.status == "infected":
                state = "rejected"
            elif scan.status == "clean":
                state, error = "ready", None
            elif row["kind"] == "image" or self.runtime.settings.allow_unscanned_files:
                state, scan_status, error = "ready", "not_scanned" if not self.scanner.port else "unknown", None
            else:
                state = "quarantined"
            with self.storage_lock, self.runtime.db.write() as conn:
                current = self.row(conn, fid)
                if current["state"] != "processing":
                    return {"state": current["state"]}
                if state == "ready" and info:
                    derived.append(self._write_derived(info["preview"], row["storage_key"] + ".preview.webp"))
                    derived.append(self._write_derived(info["thumbnail"], row["storage_key"] + ".thumbnail.webp"))
                conn.execute("UPDATE attachments SET state=?,scan_status=?,error_code=?,preview_key=?,thumbnail_key=?,width=?,height=?,frame_count=?,updated_at=? WHERE id=?", (state, scan_status, error, derived[0] if derived else None, derived[1] if derived else None, info["width"] if info else None, info["height"] if info else None, info["frame_count"] if info else None, now_ms(), fid))
                if state == "rejected":
                    conn.execute("UPDATE attachments SET expires_at=? WHERE id=?", (now_ms(), fid))
                    self.schedule_cleanup(conn, 0)
                audit(conn, row["owner_id"], "file.validation", fid, details={"state": state, "scanStatus": scan_status, "code": error})
                derived = []
            if state == "ready" and row["purpose"] != "message":
                # Only remove the original after the ready metadata commits.
                # A filesystem failure is retried by cleanup; it is never served.
                try:
                    source.unlink(missing_ok=True)
                except OSError:
                    pass
            return {"state": state}
        except Exception as error:  # noqa: BLE001 -- Persist a terminal state instead of leaving a failed durable job spinning in processing.
            code = error.code if isinstance(error, APIError) else "FILE_PROCESSING_FAILED"
            with self.runtime.db.write() as conn:
                conn.execute("UPDATE attachments SET state='rejected',error_code=?,updated_at=?,expires_at=? WHERE id=? AND state='processing'", (code, now_ms(), now_ms(), fid))
                self.schedule_cleanup(conn, 0)
            return {"state": "rejected", "code": code}
        finally:
            for key in derived:
                self.path(key).unlink(missing_ok=True)

    def validate_for_message(self, conn, actor, cid, ids):
        policy = self.runtime.policy.get(conn)
        if len(ids) > policy["attachment_count"]:
            raise APIError("PAYLOAD_TOO_LARGE", "每条消息的附件数量超限。", 413)
        total = 0
        for fid in ids:
            row = self.row(conn, fid)
            if row["owner_id"] != actor.id or row["conversation_id"] != cid or row["purpose"] != "message" or row["message_id"] or row["avatar_bound"]:
                raise APIError("RESOURCE_UNAVAILABLE", "附件不属于当前消息或已被使用。", 404)
            self.scope(conn, actor, row["purpose"], cid, row["access_key"])
            if row["state"] != "ready" or row["expires_at"] <= now_ms() or row["governance"] != "available":
                raise APIError("FILE_NOT_READY", "附件尚未就绪或已过期，未发送此消息。", 409)
            total += row["size"]
        if total > policy["message_attachment_bytes"]:
            raise APIError("PAYLOAD_TOO_LARGE", "本条消息附件合计超过限制。", 413)

    def bind_message(self, conn, actor, mid, ids):
        for order, fid in enumerate(ids):
            conn.execute("UPDATE attachments SET message_id=?,message_position=? WHERE id=? AND owner_id=? AND message_id IS NULL", (mid, order, fid, actor.id))

    def message_attachments(self, conn, actor_id, message):
        if message["status"] != "sent":
            return []
        self.runtime.access.message(conn, actor_id, message["id"])
        return [self.metadata(row) for row in conn.execute("SELECT * FROM attachments WHERE message_id=? AND state='ready' ORDER BY message_position", (message["id"],))]

    def list(self, actor, cid=None, kind=None, after="", limit=50):
        boundary, last_id = activity_cursor(after)
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            if cid:
                self.runtime.access.conversation(conn, actor.id, cid)
            if kind not in {None, "image", "file"}:
                raise APIError("VALIDATION_ERROR", "附件筛选类型无效。", 422)
            rows = conn.execute("SELECT a.*,c.name AS group_name,c.kind AS conversation_kind,c.low_id,c.high_id FROM attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id LEFT JOIN memberships mp ON mp.conversation_id=c.id AND mp.user_id=? AND mp.left_at IS NULL WHERE a.state='ready' AND m.status='sent' AND c.status<>'dissolved' AND ((c.kind='direct' AND (c.low_id=? OR c.high_id=?)) OR (c.kind='group' AND mp.id IS NOT NULL AND m.seq>=mp.visible_from_seq)) AND (? IS NULL OR a.conversation_id=?) AND (? IS NULL OR a.kind=?) AND (?=0 OR a.created_at<? OR(a.created_at=? AND a.id<?)) ORDER BY a.created_at DESC,a.id DESC LIMIT ?", (actor.id, actor.id, actor.id, cid, cid, kind, kind, boundary, boundary, boundary, last_id, limit + 1)).fetchall()
            items = []
            for row in rows[:limit]:
                title = self.runtime.chat.conversation_view(conn, actor.id, row["conversation_id"])["title"]
                sender = conn.execute("SELECT nickname,status FROM users WHERE id=?", (row["owner_id"],)).fetchone()
                items.append(self.metadata(row) | {"conversationTitle": title, "messageId": row["message_id"], "senderName": "已注销用户" if sender["status"] == "deleted" else sender["nickname"]})
            return {"items": items, "nextCursor": next_activity(rows, limit)}

    def set_avatar(self, actor, fid, cid=None, expected_version=None):
        with self.runtime.db.write() as conn:
            actor = self.runtime.auth.current_in_transaction(conn, actor)
            if cid:
                meta = self.runtime.groups.meta(conn, actor, cid, manage=True, active=True)
                self.runtime.groups.version(meta, expected_version)
                old_id = meta["row"]["avatar_id"]
            else:
                old_id = actor.user["avatar_id"]
            if fid == old_id:
                return self.runtime.groups.detail_in(conn, actor, cid) if cid else {"user": public_user(actor.user)}
            if fid:
                row = self.row(conn, fid)
                if row["owner_id"] != actor.id or row["purpose"] != ("group_avatar" if cid else "user_avatar") or row["conversation_id"] != cid or row["state"] != "ready" or row["expires_at"] <= now_ms() or row["avatar_bound"] or row["governance"] != "available":
                    raise APIError("FILE_NOT_READY", "请先上传并校验属于当前用途的头像。", 409)
                self.scope(conn, actor, row["purpose"], cid, row["access_key"])
                conn.execute("UPDATE attachments SET avatar_bound=1 WHERE id=?", (fid,))
            if old_id:
                conn.execute("UPDATE attachments SET avatar_bound=0,state='cancelled',expires_at=? WHERE id=?", (now_ms(), old_id))
                self.schedule_cleanup(conn, 0)
            if cid:
                conn.execute("UPDATE conversations SET avatar_id=?,avatar_hidden=0,role_version=role_version+1,updated_at=? WHERE id=?", (fid, now_ms(), cid))
                self.runtime.groups.changed(conn, cid)
            else:
                conn.execute("UPDATE users SET avatar_id=?,avatar_hidden=0,updated_at=? WHERE id=?", (fid, now_ms(), actor.id))
                self.runtime.events.user_changed(conn, actor.id)
            audit(conn, actor.id, "group.avatar" if cid else "account.avatar", cid or actor.id)
            return self.runtime.groups.detail_in(conn, actor, cid) if cid else {"user": public_user(conn.execute("SELECT * FROM users WHERE id=?", (actor.id,)).fetchone())}

    def avatar(self, actor, uid=None, cid=None):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor)
            if cid:
                fid = self.runtime.access.conversation(conn, actor.id, cid)["row"]["avatar_id"]
            else:
                user = conn.execute("SELECT avatar_id,status FROM users WHERE id=?", (uid,)).fetchone()
                fid = user["avatar_id"] if user and user["status"] == "active" else None
            if not fid:
                raise APIError("RESOURCE_UNAVAILABLE", "尚未设置头像。", 404)
        return self.content(actor, fid, "preview")

    def cleanup(self, job=None):
        removed = 0
        with self.storage_lock, self.runtime.db.write() as conn:
            hold = conn.execute("SELECT value FROM instance_metadata WHERE key='backup_active'").fetchone()
            if hold and hold[0] == "1":
                self.schedule_cleanup(conn)
                return {"removed": 0, "heldByBackup": True}
            rows = conn.execute("SELECT * FROM attachments WHERE message_id IS NULL AND avatar_bound=0 AND expires_at<=? AND quota_bytes>0 ORDER BY expires_at LIMIT 100", (now_ms(),)).fetchall()
            for row in rows:
                if row["state"] == "uploading" and (row["lease_until"] or 0) > now_ms():
                    continue
                try:
                    for key in {row["storage_key"], row["preview_key"], row["thumbnail_key"], row["storage_key"] + ".preview.webp", row["storage_key"] + ".thumbnail.webp"}:
                        if key:
                            self.path(key).unlink(missing_ok=True)
                except OSError:
                    continue
                conn.execute("UPDATE attachments SET state=CASE WHEN state IN ('cancelled','rejected') THEN state ELSE 'expired' END,quota_bytes=0,lease_token=NULL,lease_until=NULL,error_code=CASE WHEN state IN ('cancelled','rejected') THEN error_code ELSE 'UPLOAD_EXPIRED' END WHERE id=?", (row["id"],))
                removed += 1
            for row in conn.execute("SELECT storage_key FROM attachments WHERE state='ready' AND purpose<>'message' LIMIT 100"):
                try:
                    self.path(row["storage_key"]).unlink(missing_ok=True)
                except OSError:
                    pass
            conn.execute("DELETE FROM attachments WHERE quota_bytes=0 AND message_id IS NULL AND avatar_bound=0 AND expires_at<?", (now_ms() - 8 * DAY,))
            self.schedule_cleanup(conn, 1000 if len(rows) >= 100 else 3600000)
        # Only application-created temporary names older than all upload leases.
        for path in islice(self.runtime.paths.temporary.glob("upload-*.part"), 100):
            checked = self.path(path.name, temporary=True)
            if now_ms() - int(checked.stat().st_mtime * 1000) > 600000:
                checked.unlink(missing_ok=True)
        return {"removed": removed}
