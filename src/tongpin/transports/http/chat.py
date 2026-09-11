from __future__ import annotations

from flask import Blueprint, request

from tongpin.contracts.base import APIError
from tongpin.contracts.chat import (
    ConversationPreferencesInput,
    DirectInput,
    FriendPreferencesInput,
    FriendRequestInput,
    MessageInput,
    ReadInput,
    page_limit,
)
from tongpin.transports.http.auth import parse, principal, runtime, success

chat_blueprint = Blueprint("chat", __name__)


def paging():
    after = request.args.get("after", "")
    if len(after) > 120:
        raise APIError("VALIDATION_ERROR", "分页游标无效。", 422)
    return after, page_limit(request.args.get("limit", 50))


@chat_blueprint.get("/api/v1/users/search")
def search_users():
    return success(runtime().contacts.search(principal(), request.args.get("q", ""), *paging()))


@chat_blueprint.route("/api/v1/friend-requests", methods=["GET", "POST"])
def friend_requests():
    if request.method == "GET":
        return success(runtime().contacts.requests(principal(), *paging()))
    return success(runtime().contacts.request(principal(), parse(FriendRequestInput)), 201)


@chat_blueprint.post("/api/v1/friend-requests/<rid>/<action>")
def decide_friend(rid, action):
    parse()
    if action not in {"accept", "reject", "cancel"}:
        raise APIError("RESOURCE_UNAVAILABLE", "操作不存在。", 404)
    return success(runtime().contacts.decide(principal(), rid, action))


@chat_blueprint.get("/api/v1/friends")
def friends():
    return success(runtime().contacts.list(principal(), *paging()))


@chat_blueprint.delete("/api/v1/friends/<uid>")
def remove_friend(uid):
    parse()
    return success(runtime().contacts.remove(principal(), uid))


@chat_blueprint.patch("/api/v1/friends/<uid>/preferences")
def friend_preferences(uid):
    return success(runtime().contacts.preferences(principal(), uid, parse(FriendPreferencesInput)))


@chat_blueprint.get("/api/v1/blocks")
def blocks():
    return success(runtime().contacts.blocks(principal(), *paging()))


@chat_blueprint.route("/api/v1/blocks/<uid>", methods=["PUT", "DELETE"])
def set_block(uid):
    parse()
    return success(runtime().contacts.set_block(principal(), uid, request.method == "PUT"))


@chat_blueprint.post("/api/v1/conversations/direct")
def direct():
    return success(runtime().chat.direct(principal(), parse(DirectInput).friendUserId), 201)


@chat_blueprint.get("/api/v1/conversations")
def conversations():
    return success(runtime().chat.list(principal(), *paging()))


@chat_blueprint.get("/api/v1/conversations/<cid>")
def conversation(cid):
    return success(runtime().chat.get(principal(), cid))


@chat_blueprint.route("/api/v1/conversations/<cid>/messages", methods=["GET", "POST"])
def messages(cid):
    if request.method == "POST":
        return success(runtime().chat.send(principal(), cid, parse(MessageInput)), 201)
    return success(
        runtime().chat.history(
            principal(),
            cid,
            request.args.get("beforeSeq"),
            request.args.get("afterSeq"),
            page_limit(request.args.get("limit", 50)),
        )
    )


@chat_blueprint.post("/api/v1/conversations/<cid>/read")
def read(cid):
    return success(runtime().chat.read(principal(), cid, parse(ReadInput).readSeq))


@chat_blueprint.patch("/api/v1/conversations/<cid>/preferences")
def preferences(cid):
    return success(
        runtime().chat.preferences(principal(), cid, parse(ConversationPreferencesInput))
    )


@chat_blueprint.get("/api/v1/sync/snapshot")
def snapshot():
    return success(runtime().events.snapshot(principal()))


@chat_blueprint.get("/api/v1/sync")
def sync():
    return success(
        runtime().events.sync(
            principal(), request.args.get("after", "0"), page_limit(request.args.get("limit", 100))
        )
    )


@chat_blueprint.get("/api/v1/notifications")
def notifications():
    return success(runtime().events.notifications(principal(), *paging()))


@chat_blueprint.post("/api/v1/notifications/<nid>/read")
def read_notification(nid):
    parse()
    return success(runtime().events.read_notification(principal(), nid))
