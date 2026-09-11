from __future__ import annotations

from flask import Blueprint, request, send_file

from tongpin.contracts.base import APIError
from tongpin.contracts.files import AvatarInput, GroupAvatarInput, UploadInput
from tongpin.transports.http.auth import parse, principal, runtime, success
from tongpin.transports.http.chat import paging

files_blueprint = Blueprint("files", __name__)


@files_blueprint.get("/api/v1/files/policy")
def policy():
    return success(runtime().files.policy(principal()))


@files_blueprint.post("/api/v1/attachment-uploads")
def reserve():
    return success(runtime().files.reserve(principal(), parse(UploadInput)), 201)


@files_blueprint.post("/api/v1/attachments")
def receive():
    if request.mimetype != "application/octet-stream":
        raise APIError("FILE_TYPE_MISMATCH", "请使用原始文件字节上传。", 415)
    return success(runtime().files.receive(principal(), request.headers.get("X-Upload-Id", ""), request.stream), 202)


@files_blueprint.get("/api/v1/attachments/<fid>")
def metadata(fid):
    return success(runtime().files.get(principal(), fid))


@files_blueprint.post("/api/v1/attachments/<fid>/<action>")
def change(fid, action):
    parse()
    if action not in {"cancel", "retry"}:
        raise APIError("RESOURCE_UNAVAILABLE", "操作不存在。", 404)
    return success(getattr(runtime().files, action)(principal(), fid))


def send_content(result, *, download=False):
    path, mime, name = result
    response = send_file(path, mimetype=mime, as_attachment=download, download_name=name if download else "preview.webp", conditional=False, etag=False, max_age=0)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@files_blueprint.get("/api/v1/attachments/<fid>/<variant>")
def content(fid, variant):
    if variant not in {"content", "preview", "thumbnail"}:
        raise APIError("RESOURCE_UNAVAILABLE", "附件访问方式不存在。", 404)
    return send_content(runtime().files.content(principal(), fid, variant), download=variant == "content")


@files_blueprint.get("/api/v1/files")
def files():
    return success(runtime().files.list(principal(), request.args.get("conversationId"), request.args.get("kind"), *paging()))


@files_blueprint.put("/api/v1/me/avatar")
def own_avatar():
    return success(runtime().files.set_avatar(principal(), parse(AvatarInput).attachmentId))


@files_blueprint.put("/api/v1/groups/<cid>/avatar")
def set_group_avatar(cid):
    data = parse(GroupAvatarInput)
    return success(runtime().files.set_avatar(principal(), data.attachmentId, cid, data.expectedVersion))


@files_blueprint.get("/api/v1/users/<uid>/avatar")
def user_avatar(uid):
    return send_content(runtime().files.avatar(principal(), uid=uid))


@files_blueprint.get("/api/v1/groups/<cid>/avatar")
def group_avatar(cid):
    return send_content(runtime().files.avatar(principal(), cid=cid))
