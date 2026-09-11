from __future__ import annotations

from tongpin.admin.authz import mute_until
from tongpin.admin.settings import validate_values
from tongpin.contracts.base import APIError

S2_SIMPLE = {
    "message.review",
    "message.hide",
    "message.delete",
    "message.restore",
    "file.quarantine",
    "file.release",
    "file.revoke",
    "report.claim",
    "report.reopen",
    "site_invite.revoke",
}


def validate_s2_parameters(action, targets, parameters):
    def require(condition, message="操作参数与所选动作不匹配。"):
        if not condition:
            raise APIError("VALIDATION_ERROR", message, 422)

    if action in S2_SIMPLE:
        require(not parameters)
    elif action == "user.quota":
        require(set(parameters) == {"quotaBytes"})
        value = parameters["quotaBytes"]
        require(
            value is None or type(value) is int and 1024 <= value <= 1024**4,
            "用户配额须为1024字节至1TiB，或选择恢复站点默认。",
        )
    elif action in ("report.resolve", "report.reject"):
        require(
            set(parameters) in ({"feedback"}, {"feedback", "disposition"})
            if action == "report.resolve"
            else set(parameters) == {"feedback"}
        )
        value = parameters["feedback"]
        require(
            isinstance(value, str)
            and 3 <= len(value.strip()) <= 1000
            and not any(ord(char) < 32 and char not in "\n\t" for char in value),
            "请填写3至1000字的举报者反馈。",
        )
        if action == "report.resolve":
            require(len(targets) == 1, "联动处理每次只提交一份工单。")
            disposition = parameters.get("disposition")
            if disposition is not None:
                require(isinstance(disposition, dict))
                name = disposition.get("action")
                require(
                    name
                    in (
                        "user.ban",
                        "user.mute",
                        "conversation.freeze",
                        "message.hide",
                        "message.delete",
                    )
                )
                require(
                    set(disposition)
                    == (
                        {"action", "targetId", "until"}
                        if name == "user.mute"
                        else {"action", "targetId"}
                    )
                )
                require(
                    isinstance(disposition["targetId"], str)
                    and 1 <= len(disposition["targetId"]) <= 128
                )
                if name == "user.mute":
                    mute_until(disposition)
    elif action in ("settings.update", "settings.rollback"):
        require(targets == ["instance"])
        require(
            set(parameters)
            == {"expectedVersion", "values" if action == "settings.update" else "version"}
        )
        require(
            type(parameters["expectedVersion"]) is int
            and 0 <= parameters["expectedVersion"] < 2**63
        )
        if action == "settings.update":
            validate_values(parameters["values"])
        else:
            require(type(parameters["version"]) is int and 0 <= parameters["version"] < 2**63)
    elif action == "site_invite.create":
        require(targets == ["instance"])
        require(set(parameters) == {"maxUses", "expiresInHours"})
        require(type(parameters["maxUses"]) is int and 1 <= parameters["maxUses"] <= 1000)
        require(
            type(parameters["expiresInHours"]) is int and 1 <= parameters["expiresInHours"] <= 168
        )
    else:
        return False
    return True
