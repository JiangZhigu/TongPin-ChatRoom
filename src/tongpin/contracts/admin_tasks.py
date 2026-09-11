from typing import Literal

from pydantic import Field

from tongpin.contracts.admin_s2 import SensitiveRead


class GroupTasksRead(SensitiveRead):
    groupId: str = Field(min_length=1, max_length=128)
    query: str = Field(default="", max_length=120)
    status: Literal["", "todo", "doing", "done"] = ""
    deleted: Literal["", "only", "all"] = ""
    after: str = Field(default="", max_length=512)
    limit: int = Field(default=30, ge=1, le=100)


class GroupTaskRead(SensitiveRead):
    after: str = Field(default="", max_length=512)
    limit: int = Field(default=30, ge=1, le=100)
