from __future__ import annotations

import re
import unicodedata
from datetime import date
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator

from tongpin.contracts.base import InputModel
from tongpin.contracts.chat import message_text


def title_text(value, maximum=120):
    value = value.strip()
    if not 1 <= len(value) <= maximum or any(
        unicodedata.category(c) in {"Cc", "Cs", "Zl", "Zp"} for c in value
    ):
        raise ValueError(f"请填写1至{maximum}字的单行文字。")
    return value


def timezone_name(value):
    if not isinstance(value, str) or not value or len(value) > 80:
        raise ValueError("请选择有效的IANA时区。")
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError("请选择有效的IANA时区。") from error
    return value


class TaskFields(InputModel):
    title: str = Field(max_length=120)
    description: str = Field(default="", max_length=4000)
    priority: Literal["low", "normal", "high"] = "normal"
    dueOn: str | None = None
    dueTimezone: str = "Asia/Shanghai"
    assigneeId: str | None = Field(default=None, max_length=80)
    listId: str | None = Field(default=None, max_length=80)
    tagIds: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("title")
    @classmethod
    def title_valid(cls, value):
        return title_text(value)

    @field_validator("description")
    @classmethod
    def description_valid(cls, value):
        return message_text(value, allow_empty=True)

    @field_validator("dueOn")
    @classmethod
    def date_valid(cls, value):
        if value is not None:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError("日期格式须为YYYY-MM-DD。")
            parsed = date.fromisoformat(value)
            if not 1900 <= parsed.year <= 9998:
                raise ValueError("日期须在1900至9998年之间。")
        return value

    @field_validator("dueTimezone")
    @classmethod
    def timezone_valid(cls, value):
        return timezone_name(value)


class TaskCreate(TaskFields):
    scope: Literal["personal", "group"]
    groupId: str | None = Field(default=None, max_length=80)
    sourceMessageId: str | None = Field(default=None, max_length=80)
    snapshotMessageId: str | None = Field(default=None, max_length=80)


class TaskPatch(InputModel):
    title: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    priority: Literal["low", "normal", "high"] | None = None
    status: Literal["todo", "doing", "done"] | None = None
    dueOn: str | None = None
    dueTimezone: str | None = None
    assigneeId: str | None = Field(default=None, max_length=80)
    listId: str | None = Field(default=None, max_length=80)
    tagIds: list[str] | None = Field(default=None, max_length=20)
    confirmIncomplete: bool = False


class CheckCreate(InputModel):
    text: str = Field(max_length=120)

    @field_validator("text")
    @classmethod
    def text_valid(cls, value):
        return title_text(value)


class CheckPatch(InputModel):
    text: str | None = Field(default=None, max_length=120)
    done: bool | None = None


class TaskComment(InputModel):
    text: str = Field(min_length=1, max_length=1000)

    @field_validator("text")
    @classmethod
    def text_valid(cls, value):
        return message_text(value, max_chars=1000, max_bytes=4000)


class TaskShare(InputModel):
    destinationConversationId: str = Field(min_length=1, max_length=80)
    mode: Literal["live", "snapshot"]
    includeDescription: bool = False


class TaskCopy(TaskFields):
    groupId: str = Field(min_length=1, max_length=80)
    acknowledgeShared: Literal[True]


class ReminderInput(InputModel):
    rule: Literal["none", "day_before", "due_day"]
    time: str = Field(default="09:00", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


class TaskPreferences(InputModel):
    assignments: bool = True
    comments: bool = True
    completed: bool = True
    due: bool = True
    timezone: str = "Asia/Shanghai"

    @field_validator("timezone")
    @classmethod
    def zone_valid(cls, value):
        return timezone_name(value)


class TaskMarks(InputModel):
    followed: bool | None = None
    bookmarked: bool | None = None


class TaskLabelInput(InputModel):
    kind: Literal["list", "tag"]
    name: str = Field(max_length=40)

    @field_validator("name")
    @classmethod
    def name_valid(cls, value):
        return title_text(value, 40)


class GroupTaskSettings(InputModel):
    createPolicy: Literal["members", "managers"]


class TaskReportInput(InputModel):
    category: Literal["spam", "harassment", "illegal", "other"]
    description: str = Field(min_length=1, max_length=1000)
    commentId: str | None = Field(default=None, max_length=80)

    @field_validator("description")
    @classmethod
    def description_valid(cls, value):
        return message_text(value, max_chars=1000, max_bytes=4000)
