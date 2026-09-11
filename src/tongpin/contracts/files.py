from __future__ import annotations

import uuid
from typing import Literal

from pydantic import Field, field_validator, model_validator

from tongpin.contracts.base import InputModel


class UploadInput(InputModel):
    clientUploadId: str = Field(min_length=36, max_length=36)
    actorContext: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=200)
    size: int = Field(gt=0, le=25 * 1024**2, strict=True)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mime: str = Field(default="", max_length=120)
    purpose: Literal["message", "user_avatar", "group_avatar"] = "message"
    conversationId: str | None = Field(default=None, max_length=80)
    accessKey: str | None = Field(default=None, max_length=160)

    @field_validator("clientUploadId")
    @classmethod
    def canonical_uuid(cls, value):
        parsed = uuid.UUID(value)
        if parsed.version != 4 or str(parsed) != value:
            raise ValueError("Expected canonical UUID v4")
        return value

    @model_validator(mode="after")
    def scope_fields(self):
        if self.purpose == "user_avatar":
            if self.conversationId is not None or self.accessKey is not None:
                raise ValueError("Personal avatar does not belong to a conversation")
        elif not self.conversationId or not self.accessKey:
            raise ValueError("Conversation and access key are required")
        return self


class AvatarInput(InputModel):
    attachmentId: str | None = Field(default=None, max_length=80)


class GroupAvatarInput(AvatarInput):
    expectedVersion: int = Field(ge=1, strict=True)

