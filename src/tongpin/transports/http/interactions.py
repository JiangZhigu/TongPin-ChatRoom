from __future__ import annotations

from flask import Blueprint, request

from tongpin.contracts.interactions import (
    DeleteAccountInput,
    ModerationInput,
    ReportInput,
    TypingInput,
)
from tongpin.transports.http.auth import parse, principal, runtime, success
from tongpin.transports.http.chat import paging

interactions_blueprint = Blueprint("interactions", __name__)


@interactions_blueprint.get("/api/v1/messages/search")
def search():
    return success(
        runtime().interactions.search(
            principal(),
            request.args.get("q", ""),
            request.args.get("conversationId", ""),
            *paging(),
        )
    )


@interactions_blueprint.get("/api/v1/messages/<mid>")
def message(mid):
    return success(runtime().interactions.get(principal(), mid))


@interactions_blueprint.get("/api/v1/messages/<mid>/context")
def context(mid):
    return success(runtime().interactions.context(principal(), mid))


@interactions_blueprint.get("/api/v1/bookmarks")
def bookmarks():
    return success(runtime().interactions.bookmarks(principal(), *paging()))


@interactions_blueprint.route("/api/v1/messages/<mid>/bookmark", methods=["PUT", "DELETE"])
def bookmark(mid):
    parse()
    return success(runtime().interactions.bookmark(principal(), mid, request.method == "PUT"))


@interactions_blueprint.route("/api/v1/messages/<mid>/reactions/<key>", methods=["PUT", "DELETE"])
def reaction(mid, key):
    parse()
    return success(runtime().interactions.reaction(principal(), mid, key, request.method == "PUT"))


@interactions_blueprint.post("/api/v1/messages/<mid>/recall")
def recall(mid):
    parse()
    return success(runtime().interactions.remove(principal(), mid))


@interactions_blueprint.post("/api/v1/messages/<mid>/moderate")
def moderate(mid):
    return success(
        runtime().interactions.remove(
            principal(), mid, moderation=True, reason=parse(ModerationInput).reason
        )
    )


@interactions_blueprint.route("/api/v1/conversations/<cid>/typing", methods=["GET", "POST"])
def typing(cid):
    return success(
        runtime().interactions.typing(
            principal(), cid, parse(TypingInput).active if request.method == "POST" else None
        )
    )


@interactions_blueprint.route("/api/v1/reports", methods=["GET", "POST"])
def reports():
    if request.method == "POST":
        return success(runtime().interactions.report(principal(), parse(ReportInput)), 201)
    return success(runtime().interactions.reports(principal(), *paging()))


@interactions_blueprint.get("/api/v1/account/deletion-preview")
def deletion_preview():
    return success(runtime().lifecycle.deletion_preview(principal()))


@interactions_blueprint.post("/api/v1/account/delete")
def delete_account():
    service = runtime()
    return success(
        service.lifecycle.deletion_request(
            request.cookies.get(service.auth.cookie_name, ""), parse(DeleteAccountInput)
        )
    )
