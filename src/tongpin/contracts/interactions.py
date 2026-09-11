from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator

from tongpin.contracts.auth import SensitiveInput
from tongpin.contracts.base import InputModel
from tongpin.contracts.chat import MessageInput


class ModerationInput(InputModel):
    reason: str = Field(min_length=1, max_length=500)


class TypingInput(InputModel):
    active: bool


class ReportInput(InputModel):
    clientReportId: str = Field(min_length=36, max_length=36)
    targetKind: Literal["message", "user", "group"]
    targetId: str = Field(min_length=1, max_length=80)
    category: Literal["spam", "harassment", "illegal", "other"]
    description: str = Field(min_length=1, max_length=1000)

    @field_validator("clientReportId")
    @classmethod
    def checked_id(cls, value):
        return MessageInput.valid_uuid(value)


class DeleteAccountInput(SensitiveInput):
    confirmation: str = Field(min_length=1, max_length=64)
