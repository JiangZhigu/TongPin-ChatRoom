from __future__ import annotations

import httpx
import pytest
from test_admin import ORIGIN
from test_admin import admin_app as admin_app  # noqa: PLC0414 -- shared controlled fixture

from tongpin.contracts.base import APIError
from tongpin.infra.db import now_ms

pytestmark = pytest.mark.asyncio
NAVIGATION = "/api/v1/account/navigation"


@pytest.mark.parametrize("index,expected", [(2, None), (0, {"href": "/admin"})])
async def test_navigation_matches_real_admin_authorization(admin_app, index, expected):
    app, _, tokens, _, _ = admin_app
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        client.cookies.set(app.runtime.auth.cookie_name, tokens[index])
        response = await client.get(NAVIGATION)
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {"admin": expected}
        assert response.headers["Cache-Control"] == "no-store"
        authorization = await client.get("/api/v1/admin/auth")
        assert authorization.status_code == (200 if expected else 403)


@pytest.mark.parametrize("missing", ["second_factor", "totp", "role"])
async def test_navigation_rechecks_admin_requirements_each_request(admin_app, missing):
    app, actors, tokens, _, _ = admin_app
    rt, actor = app.runtime, actors[0]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        client.cookies.set(rt.auth.cookie_name, tokens[0])
        assert (await client.get(NAVIGATION)).json()["data"] == {"admin": {"href": "/admin"}}
        with rt.db.write() as conn:
            if missing == "second_factor":
                conn.execute(
                    "UPDATE sessions SET second_factor_at=NULL WHERE id=?", (actor.session["id"],)
                )
            elif missing == "totp":
                conn.execute("UPDATE users SET totp_secret=NULL WHERE id=?", (actor.id,))
            else:
                conn.execute("UPDATE users SET site_role='user' WHERE id=?", (actor.id,))
        response = await client.get(NAVIGATION)
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {"admin": None if missing == "role" else {"href": "/admin"}}
        assert response.headers["Cache-Control"] == "no-store"
        assert (await client.get("/api/v1/admin/auth")).status_code == (403 if missing == "role" else 200)


@pytest.mark.parametrize("invalid", ["anonymous", "revoked", "expired", "idle"])
async def test_navigation_preserves_unauthenticated_errors(admin_app, invalid):
    app, actors, tokens, _, _ = admin_app
    rt, actor = app.runtime, actors[0]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        if invalid != "anonymous":
            client.cookies.set(rt.auth.cookie_name, tokens[0])
            assert (await client.get(NAVIGATION)).status_code == 200
            with rt.db.write() as conn:
                if invalid == "revoked":
                    conn.execute(
                        "UPDATE sessions SET revoked_at=? WHERE id=?",
                        (now_ms(), actor.session["id"]),
                    )
                elif invalid == "expired":
                    conn.execute(
                        "UPDATE sessions SET expires_at=? WHERE id=?",
                        (now_ms() - 1, actor.session["id"]),
                    )
                else:
                    conn.execute(
                        "UPDATE sessions SET last_seen_at=? WHERE id=?",
                        (now_ms() - actor.session["idle_ms"] - 1, actor.session["id"]),
                    )
        response = await client.get(NAVIGATION)
        assert response.status_code == 401, response.text
        assert response.json()["error"]["code"] == "AUTH_REQUIRED"
        assert "data" not in response.json()
        assert response.headers["Cache-Control"] == "no-store"


async def test_navigation_does_not_hide_other_authorization_errors(admin_app, monkeypatch):
    app, _, tokens, _, _ = admin_app

    def unavailable(_actor):
        raise APIError("TEMPORARY_UNAVAILABLE", "Isolated authorization failure", 503)

    monkeypatch.setattr(app.runtime.auth, "require_admin", unavailable)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=ORIGIN
    ) as client:
        client.cookies.set(app.runtime.auth.cookie_name, tokens[0])
        response = await client.get(NAVIGATION)
        assert response.status_code == 503, response.text
        assert response.json()["error"]["code"] == "TEMPORARY_UNAVAILABLE"
        assert "data" not in response.json()
