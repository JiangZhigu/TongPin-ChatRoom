from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator, model_validator

from tongpin.contracts.admin_s2 import SensitiveRead
from tongpin.contracts.base import InputModel


class AnnouncementParameters(InputModel):
    kind: Literal["announcement", "notification"]
    title: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=4000)
    audience: Literal["all", "users", "group"]
    userIds: list[str] = Field(default_factory=list, max_length=100)
    groupId: str = Field(default="", max_length=128)
    publishAt: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("title", "body")
    @classmethod
    def text(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 and c not in "\n\t" for c in value):
            raise ValueError("Substantive plain text required")
        return value

    @model_validator(mode="after")
    def audience_shape(self):
        if len(self.userIds) != len(set(self.userIds)) or any(
            not 1 <= len(i) <= 128 for i in self.userIds
        ):
            raise ValueError("Distinct bounded user identifiers required")
        if self.audience == "users" and (not self.userIds or self.groupId):
            raise ValueError("Explicit user audience required")
        if self.audience == "group" and (not self.groupId or self.userIds):
            raise ValueError("A group audience required")
        if self.audience == "all" and (self.userIds or self.groupId):
            raise ValueError("No extra audience identifiers allowed")
        return self


class EnrollmentStart(InputModel):
    reauthToken: str = Field(min_length=20, max_length=128)


class EnrollmentFinish(InputModel):
    enrollmentId: str = Field(min_length=1, max_length=128)
    code: str = Field(default="", max_length=100)  # Older clients may still send this unused field.


class AuditFilters(InputModel):
    actorId: str = Field(default="", max_length=128)
    subjectId: str = Field(default="", max_length=128)
    action: str = Field(default="", max_length=100)
    result: Literal["", "success", "failed", "denied", "cancelled"] = ""
    requestId: str = Field(default="", max_length=128)
    jobId: str = Field(default="", max_length=128)
    fromAt: int | None = Field(default=None, ge=0, le=2**63 - 1)
    until: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @model_validator(mode="after")
    def time_order(self):
        if self.fromAt is not None and self.until is not None and self.fromAt > self.until:
            raise ValueError("Time range is reversed")
        return self


class LogFilters(InputModel):
    level: Literal["", "warning", "error"] = ""
    requestId: str = Field(default="", max_length=128)
    jobId: str = Field(default="", max_length=128)
    fromAt: int | None = Field(default=None, ge=0, le=2**63 - 1)
    until: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @model_validator(mode="after")
    def time_order(self):
        if self.fromAt is not None and self.until is not None and self.fromAt > self.until:
            raise ValueError("Time range is reversed")
        return self


class ExportParameters(InputModel):
    kind: Literal["content", "files", "audit"]
    filters: dict = Field(default_factory=dict)
    maxRows: int = Field(ge=1, le=5000)
    maxBytes: int = Field(ge=1024, le=512 * 1024**2)
    includeFiles: bool = False


class OperationDownload(SensitiveRead):
    reauthToken: str | None = Field(default=None, min_length=20, max_length=128)
