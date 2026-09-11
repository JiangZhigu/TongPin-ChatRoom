from __future__ import annotations

import re
import unicodedata
import uuid
from typing import Literal

from pydantic import Field, field_validator

from tongpin.contracts.base import APIError, InputModel


def sequence(value: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", value):
        raise APIError("VALIDATION_ERROR", "序列或游标格式无效。", 422)
    result = int(value)
    if result > 9223372036854775807:
        raise APIError("VALIDATION_ERROR", "序列或游标超出范围。", 422)
    return result


def page_limit(value=50):
    try:
        result = int(value)
    except (ValueError, TypeError) as exc:
        raise APIError("VALIDATION_ERROR", "分页大小无效。", 422) from exc
    if not 1 <= result <= 100:
        raise APIError("VALIDATION_ERROR", "每页数量须为1至100。", 422)
    return result


def message_text(value, *, max_chars=4000, max_bytes=16384, allow_empty=False):
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise APIError("VALIDATION_ERROR", "消息含无效字符。", 422) from exc
    if len(value) > max_chars or size > max_bytes:
        raise APIError("PAYLOAD_TOO_LARGE", "消息最多4000字且不超过16 KiB。", 413)
    if any(unicodedata.category(char) == "Cc" and char not in "\n\t" for char in value):
        raise APIError("VALIDATION_ERROR", "消息不能包含控制字符。", 422)
    if not allow_empty and not value.strip():
        raise APIError("VALIDATION_ERROR", "请填写消息内容。", 422)
    return value


class FriendRequestInput(InputModel):
    targetUserId: str = Field(min_length=1, max_length=80)
    note: str = Field(default="", max_length=200)


class FriendPreferencesInput(InputModel):
    notifyOnline: bool | None = None
    remark: str | None = Field(default=None, max_length=80)


class DirectInput(InputModel):
    friendUserId: str = Field(min_length=1, max_length=80)


class MessageInput(InputModel):
    clientMessageId: str = Field(min_length=36, max_length=36)
    text: str = Field(default="", max_length=4000)
    attachmentIds: list[str] = Field(default_factory=list, max_length=6)
    replyToMessageId: str | None = Field(default=None, max_length=80)
    mentionedUserIds: list[str] = Field(default_factory=list, max_length=50)
    mentionAll: bool = False
    accessKey: str = Field(min_length=1, max_length=160)
    actorContext: str | None = Field(default=None, max_length=80)

    @field_validator("clientMessageId")
    @classmethod
    def valid_uuid(cls, value):
        parsed = uuid.UUID(value)
        if parsed.version != 4 or str(parsed) != value:
            raise ValueError("Expected canonical UUID v4")
        return value


class SocketMessageInput(MessageInput):
    v: Literal[1] = 1
    conversationId: str = Field(min_length=1, max_length=80)
    requestId: str = Field(min_length=1, max_length=80)


class ReadInput(InputModel):
    readSeq: str = Field(min_length=1, max_length=19)


class ConversationPreferencesInput(InputModel):
    muted: bool | None = None
    pinned: bool | None = None
    archived: bool | None = None
    onlyMentions: bool | None = None
