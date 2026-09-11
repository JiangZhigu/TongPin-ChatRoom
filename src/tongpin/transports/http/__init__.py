from __future__ import annotations

import logging
import secrets
import sqlite3
import time

from flask import Flask, g, jsonify, request, send_from_directory
from pydantic import ValidationError
from werkzeug.exceptions import HTTPException

from tongpin import __version__
from tongpin.contracts.base import APIError


def create_http_app(runtime):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        MAX_CONTENT_LENGTH=runtime.settings.upload_limit,
        MAX_FORM_MEMORY_SIZE=256 * 1024,
        MAX_FORM_PARTS=20,
        PROPAGATE_EXCEPTIONS=False,
    )
    app.extensions["tongpin"] = runtime

    @app.before_request
    def before_request():
        g.request_id = secrets.token_hex(12)
        g.started_at = time.perf_counter()
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("Origin")
            if origin not in runtime.settings.origins:
                raise APIError("ORIGIN_REJECTED", "请求来源不受信任。", 403)
        if not runtime.ready and not request.path.startswith("/health/"):
            raise APIError("TEMPORARY_UNAVAILABLE", "服务正在准备，请稍后重试。", 503)

    @app.after_request
    def after_request(response):
        response.headers["X-Request-ID"] = g.get("request_id", "")
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
        )
        if request.path.startswith(("/api/", "/health/")):
            response.headers["Cache-Control"] = "no-store"
        if runtime.settings.production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        runtime.metrics.request(
            response.status_code,
            (time.perf_counter() - g.get("started_at", time.perf_counter())) * 1000,
        )
        return response

    @app.errorhandler(APIError)
    def api_error(error):
        response = jsonify(error.payload(g.get("request_id", secrets.token_hex(12))))
        response.status_code = error.status
        if error.retry_after_ms:
            response.headers["Retry-After"] = str(max(1, error.retry_after_ms // 1000))
        return response

    @app.errorhandler(ValidationError)
    def invalid_input(error):
        fields = {
            ".".join(map(str, item["loc"])): "请检查此字段的格式。"
            for item in error.errors(include_input=False)
        }
        return api_error(APIError("VALIDATION_ERROR", "输入内容不符合要求。", 422, fields))

    @app.errorhandler(HTTPException)
    def http_error(error):
        messages = {
            400: "请求格式无效。",
            404: "内容不存在或不可访问。",
            405: "此操作不受支持。",
            413: "请求内容超过允许大小。",
        }
        return api_error(
            APIError(
                "RESOURCE_UNAVAILABLE" if error.code == 404 else "INVALID_REQUEST",
                messages.get(error.code, "请求无法完成。"),
                error.code or 500,
            )
        )

    @app.errorhandler(sqlite3.OperationalError)
    def sqlite_error(error):
        logging.getLogger("tongpin").error("Database operation unavailable")
        return api_error(APIError("TEMPORARY_UNAVAILABLE", "数据服务暂不可用，请稍后重试。", 503))

    @app.errorhandler(Exception)
    def unexpected_error(error):
        logging.getLogger("tongpin").error(
            "Unhandled request error %s [%s]", type(error).__name__, g.get("request_id", "")
        )
        return api_error(APIError("INTERNAL_ERROR", "服务暂时无法完成此操作。", 500))

    def success(data, status=200):
        return jsonify({"data": data, "requestId": g.request_id}), status

    @app.get("/health/live")
    def live():
        return success({"status": "live", "version": __version__, "features": runtime.features})

    @app.get("/health/ready")
    def ready():
        if not runtime.ready:
            raise APIError("TEMPORARY_UNAVAILABLE", "服务尚未就绪。", 503)
        runtime.db.health()
        return success({"status": "ready", "version": __version__, "features": runtime.features})

    @app.get("/api/v1/auth/bootstrap")
    def bootstrap():
        return success({"accountsEnabled": False, "registrationMode": "closed"})

    @app.route(
        "/api/v1/admin", defaults={"path": ""}, methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
    )
    @app.route("/api/v1/admin/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def admin_disabled(path):
        raise APIError("ADMIN_UNAVAILABLE", "管理服务尚未启用。", 503)

    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def frontend(path):
        if path.startswith(("api/", "health/", "socket.io/")):
            raise APIError("RESOURCE_UNAVAILABLE", "内容不存在或不可访问。", 404)
        dist = runtime.settings.web_dist.resolve()
        target = (dist / path).resolve()
        if path and target.is_file() and target.is_relative_to(dist):
            return send_from_directory(dist, path)
        if (dist / "index.html").is_file():
            return send_from_directory(dist, "index.html")
        return success(
            {"status": "frontend_not_built", "message": "前端尚未构建，请运行项目构建入口。"}, 503
        )

    return app
