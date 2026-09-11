from __future__ import annotations

from flask import Blueprint, g, request

from tongpin.admin.authz import bounded_limit
from tongpin.contracts.admin import AdminExecuteInput, AdminPreviewInput
from tongpin.contracts.admin_s2 import ContentSearch, FileRead, FileSearch, SensitiveRead
from tongpin.contracts.admin_s3 import AuditFilters, LogFilters, OperationDownload
from tongpin.contracts.admin_tasks import GroupTaskRead, GroupTasksRead
from tongpin.transports.http.auth import parse, principal, runtime, success
from tongpin.transports.http.files import send_content

admin_blueprint = Blueprint("admin", __name__, url_prefix="/api/v1/admin")


@admin_blueprint.post("/tasks/search")
def task_group_search():
    return success(runtime().admin.task_group_search(principal(admin=True), parse(GroupTasksRead), g.request_id))


@admin_blueprint.post("/tasks/<tid>/read")
def task_group_read(tid):
    return success(runtime().admin.task_group_read(principal(admin=True), tid, parse(GroupTaskRead), g.request_id))


@admin_blueprint.get("/task-reports")
def task_reports_list():
    return success(runtime().admin.task_reports_list(principal(admin=True), request.args.get("status", ""), **pagination()))


@admin_blueprint.post("/task-reports/<rid>/read")
def task_report_read(rid):
    return success(runtime().admin.task_report_read(principal(admin=True), rid, parse(SensitiveRead), g.request_id))


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


@admin_blueprint.post("/content/search")
def content_search():
    return success(runtime().admin.content_search(principal(admin=True), parse(ContentSearch), g.request_id))


@admin_blueprint.post("/content/<mid>/read")
def content_read(mid):
    return success(runtime().admin.content_read(principal(admin=True), mid, parse(SensitiveRead), g.request_id))


@admin_blueprint.post("/files/search")
def files_search():
    return success(runtime().admin.files_search(principal(admin=True), parse(FileSearch), g.request_id))


@admin_blueprint.post("/files/<fid>/read")
def file_read(fid):
    return success(runtime().admin.file_read(principal(admin=True), fid, parse(SensitiveRead), g.request_id))


@admin_blueprint.post("/files/<fid>/content")
def file_content(fid):
    data = parse(FileRead)
    return send_content(runtime().admin.file_content(principal(admin=True), fid, data, g.request_id), download=data.variant == "content")


@admin_blueprint.get("/reports")
def reports():
    return success(runtime().admin.reports_list(principal(admin=True), status=request.args.get("status", ""), category=request.args.get("category", ""), assigned=request.args.get("assigned", "all"), **pagination()))


@admin_blueprint.post("/reports/<rid>/read")
def report_read(rid):
    return success(runtime().admin.report_read(principal(admin=True), rid, parse(SensitiveRead), g.request_id))


@admin_blueprint.get("/settings")
def settings():
    return success(runtime().admin.settings_view(principal(admin=True)))


@admin_blueprint.get("/settings/versions")
def settings_versions():
    return success(runtime().admin.settings_versions(principal(admin=True), **pagination()))


@admin_blueprint.get("/site-invites")
def site_invites():
    return success(runtime().admin.site_invites(principal(admin=True), **pagination()))


@admin_blueprint.get('/announcements')
def announcements():
    return success(runtime().admin.announcements(principal(admin=True), status=request.args.get('status', ''), **pagination()))


@admin_blueprint.get('/announcements/<aid>')
def announcement(aid):
    return success(runtime().admin.announcement(principal(admin=True), aid))


@admin_blueprint.get('/administrators')
def administrators():
    return success(runtime().admin.administrators(principal(admin=True), **pagination()))


def query_model(model):
    values = {key: value for key, value in request.args.items() if key not in ('after', 'limit')}
    for field in ('fromAt', 'until'):
        if field in values:
            try:
                values[field] = int(values[field])
            except ValueError:
                pass  # The strict schema returns the normal validation response.
    return model.model_validate(values)


@admin_blueprint.get('/audit')
def audit_events():
    return success(runtime().admin.audit_events(principal(admin=True), query_model(AuditFilters), **pagination()))


@admin_blueprint.get('/logs')
def runtime_logs():
    return success(runtime().admin.runtime_log_events(principal(admin=True), query_model(LogFilters), **pagination()))


@admin_blueprint.get('/operations')
def operations():
    return success(runtime().admin.operations(principal(admin=True), kind=request.args.get('kind', ''), status=request.args.get('status', ''), **pagination()))


@admin_blueprint.get('/operations/<oid>')
def operation(oid):
    return success(runtime().admin.operation(principal(admin=True), oid))


@admin_blueprint.get('/jobs')
def jobs():
    return success(runtime().admin.operations(principal(admin=True), kind=request.args.get('kind', ''), status=request.args.get('status', ''), jobs=True, **pagination()))


@admin_blueprint.post('/operations/<oid>/download')
def operation_download(oid):
    return send_content(runtime().admin.operation_download(principal(admin=True), oid, parse(OperationDownload), g.request_id), download=True)
