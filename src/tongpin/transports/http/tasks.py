from flask import Blueprint, request

from tongpin.contracts.tasks import (
    CheckCreate,
    CheckPatch,
    GroupTaskSettings,
    ReminderInput,
    TaskComment,
    TaskCopy,
    TaskCreate,
    TaskLabelInput,
    TaskMarks,
    TaskPatch,
    TaskPreferences,
    TaskReportInput,
    TaskShare,
)
from tongpin.transports.http.auth import parse, principal, runtime, success

tasks_blueprint = Blueprint("tasks", __name__)


def command_options():
    return request.headers.get("Idempotency-Key", ""), request.headers.get("If-Match")


def entity_result(data, status=200):
    response = success(data, status)
    dto = data.get("task", data)
    if "etag" in dto:
        response.headers["ETag"] = dto["etag"]
    response.headers["Cache-Control"] = "private, no-store"
    if status == 201 and "id" in dto:
        response.headers["Location"] = "/api/v1/tasks/" + dto["id"]
    return response


@tasks_blueprint.get("/api/v1/tasks/meta")
def meta():
    return success(runtime().tasks.meta(principal()))


@tasks_blueprint.route("/api/v1/tasks", methods=["GET", "POST"])
def collection():
    service, actor = runtime().tasks, principal()
    if request.method == "GET":
        return success(service.list(actor, request.args.to_dict()))
    return entity_result(service.create(actor, parse(TaskCreate), command_options()[0]), 201)


@tasks_blueprint.route("/api/v1/tasks/<tid>", methods=["GET", "PATCH", "DELETE"])
def entity(tid):
    service, actor = runtime().tasks, principal()
    if request.method == "GET":
        return entity_result(service.get(actor, tid))
    action = "patch" if request.method == "PATCH" else "remove"
    data = parse(TaskPatch) if action == "patch" else parse()
    return entity_result(service.mutate(actor, tid, action, data, *command_options()))


@tasks_blueprint.post("/api/v1/tasks/<tid>/<action>")
def task_action(tid, action):
    from tongpin.contracts.base import APIError

    if action not in {"claim", "release", "restore"}:
        raise APIError("RESOURCE_UNAVAILABLE", "操作不存在。", 404)
    return entity_result(
        runtime().tasks.mutate(principal(), tid, action, parse(), *command_options())
    )


@tasks_blueprint.route("/api/v1/tasks/<tid>/check-items", methods=["POST"])
@tasks_blueprint.route("/api/v1/tasks/<tid>/check-items/<item_id>", methods=["PATCH", "DELETE"])
def checks(tid, item_id=None):
    action = {"POST": "create", "PATCH": "patch", "DELETE": "remove"}[request.method]
    data = (
        parse(CheckCreate)
        if action == "create"
        else parse(CheckPatch)
        if action == "patch"
        else parse()
    )
    return entity_result(
        runtime().tasks.mutate(
            principal(), tid, "check." + action, data, *command_options(), item_id=item_id
        )
    )


@tasks_blueprint.get("/api/v1/tasks/<tid>/activities")
def activities(tid):
    return success(
        runtime().tasks.activities(
            principal(), tid, request.args.get("after", ""), request.args.get("limit", 30)
        )
    )


@tasks_blueprint.route("/api/v1/tasks/<tid>/comments", methods=["GET", "POST"])
@tasks_blueprint.route("/api/v1/tasks/<tid>/comments/<comment_id>", methods=["DELETE"])
def comments(tid, comment_id=None):
    if request.method == "GET":
        return success(
            runtime().tasks.comments(
                principal(), tid, request.args.get("after", ""), request.args.get("limit", 30)
            )
        )
    action = "comment.create" if request.method == "POST" else "comment.remove"
    data = parse(TaskComment) if request.method == "POST" else parse()
    return entity_result(
        runtime().tasks.mutate(
            principal(), tid, action, data, *command_options(), item_id=comment_id
        )
    )


@tasks_blueprint.put("/api/v1/tasks/<tid>/my-reminder")
def reminder(tid):
    return entity_result(
        runtime().tasks.mutate(
            principal(), tid, "reminder", parse(ReminderInput), *command_options()
        )
    )


@tasks_blueprint.patch("/api/v1/tasks/<tid>/my-marks")
def marks(tid):
    return entity_result(
        runtime().tasks.mutate(principal(), tid, "marks", parse(TaskMarks), *command_options())
    )


@tasks_blueprint.post("/api/v1/tasks/<tid>/shares")
def shares(tid):
    return success(
        runtime().tasks.share(principal(), tid, parse(TaskShare), *command_options()), 201
    )


@tasks_blueprint.post("/api/v1/tasks/<tid>/group-copies")
def copies(tid):
    return entity_result(
        runtime().tasks.copy_to_group(principal(), tid, parse(TaskCopy), *command_options()), 201
    )


@tasks_blueprint.get("/api/v1/tasks/cards/<mid>")
def cards(mid):
    return success(runtime().tasks.card(principal(), mid))


@tasks_blueprint.patch("/api/v1/tasks/preferences")
def preferences():
    return success(
        runtime().tasks.set_preferences(principal(), parse(TaskPreferences), command_options()[0])
    )


@tasks_blueprint.post("/api/v1/tasks/labels")
@tasks_blueprint.route("/api/v1/tasks/labels/<label_id>", methods=["PATCH", "DELETE"])
def labels(label_id=None):
    data = parse() if request.method == "DELETE" else parse(TaskLabelInput)
    return success(
        runtime().tasks.label(
            principal(), data, command_options()[0], label_id, request.method == "DELETE"
        )
    )


@tasks_blueprint.route("/api/v1/tasks/groups/<gid>/settings", methods=["GET", "PATCH"])
def group_settings(gid):
    data = parse(GroupTaskSettings) if request.method == "PATCH" else None
    return entity_result(runtime().tasks.group_settings(principal(), gid, data, *command_options()))


@tasks_blueprint.post("/api/v1/tasks/<tid>/reports")
def reports(tid):
    return success(
        runtime().tasks.report(principal(), tid, parse(TaskReportInput), *command_options()), 201
    )
