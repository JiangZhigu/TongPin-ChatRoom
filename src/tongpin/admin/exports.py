from __future__ import annotations

import json

from pydantic import ValidationError

from tongpin.admin.artifacts import artifact_error
from tongpin.admin.audit import audit_filters
from tongpin.admin.authz import fingerprint
from tongpin.admin.sensitive import like_query, query_budget, search_terms
from tongpin.contracts.admin_s2 import ContentSearch, FileSearch
from tongpin.contracts.admin_s3 import AuditFilters, ExportParameters
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


class ExportsAdmin:
    def export_selection(self, conn, parameters):
        data = ExportParameters.model_validate(parameters)
        if (
            any(key in data.filters for key in ("reason", "after", "limit"))
            or data.kind == "audit"
            and data.includeFiles
        ):
            raise APIError("VALIDATION_ERROR", "导出筛选或附件选项与所选种类不匹配。", 422)
        try:
            if data.kind == "audit":
                query = AuditFilters.model_validate(data.filters)
                conditions, args = audit_filters(query)
                source, select = "audit_events", "*"
                order = "id DESC"
            else:
                query = (ContentSearch if data.kind == "content" else FileSearch).model_validate(
                    {"reason": "受控导出", **data.filters}
                )
                alias = "m" if data.kind == "content" else "a"
                conditions, args = search_terms(query, alias)
                pairs = (
                    [
                        ("m.sender_id", query.senderId),
                        ("m.status", query.status),
                        ("c.kind", query.kind),
                    ]
                    if data.kind == "content"
                    else [
                        ("a.owner_id", query.ownerId),
                        ("a.state", query.state),
                        ("a.governance", query.governance),
                        ("a.kind", query.kind),
                    ]
                )
                for column, value in pairs:
                    if value:
                        conditions.append(column + "=?")
                        args.append(value)
                if query.query:
                    conditions.append(
                        ("m.text" if data.kind == "content" else "a.name") + " LIKE ? ESCAPE '!'"
                    )
                    args.append(like_query(query.query))
                    if data.kind == "content":
                        conditions.append(
                            "(m.status='sent' OR (m.status IN('recalled','moderated') AND m.removed_at>?))"
                        )
                        args.append(
                            now_ms()
                            - self.runtime.policy.get(conn)["deleted_content_days"] * 86400000
                        )
                source = (
                    "messages m JOIN conversations c ON c.id=m.conversation_id"
                    if data.kind == "content"
                    else "attachments a"
                )
                select, order = alias + ".*", alias + ".created_at DESC," + alias + ".id DESC"
        except ValidationError as error:
            raise APIError("VALIDATION_ERROR", "导出筛选字段或格式不受支持。", 422) from error
        where = " AND ".join(conditions) or "1=1"
        with query_budget(conn):
            total = conn.execute(
                "SELECT COUNT(*) FROM " + source + " WHERE " + where, args
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT "
                + select
                + " FROM "
                + source
                + " WHERE "
                + where
                + " ORDER BY "
                + order
                + " LIMIT ?",
                [*args, data.maxRows],
            ).fetchall()
            selection, estimated, file_keys = [], 0, set()
            for row in rows:
                record, files = self.export_record(conn, data, row)
                encoded = json.dumps(record, ensure_ascii=False).encode()
                estimated += len(encoded) + 1
                for entry in files:
                    if entry["name"] not in file_keys:
                        file_keys.add(entry["name"])
                        estimated += entry["bytes"]
                selection.append({"id": row["id"], "fingerprint": fingerprint(record)})
        if not selection:
            raise APIError("EXPORT_EMPTY", "当前筛选没有可导出的记录。", 422)
        # Include a bounded manifest/ZIP overhead in the displayed budget.
        estimated += 1024 + len(selection) * 200 + len(file_keys) * 300
        if estimated > data.maxBytes:
            raise APIError(
                "EXPORT_LIMIT", "本次选中内容超过大小预算，请缩小条数、范围或取消附件。", 422
            )
        return {
            "items": selection,
            "totalMatches": total,
            "estimatedBytes": estimated,
            "fileCount": len(file_keys),
            "retentionDays": self.runtime.policy.get(conn)["deleted_content_days"],
        }

    def export_record(self, conn, data, row):
        files = []
        if data.kind == "audit":
            return self.audit_view(conn, row), files
        if data.kind == "content":
            record = self.content_view(conn, row)
            for attachment in record["attachments"]:
                attachment.pop("cleanupReason", None)
            attachments = (
                conn.execute(
                    "SELECT * FROM attachments WHERE message_id=? ORDER BY message_position",
                    (row["id"],),
                ).fetchall()
                if data.includeFiles and record["retained"]
                else []
            )
        else:
            record = self.file_view(conn, row)
            record.pop("cleanupReason", None)
            attachments = [row] if data.includeFiles else []
        for attachment in attachments:
            if not self.file_content_allowed(conn, attachment):
                raise artifact_error(
                    "选中附件当前不允许导出内容，请检查扫描与保留状态或取消附件。",
                    "FILE_UNAVAILABLE",
                )
            keys = [attachment["storage_key"]] if attachment["purpose"] == "message" else []
            keys += [attachment["preview_key"], attachment["thumbnail_key"]]
            for key in set(keys) - {None, ""}:
                path = self.runtime.files.path(key)
                if not path.is_file():
                    raise artifact_error("选中附件原件或预览缺失，导出已停止。", "FILE_MISSING")
                entry = {"name": "files/" + key, "path": path, "bytes": path.stat().st_size}
                if key == attachment["storage_key"]:
                    entry["expectedSha256"] = attachment["expected_sha256"]
                files.append(entry)
        return record, files

    def export_entries(self, conn, parameters, selection, destination, check, progress):
        data = ExportParameters.model_validate(parameters)
        table = {"content": "messages", "files": "attachments", "audit": "audit_events"}[data.kind]
        entries, seen = [], set()
        records = destination / "records.jsonl"
        with records.open("xb") as stream:
            for ordinal, selected in enumerate(selection, 1):
                check()
                row = conn.execute(
                    "SELECT * FROM " + table + " WHERE id=?", (selected["id"],)
                ).fetchone()
                if not row:
                    raise artifact_error(
                        "导出期间目标已清理，请重新预览当前范围。", "EXPORT_CHANGED"
                    )
                record, files = self.export_record(conn, data, row)
                if fingerprint(record) != selected["fingerprint"]:
                    raise artifact_error(
                        "导出期间内容或文件权限已变化，请重新预览。", "EXPORT_CHANGED"
                    )
                stream.write(json.dumps(record, ensure_ascii=False).encode() + b"\n")
                for entry in files:
                    if entry["name"] not in seen:
                        seen.add(entry["name"])
                        entries.append(entry)
                progress(ordinal, len(selection), stream.tell())
        return [
            {"name": "records.jsonl", "path": records, "bytes": records.stat().st_size},
            *entries,
        ]

    def revalidate_export(self, conn, parameters, selection):
        data = ExportParameters.model_validate(parameters)
        table = {"content": "messages", "files": "attachments", "audit": "audit_events"}[data.kind]
        with query_budget(conn):
            for selected in selection:
                row = conn.execute(
                    "SELECT * FROM " + table + " WHERE id=?", (selected["id"],)
                ).fetchone()
                if not row:
                    raise artifact_error("导出目标已清理，请重新预览。", "EXPORT_CHANGED")
                record, _ = self.export_record(conn, data, row)
                if fingerprint(record) != selected["fingerprint"]:
                    raise artifact_error("导出目标内容或权限已变化，请重新预览。", "EXPORT_CHANGED")
