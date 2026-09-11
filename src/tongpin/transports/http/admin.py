from __future__ import annotations

from flask import Blueprint, g, request

from tongpin.admin.authz import bounded_limit
from tongpin.contracts.admin import AdminExecuteInput, AdminPreviewInput
from tongpin.transports.http.auth import parse, principal, runtime, success

admin_blueprint = Blueprint("admin", __name__, url_prefix="/api/v1/admin")


@admin_blueprint.before_request
def authorized():
    principal(admin=True)


def pagination():
    return {
        "after": request.args.get("after", ""),
        "limit": bounded_limit(request.args.get("limit", 50)),
    }


@admin_blueprint.get("/overview")
def overview():
    return success(
        runtime().admin.overview(principal(admin=True), request.args.get("window", "24h"))
    )


@admin_blueprint.get("/monitoring")
def monitoring():
    return success(runtime().admin.monitoring(principal(admin=True)))


@admin_blueprint.get("/alerts")
def alerts():
    return success(runtime().admin.alerts(principal(admin=True), **pagination()))


@admin_blueprint.get("/users")
def users():
    return success(
        runtime().admin.users(
            principal(admin=True),
            query=request.args.get("q", ""),
            status=request.args.get("status", ""),
            role=request.args.get("role", ""),
            sort=request.args.get("sort", "newest"),
            **pagination(),
        )
    )


@admin_blueprint.get("/users/<uid>")
def user_detail(uid):
    return success(runtime().admin.user_detail(principal(admin=True), uid))


@admin_blueprint.get("/sessions")
def sessions():
    return success(
        runtime().admin.sessions(
            principal(admin=True),
            user_id=request.args.get("userId", ""),
            state=request.args.get("state", "active"),
            **pagination(),
        )
    )


@admin_blueprint.get("/connections")
def connections():
    return success(
        runtime().admin.connections(
            principal(admin=True), user_id=request.args.get("userId", ""), **pagination()
        )
    )


@admin_blueprint.get("/relations")
def relations():
    return success(
        runtime().admin.relations(
            principal(admin=True),
            kind=request.args.get("kind", "friendship"),
            query=request.args.get("query", ""),
            status=request.args.get("status", ""),
            **pagination(),
        )
    )


@admin_blueprint.get("/groups")
def groups():
    return success(
        runtime().admin.groups(
            principal(admin=True),
            query=request.args.get("q", ""),
            status=request.args.get("status", ""),
            owner=request.args.get("ownerId", ""),
            **pagination(),
        )
    )


@admin_blueprint.get("/groups/<cid>")
def group_detail(cid):
    return success(runtime().admin.group_detail(principal(admin=True), cid))


@admin_blueprint.get("/groups/<cid>/<kind>")
def group_items(cid, kind):
    return success(
        runtime().admin.group_detail(principal(admin=True), cid, kind=kind, **pagination())
    )


@admin_blueprint.post("/commands/preview")
def preview():
    return success(runtime().admin.preview(principal(admin=True), parse(AdminPreviewInput)))


@admin_blueprint.post("/commands/execute")
def execute():
    return success(
        runtime().admin.execute(principal(admin=True), parse(AdminExecuteInput), g.request_id)
    )


@admin_blueprint.get("/commands/<operation_id>")
def command(operation_id):
    return success(runtime().admin.command(principal(admin=True), operation_id))


@admin_blueprint.post("/commands/<operation_id>/secret")
def secret(operation_id):
    parse()
    return success(runtime().admin.reveal_secret(principal(admin=True), operation_id))
