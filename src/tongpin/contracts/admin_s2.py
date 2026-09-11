from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator, model_validator

from tongpin.contracts.admin import AdminPreviewInput
from tongpin.contracts.base import InputModel


class SensitiveRead(InputModel):
    reason: str = Field(min_length=3, max_length=500)

    _reason = field_validator("reason")(AdminPreviewInput.substantive_reason.__func__)


class SearchRead(SensitiveRead):
    query: str = Field(default="", max_length=200)
    conversationId: str = Field(default="", max_length=128)
    fromAt: int | None = Field(default=None, ge=0, le=2**63 - 1)
    until: int | None = Field(default=None, ge=0, le=2**63 - 1)
    after: str = Field(default="", max_length=512)
    limit: int = Field(default=50, ge=1, le=100)

    @model_validator(mode="after")
    def time_order(self):
        if self.fromAt is not None and self.until is not None and self.fromAt > self.until:
            raise ValueError("Start must not follow end")
        return self


class ContentSearch(SearchRead):
    senderId: str = Field(default="", max_length=128)
    kind: Literal["", "direct", "group"] = ""
    status: Literal["", "sent", "recalled", "moderated", "purged"] = ""


class FileSearch(SearchRead):
    ownerId: str = Field(default="", max_length=128)
    state: Literal[
        "",
        "reserved",
        "uploading",
        "processing",
        "ready",
        "quarantined",
        "rejected",
        "cancelled",
        "expired",
    ] = ""
    governance: Literal["", "available", "quarantined", "revoked"] = ""
    kind: Literal["", "image", "file"] = ""


class FileRead(SensitiveRead):
    variant: Literal["content", "preview", "thumbnail"] = "content"
