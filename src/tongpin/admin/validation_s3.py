from __future__ import annotations

from pydantic import ValidationError

from tongpin.contracts.admin_s3 import AnnouncementParameters, ExportParameters
from tongpin.contracts.base import APIError

S3_ACTIONS = {
    "announcement.create",
    "announcement.withdraw",
    "administrator.invite",
    "administrator.cancel",
    "administrator.revoke",
    "administrator.factor_reset",
    "export.create",
    "backup.create",
    "backup.verify",
    "backup.drill",
    "storage.cleanup",
    "operation.cancel",
    "operation.retry",
    "job.retry",
}


def validate_s3_parameters(action, targets, parameters):
    if action not in S3_ACTIONS:
        return False
    if len(targets) != 1:
        raise APIError("VALIDATION_ERROR", "此操作每次处理一个明确目标或一份固定范围。", 422)
    if action in (
        "announcement.create",
        "export.create",
        "backup.create",
        "storage.cleanup",
    ) and targets != ["instance"]:
        raise APIError("VALIDATION_ERROR", "此操作作用于当前实例。", 422)
    model = (
        AnnouncementParameters
        if action == "announcement.create"
        else ExportParameters
        if action == "export.create"
        else None
    )
    if model:
        try:
            normalized = model.model_validate(parameters).model_dump()
        except ValidationError as error:
            raise APIError("VALIDATION_ERROR", "请核对范围、文本、时间及任务预算。", 422) from error
        parameters.clear()
        parameters.update(normalized)
    elif parameters:
        raise APIError("VALIDATION_ERROR", "此操作不接受附加参数。", 422)
    return True
