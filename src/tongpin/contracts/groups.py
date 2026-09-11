from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field, field_validator, model_validator

from tongpin.contracts.base import InputModel
from tongpin.contracts.chat import message_text


class GroupCommand(InputModel):
    clientRequestId: str = Field(min_length=36, max_length=36)

    @field_validator("clientRequestId")
    @classmethod
    def request_uuid(cls, value):
        parsed = uuid.UUID(value)
        if parsed.version != 4 or str(parsed) != value:
            raise ValueError("Expected canonical UUID v4")
        return value


class GroupCreate(GroupCommand):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    friendUserIds: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("name", "description")
    @classmethod
    def text(cls, value):
        return message_text(value, allow_empty=not value).strip()


class GroupSettingsInput(InputModel):
    expectedVersion: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    announcement: str | None = Field(default=None, max_length=4000)
    announcementPinned: bool | None = None
    reviewRequired: bool | None = None
    inviteRole: Literal["managers", "members"] | None = None
    everyoneMuted: bool | None = None
    slowSeconds: int | None = Field(default=None, ge=0, le=3600)

    @field_validator("name", "description", "announcement")
    @classmethod
    def text(cls, value):
        return message_text(value, allow_empty=True).strip() if value is not None else None


class GroupTarget(InputModel):
    expectedVersion: int = Field(ge=1)
    periodId: str = Field(min_length=1, max_length=80)


class GroupMemberInput(GroupTarget):
    role: Literal["admin", "member"] | None = None
    mutedUntil: int | None = Field(default=None, ge=0)


class GroupRemoveInput(GroupTarget):
    reason: str = Field(default="", max_length=200)


class GroupDissolveInput(InputModel):
    expectedVersion: int = Field(ge=1)
    reauthToken: str = Field(min_length=1, max_length=200)


class GroupInviteInput(GroupCommand):
    kind: Literal["link", "direct"] = "link"
    targetUserId: str | None = Field(default=None, min_length=1, max_length=80)
    maxUses: int = Field(default=10, ge=1, le=200)
    expiresHours: Literal[24, 168] = 24

    @model_validator(mode="after")
    def target(self):
        if (self.kind == "direct") != (self.targetUserId is not None):
            raise ValueError("Direct invitations need exactly one target")
        if self.kind == "direct" and self.maxUses != 1:
            raise ValueError("Direct invitations have one seat")
        return self


class GroupTransferInput(GroupCommand):
    expectedVersion: int = Field(ge=1)
    targetUserId: str = Field(min_length=1, max_length=80)
    targetPeriodId: str = Field(min_length=1, max_length=80)
    reauthToken: str = Field(min_length=1, max_length=200)
