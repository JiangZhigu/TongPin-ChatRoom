from __future__ import annotations

from tongpin.admin.authz import conflict, cursor, identity, page, unavailable
from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms


class GroupsAdmin:
    def group_view(self, conn, row):
        count = conn.execute(
            "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
            (row["id"],),
        ).fetchone()[0]
        return {
            "id": row["id"],
            "name": row["name"],
            "description": row["description"],
            "owner": identity(conn, row["owner_id"]),
            "status": row["status"],
            "memberCount": count,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "roleVersion": row["role_version"],
            "lastSeq": str(row["last_seq"]),
            "everyoneMuted": bool(row["everyone_muted"]),
            "reviewRequired": bool(row["review_required"]),
            "inviteRole": row["invite_role"],
        }

    def groups_in(self, conn, *, query="", status="", owner="", after="", limit=50):
        if len(query) > 80 or status not in ("", "active", "frozen", "dissolved"):
            raise APIError("VALIDATION_ERROR", "群组筛选无效。", 422)
        clauses, args = ["kind='group'"], []
        if query:
            clauses.append("(instr(name,?)>0 OR id=?)")
            args += [query, query]
        if status:
            clauses.append("status=?")
            args.append(status)
        if owner:
            clauses.append("owner_id=?")
            args.append(owner)
        where = " AND ".join(clauses)
        total = conn.execute("SELECT COUNT(*) FROM conversations WHERE " + where, args).fetchone()[
            0
        ]
        marker = cursor(after)
        if marker:
            where += " AND id>?"
            args += marker
        rows = conn.execute(
            "SELECT * FROM conversations WHERE " + where + " ORDER BY id LIMIT ?",
            [*args, limit + 1],
        ).fetchall()
        return page(rows, total, limit, lambda row: self.group_view(conn, row))

    def groups(self, actor, **options):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            return self.groups_in(conn, **options)

    def group_items_in(self, conn, cid, kind, after="", limit=50):
        definitions = {
            "members": ("memberships", "left_at IS NULL"),
            "invites": ("group_invites", "1=1"),
            "applications": ("group_applications", "1=1"),
        }
        if kind not in definitions:
            raise unavailable()
        table, clause = definitions[kind]
        where, args = "conversation_id=? AND " + clause, [cid]
        total = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", args).fetchone()[0]
        marker = cursor(after)
        if marker:
            where += " AND id>?"
            args += marker
        rows = conn.execute(
            f"SELECT * FROM {table} WHERE {where} ORDER BY id LIMIT ?", [*args, limit + 1]
        ).fetchall()

        def convert(row):
            if kind == "members":
                return {
                    "id": row["id"],
                    "user": identity(conn, row["user_id"]),
                    "role": row["role"],
                    "joinedAt": row["joined_at"],
                    "visibleFromSeq": str(row["visible_from_seq"]),
                    "mutedUntil": row["muted_until"],
                    "writeVersion": row["write_version"],
                }
            if kind == "applications":
                return {
                    "id": row["id"],
                    "user": identity(conn, row["user_id"]),
                    "inviteId": row["invite_id"],
                    "status": row["status"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                    "expiresAt": row["expires_at"],
                }
            reserved = self.runtime.groups.invites.reserved(conn, cid, row["id"])
            status = (
                "revoked"
                if row["revoked_at"] is not None
                else "expired"
                if row["expires_at"] <= now_ms()
                else "exhausted"
                if row["used_count"] >= row["max_uses"]
                else "active"
            )
            return {
                "id": row["id"],
                "kind": row["kind"],
                "creator": identity(conn, row["creator_id"]),
                "target": identity(conn, row["target_id"]) if row["target_id"] else None,
                "maxUses": row["max_uses"],
                "used": row["used_count"],
                "reserved": reserved,
                "createdAt": row["created_at"],
                "expiresAt": row["expires_at"],
                "revokedAt": row["revoked_at"],
                "status": status,
            }

        return page(rows, total, limit, convert)

    def group_detail(self, actor, cid, *, kind=None, after="", limit=50):
        with self.runtime.db.read() as conn:
            self.runtime.auth.current_in_transaction(conn, actor, admin=True)
            row = conn.execute(
                "SELECT * FROM conversations WHERE id=? AND kind='group'", (cid,)
            ).fetchone()
            if not row:
                raise unavailable()
            if kind:
                return self.group_items_in(conn, cid, kind, after, limit)
            return {
                "group": self.group_view(conn, row),
                **{
                    name: self.group_items_in(conn, cid, name)
                    for name in ("members", "invites", "applications")
                },
            }

    def inspect_group(self, conn, action, target, parameters):
        member, invite = None, None
        cid = target
        if action.startswith("group.member."):
            member = conn.execute(
                "SELECT * FROM memberships WHERE id=? AND left_at IS NULL", (target,)
            ).fetchone()
            if not member:
                raise conflict("目标成员已离开或当前加入期已变化。")
            if member["role"] == "owner":
                raise conflict("请先使用群主纠正动作，不能直接移除或修改群主。")
            cid = member["conversation_id"]
        elif action == "group.invite.revoke":
            invite = conn.execute("SELECT * FROM group_invites WHERE id=?", (target,)).fetchone()
            if not invite:
                raise unavailable()
            if invite["revoked_at"] is not None:
                raise conflict("该邀请已被撤销。")
            cid = invite["conversation_id"]
        row = conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        if (
            not row
            or row["status"] == "dissolved"
            or action.startswith("group.")
            and row["kind"] != "group"
        ):
            raise unavailable()
        if (
            action == "conversation.freeze"
            and row["status"] != "active"
            or action == "conversation.unfreeze"
            and row["status"] != "frozen"
        ):
            raise conflict("会话冻结状态已变化。")
        snap = {key: row[key] for key in ("id", "status", "owner_id", "write_version")}
        if not member and not invite:
            snap.update(
                roleVersion=row["role_version"], governanceVersion=row["admin_governance_version"]
            )
        if member:
            snap["member"] = dict(member)
        if invite:
            # Another invitation in this same batch must not invalidate this
            # target. Its own row and group access/owner state remain guarded.
            snap["invite"] = {key: value for key, value in dict(invite).items() if key != "token_digest"}
        if action == "group.owner.change":
            new_owner = conn.execute(
                "SELECT m.*,u.status AS user_status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id=? AND m.left_at IS NULL",
                (cid, parameters["userId"]),
            ).fetchone()
            if (
                not new_owner
                or new_owner["user_status"] != "active"
                or new_owner["role"] == "owner"
            ):
                raise conflict("受让人须是本群当前可用的其他成员。")
            self.runtime.groups.owner_capacity(conn, new_owner["user_id"])
            snap["newOwner"] = dict(new_owner)
        label = row["name"] if row["kind"] == "group" else "私聊 " + row["id"]
        if member:
            label += " · " + identity(conn, member["user_id"])["nickname"]
        if invite:
            label += " · 邀请 " + target
        count = (
            conn.execute(
                "SELECT COUNT(*) FROM memberships WHERE conversation_id=? AND left_at IS NULL",
                (cid,),
            ).fetchone()[0]
            if row["kind"] == "group"
            else 2
        )
        return snap, label, f"会话状态：{row['status']}；当前参与人数：{count}"

    def apply_group(self, conn, command, target, parameters):
        action, stamp = command["action"], now_ms()
        snap, _, _ = self.inspect_group(conn, action, target, parameters)
        cid = snap["id"]
        if action.startswith("conversation."):
            conn.execute(
                "UPDATE conversations SET status=?,write_version=write_version+1,updated_at=? WHERE id=?",
                ("frozen" if action == "conversation.freeze" else "active", stamp, cid),
            )
        elif action.startswith("group.member."):
            member = snap["member"]
            if action == "group.member.remove":
                self.runtime.groups.remove_in(conn, cid, member["user_id"], "site_admin_removed")
                return "成员已移出，原加入期及关联访问已关闭。"
            field, value = (
                ("role", parameters["role"])
                if action == "group.member.role"
                else ("muted_until", parameters.get("until"))
            )
            conn.execute(
                f"UPDATE memberships SET {field}=?,write_version=write_version+1 WHERE id=?",
                (value, target),
            )
            conn.execute(
                "UPDATE conversations SET role_version=role_version+1,updated_at=? WHERE id=?",
                (stamp, cid),
            )
        elif action == "group.owner.change":
            conn.execute(
                "UPDATE memberships SET role='member',write_version=write_version+1 WHERE conversation_id=? AND role='owner' AND left_at IS NULL",
                (cid,),
            )
            conn.execute(
                "UPDATE memberships SET role='owner',write_version=write_version+1 WHERE id=?",
                (snap["newOwner"]["id"],),
            )
            conn.execute(
                "UPDATE conversations SET owner_id=?,role_version=role_version+1,updated_at=? WHERE id=?",
                (parameters["userId"], stamp, cid),
            )
            conn.execute(
                "UPDATE group_transfers SET status='cancelled',updated_at=? WHERE conversation_id=? AND status='pending'",
                (stamp, cid),
            )
            self.runtime.groups.system_message(conn, cid, "全站管理员已纠正本群群主")
        elif action == "group.invite.revoke":
            conn.execute("UPDATE group_invites SET revoked_at=? WHERE id=?", (stamp, target))
            self.runtime.groups.invites.expire_in(conn, cid)
        elif action == "group.dissolve":
            recipients = self.runtime.access.recipients(conn, cid)
            conn.execute(
                "UPDATE conversations SET status='dissolved',dissolved_at=?,updated_at=?,role_version=role_version+1,write_version=write_version+1 WHERE id=?",
                (stamp, stamp, cid),
            )
            conn.execute(
                "UPDATE memberships SET left_at=?,left_reason='site_admin_dissolved',write_version=write_version+1 WHERE conversation_id=? AND left_at IS NULL",
                (stamp, cid),
            )
            conn.execute(
                "UPDATE group_invites SET revoked_at=COALESCE(revoked_at,?) WHERE conversation_id=?",
                (stamp, cid),
            )
            self.runtime.groups.invites.expire_in(conn, cid)
            conn.execute(
                "UPDATE group_transfers SET status='cancelled',updated_at=? WHERE conversation_id=? AND status='pending'",
                (stamp, cid),
            )
            self.runtime.events.publish(conn, recipients, "access.revoked", cid, cid)
            return "群已解散，成员期、邀请、申请和在途转让均已终止。"
        self.runtime.groups.changed(conn, cid)
        return "会话治理已生效，前台依据当前权限同步更新。"
