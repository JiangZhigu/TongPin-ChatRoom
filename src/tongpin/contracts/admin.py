from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import Field, field_validator

from tongpin.contracts.base import InputModel

AdminAction = Literal[
    "user.ban",
    "user.unban",
    "user.mute",
    "user.unmute",
    "user.restrict",
    "user.restore",
    "user.password_reset",
    "session.revoke",
    "user.logout_all",
    "relationship.remove",
    "friend_request.cancel",
    "conversation.freeze",
    "conversation.unfreeze",
    "group.member.role",
    "group.member.mute",
    "group.member.unmute",
    "group.member.remove",
    "group.owner.change",
    "group.dissolve",
    "group.invite.revoke",
    "monitoring.thresholds",
    "message.review", "message.hide", "message.delete", "message.restore",
    "file.quarantine", "file.release", "file.revoke", "user.quota",
    "report.claim", "report.reopen", "report.reject", "report.resolve",
    "settings.update", "settings.rollback", "site_invite.create", "site_invite.revoke",
    "announcement.create", "announcement.withdraw",
    "administrator.invite", "administrator.cancel", "administrator.revoke", "administrator.factor_reset",
    "export.create", "backup.create", "backup.verify", "backup.drill", "storage.cleanup",
    "operation.cancel", "operation.retry", "job.retry",
    "task.delete", "task.restore", "task.comment.delete", "task.group.policy",
    "task_report.close", "task_report.reopen",
]


class AdminPreviewInput(InputModel):
    operationId: str = Field(min_length=36, max_length=36)
    action: AdminAction
    targetIds: list[str] = Field(min_length=1, max_length=100)
    parameters: dict[str, Any] = Field(default_factory=dict)
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("operationId")
    @classmethod
    def operation_uuid(cls, value):
        if str(UUID(value)) != value:
            raise ValueError("Canonical UUID required")
        return value

    @field_validator("targetIds")
    @classmethod
    def target_ids(cls, values):
        if len(values) != len(set(values)) or any(not 1 <= len(v) <= 128 for v in values):
            raise ValueError("Distinct bounded target IDs required")
        return values

    @field_validator("reason")
    @classmethod
    def substantive_reason(cls, value):
        value = value.strip()
        if len(value) < 3 or any(ord(c) < 32 and c not in "\n\t" for c in value):
            raise ValueError("A substantive reason is required")
        return value


class AdminExecuteInput(InputModel):
    operationId: str = Field(min_length=36, max_length=36)
    reauthToken: str = Field(min_length=20, max_length=128)
