from __future__ import annotations

import hmac
import secrets

from flask import Blueprint, current_app, g, jsonify, request

from tongpin.contracts.admin_s3 import EnrollmentFinish, EnrollmentStart
from tongpin.contracts.auth import (
    LoginInput,
    PasswordInput,
    PreferencesInput,
    ProfileInput,
    ReauthInput,
    RecoverInput,
    RegisterInput,
    SensitiveInput,
)
from tongpin.contracts.base import APIError, InputModel
from tongpin.domain.auth import public_user

auth_blueprint = Blueprint("auth", __name__)


def runtime():
    return current_app.extensions["tongpin"]


def principal(admin=False):
    if not hasattr(g, "principal"):
        service = runtime().auth
        g.principal = service.load(request.cookies.get(service.cookie_name, ""))
    return runtime().auth.require_admin(g.principal) if admin else g.principal


def success(data, status=200):
    response = jsonify({"data": data, "requestId": g.request_id})
    response.status_code = status
    return response


def parse(model=InputModel):
    return model.model_validate(request.get_json())


@auth_blueprint.get('/api/v1/account/admin-enrollment')
def admin_enrollment():
    return success(runtime().admin.enrollment_status(principal()))


@auth_blueprint.post('/api/v1/account/admin-enrollment/start')
def admin_enrollment_start():
    return success(runtime().admin.enrollment_start(principal(), parse(EnrollmentStart)))


@auth_blueprint.post('/api/v1/account/admin-enrollment/finish')
def admin_enrollment_finish():
    return success(runtime().admin.enrollment_finish(principal(), parse(EnrollmentFinish)))


@auth_blueprint.get('/api/v1/announcements/<aid>')
def system_notice(aid):
    return success(runtime().admin.system_notice(principal(), aid))


def require_csrf():
    service = runtime().auth
    if service is None:
        return
    provided = request.headers.get("X-CSRF-Token", "")
    token = request.cookies.get(service.cookie_name, "")
    flow = request.cookies.get(service.flow_cookie_name, "")
    public_auth = request.path in {
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/auth/recover",
    }
    candidates = [value for value in ((token, flow) if public_auth else (token,)) if value]
    if not candidates or not any(
        hmac.compare_digest(provided, service.security.csrf(value)) for value in candidates
    ):
        raise APIError("CSRF_REJECTED", "页面验证已失效，请刷新后重试。", 403)


def flow_token():
    flow = request.cookies.get(runtime().auth.flow_cookie_name, "")
    if not 32 <= len(flow) <= 128:
        raise APIError("FLOW_EXPIRED", "页面流程已失效，请刷新后重试。", 403)
    return flow


def session_response(token, data, remember=False, status=200):
    response = success(data, status)
    response.set_cookie(
        runtime().auth.cookie_name,
        token,
        httponly=True,
        secure=runtime().settings.production,
        samesite="Lax",
        path="/",
        max_age=30 * 86400 if remember else None,
    )
    return response


@auth_blueprint.get("/api/v1/auth/bootstrap")
def bootstrap():
    app = runtime()
    service = app.auth
    if service is None:
        return success({"accountsEnabled": False, "registrationMode": "closed"})
    flow = request.cookies.get(service.flow_cookie_name, "")
    if not 32 <= len(flow) <= 128:
        flow = secrets.token_urlsafe(32)
    credential, user = flow, None
    try:
        actor = principal()
        user = public_user(actor.user)
        credential = request.cookies[service.cookie_name]
    except APIError as error:
        if error.code != "AUTH_REQUIRED":
            raise
    response = success(
        {
            "accountsEnabled": True,
            "registrationMode": app.policy.get()["registration_mode"],
            "csrfToken": service.security.csrf(credential),
            "user": user,
            "terms": app.policy.terms(),
        }
    )
    response.set_cookie(
        service.flow_cookie_name,
        flow,
        httponly=True,
        secure=app.settings.production,
        samesite="Lax",
        path="/",
        max_age=7200,
    )
    return response


@auth_blueprint.get("/api/v1/auth/captcha")
def captcha():
    return success(
        runtime().auth.security.new_captcha(flow_token(), request.remote_addr or "unknown")
    )


@auth_blueprint.post("/api/v1/auth/register")
def register():
    token, data = runtime().auth.register(
        parse(RegisterInput),
        flow_token(),
        request.remote_addr or "unknown",
        request.user_agent.string,
    )
    return session_response(token, data, status=201)


@auth_blueprint.post("/api/v1/auth/login")
def login():
    data = parse(LoginInput)
    token, result = runtime().auth.login(
        data,
        flow_token(),
        request.remote_addr or "unknown",
        request.user_agent.string,
        request.cookies.get(runtime().auth.cookie_name, ""),
    )
    return session_response(token, result, data.remember)


@auth_blueprint.post("/api/v1/auth/recover")
def recover():
    return success(
        runtime().auth.recover(
            parse(RecoverInput),
            flow_token(),
            request.remote_addr or "unknown",
            request.user_agent.string,
        )
    )


@auth_blueprint.get("/api/v1/auth/me")
def me():
    actor = principal()
    token = request.cookies[runtime().auth.cookie_name]
    return success(
        {
            "user": public_user(actor.user),
            "csrfToken": runtime().auth.security.csrf(token),
            "expiresAt": actor.session["expires_at"],
        }
    )


@auth_blueprint.post("/api/v1/auth/logout")
def logout():
    parse()
    response = success(runtime().auth.logout(principal()))
    response.delete_cookie(
        runtime().auth.cookie_name,
        path="/",
        secure=runtime().settings.production,
        httponly=True,
        samesite="Lax",
    )
    return response


@auth_blueprint.post("/api/v1/auth/reauth")
def reauth():
    return success(runtime().auth.reauth(principal(), parse(ReauthInput)))


@auth_blueprint.post("/api/v1/auth/ws-ticket")
def ws_ticket():
    parse()
    return success(runtime().auth.websocket_ticket(principal()))


@auth_blueprint.patch("/api/v1/account/profile")
def profile():
    return success(runtime().auth.profile(principal(), parse(ProfileInput)))


@auth_blueprint.patch("/api/v1/account/preferences")
def preferences():
    return success(runtime().auth.preferences(principal(), parse(PreferencesInput)))


@auth_blueprint.get("/api/v1/account/sessions")
def sessions():
    return success(runtime().auth.sessions(principal()))


@auth_blueprint.delete("/api/v1/account/sessions/<session_id>")
def revoke_session(session_id):
    return success(
        runtime().auth.revoke_session(principal(), session_id, parse(SensitiveInput).reauthToken)
    )


@auth_blueprint.post("/api/v1/account/password")
def password():
    response = success(runtime().auth.change_password(principal(), parse(PasswordInput)))
    response.delete_cookie(
        runtime().auth.cookie_name,
        path="/",
        secure=runtime().settings.production,
        httponly=True,
        samesite="Lax",
    )
    return response


@auth_blueprint.post("/api/v1/account/recovery-codes")
def recovery_codes():
    return success(runtime().auth.regenerate_codes(principal(), parse(SensitiveInput).reauthToken))


@auth_blueprint.get("/api/v1/account/security-events")
def security_events():
    return success(runtime().auth.security_events(principal()))


@auth_blueprint.get("/api/v1/admin/auth")
def admin_auth():
    return success({"user": public_user(principal(admin=True).user), "secondFactorRequired": True})
