from __future__ import annotations

from flask import Blueprint, request

from tongpin.contracts.base import APIError
from tongpin.contracts.groups import (
    GroupCommand,
    GroupCreate,
    GroupDissolveInput,
    GroupInviteInput,
    GroupMemberInput,
    GroupRemoveInput,
    GroupSettingsInput,
    GroupTransferInput,
)
from tongpin.transports.http.auth import parse, principal, runtime, success
from tongpin.transports.http.chat import paging

groups_blueprint = Blueprint("groups", __name__)


@groups_blueprint.post("/api/v1/groups")
def create_group():
    return success(runtime().groups.create(principal(), parse(GroupCreate)), 201)


@groups_blueprint.route("/api/v1/groups/<cid>", methods=["GET", "PATCH"])
def group(cid):
    if request.method == "GET":
        return success(runtime().groups.get(principal(), cid))
    return success(runtime().groups.update(principal(), cid, parse(GroupSettingsInput)))


@groups_blueprint.get("/api/v1/groups/<cid>/members")
def members(cid):
    return success(runtime().groups.members(principal(), cid, *paging()))


@groups_blueprint.patch("/api/v1/groups/<cid>/members/<uid>")
def change_member(cid, uid):
    return success(runtime().groups.member_update(principal(), cid, uid, parse(GroupMemberInput)))


@groups_blueprint.post("/api/v1/groups/<cid>/members/<uid>/remove")
def remove_member(cid, uid):
    return success(runtime().groups.remove(principal(), cid, uid, parse(GroupRemoveInput)))


@groups_blueprint.post("/api/v1/groups/<cid>/leave")
def leave(cid):
    parse()
    return success(runtime().groups.leave(principal(), cid))


@groups_blueprint.post("/api/v1/groups/<cid>/dissolve")
def dissolve(cid):
    return success(runtime().groups.dissolve(principal(), cid, parse(GroupDissolveInput)))


@groups_blueprint.get("/api/v1/groups/<cid>/audit")
def group_audit(cid):
    return success(runtime().groups.audit_log(principal(), cid, *paging()))


@groups_blueprint.route("/api/v1/groups/<cid>/invites", methods=["GET", "POST"])
def invites(cid):
    if request.method == "GET":
        return success(runtime().groups.invites.list(principal(), cid, *paging()))
    return success(runtime().groups.invites.create(principal(), cid, parse(GroupInviteInput)), 201)


@groups_blueprint.post("/api/v1/groups/<cid>/invites/<iid>/revoke")
def revoke(cid, iid):
    parse()
    return success(runtime().groups.invites.revoke(principal(), cid, iid))


@groups_blueprint.get("/api/v1/group-invites/mine")
def own_invites():
    return success(runtime().groups.invites.mine(principal(), *paging()))


@groups_blueprint.get("/api/v1/group-invites/preview")
def preview():
    runtime().auth.security.rate("group-preview", request.remote_addr or "unknown", 120, 60)
    try:
        actor = runtime().auth.load(request.cookies.get(runtime().auth.cookie_name, ""))
    except APIError as error:
        if error.code != "AUTH_REQUIRED":
            raise
        actor = None
    return success(runtime().groups.invites.preview(request.headers.get("X-Group-Invite"), actor))


@groups_blueprint.post("/api/v1/group-invites/<iid>/apply")
def apply(iid):
    return success(
        runtime().groups.invites.apply(
            principal(), iid, parse(GroupCommand), request.headers.get("X-Group-Invite")
        ),
        201,
    )


@groups_blueprint.get("/api/v1/group-applications/mine")
def own_applications():
    return success(runtime().groups.invites.applications(principal(), None, *paging()))


@groups_blueprint.get("/api/v1/groups/<cid>/applications")
def applications(cid):
    return success(runtime().groups.invites.applications(principal(), cid, *paging()))


@groups_blueprint.post("/api/v1/group-applications/<rid>/<action>")
def decide_application(rid, action):
    parse()
    if action not in ("approve", "reject", "cancel"):
        raise APIError("RESOURCE_UNAVAILABLE", "操作不存在。", 404)
    return success(runtime().groups.invites.decide(principal(), rid, action))


@groups_blueprint.post("/api/v1/groups/<cid>/transfers")
def transfer(cid):
    return success(
        runtime().groups.start_transfer(principal(), cid, parse(GroupTransferInput)), 201
    )


@groups_blueprint.post("/api/v1/groups/<cid>/transfers/<tid>/<action>")
def decide_transfer(cid, tid, action):
    parse()
    if action not in ("accept", "reject", "cancel"):
        raise APIError("RESOURCE_UNAVAILABLE", "操作不存在。", 404)
    return success(runtime().groups.decide_transfer(principal(), cid, tid, action))
