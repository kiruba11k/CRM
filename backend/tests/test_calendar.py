"""Google Calendar + Meet sync against a fake Google, plus booking links."""
import base64
import json
import re
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app import google_calendar as gc
from tests.conftest import ADMIN, MANAGER, REP, REP2, RAW_DB

KEY = "test-token-key"


# ── Pure helpers ──────────────────────────────────────────────────────

def test_state_is_signed_and_expires():
    state = gc.make_state(KEY, "user-1", now=1000)
    assert gc.read_state(KEY, state, now=1100) == "user-1"
    with pytest.raises(gc.CalendarError):
        gc.read_state(KEY, state[:-1] + ("0" if state[-1] != "0" else "1"), now=1100)
    with pytest.raises(gc.CalendarError):
        gc.read_state("other-key", state, now=1100)
    with pytest.raises(gc.CalendarError, match="too long"):
        gc.read_state(KEY, state, now=1000 + gc.STATE_TTL + 1)


def test_tokens_are_encrypted_and_event_ids_are_valid():
    enc = gc.encrypt(KEY, "refresh-secret")
    assert "refresh-secret" not in enc and gc.decrypt(KEY, enc) == "refresh-secret"
    with pytest.raises(gc.CalendarError):
        gc.decrypt("other-key", enc)
    assert re.fullmatch(r"[0-9a-v]{5,1024}", gc.event_id_for("0b5c6e1e-6f5a-4d1c-9a7e-1d2b3c4d5e6f"))


# ── Fake Google ───────────────────────────────────────────────────────

def _jwt(claims: dict) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


class FakeGoogle:
    def __init__(self):
        self.codes: dict[str, str] = {}
        self.revoked: set[str] = set()
        self.events: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.lose_insert_reply = 0
        self.fail_patch = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host == "oauth2.googleapis.com" and url.path == "/token":
            form = parse_qs(request.content.decode())
            assert form["client_secret"] == ["test-secret"]
            if form["grant_type"] == ["authorization_code"]:
                email = self.codes[form["code"][0]]
                return httpx.Response(200, json={
                    "access_token": f"at-{email}", "expires_in": 3600, "refresh_token": f"rt-{email}",
                    "scope": "openid https://www.googleapis.com/auth/calendar.events email",
                    "id_token": _jwt({"email": email, "email_verified": True, "hd": email.split("@")[1]})})
            rt = form["refresh_token"][0]
            if rt in self.revoked:
                return httpx.Response(400, json={"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
            return httpx.Response(200, json={"access_token": f"at-{rt}", "expires_in": 3600})
        if url.host == "oauth2.googleapis.com" and url.path == "/revoke":
            self.revoked.add(parse_qs(request.content.decode())["token"][0])
            return httpx.Response(200, json={})
        assert url.host == "www.googleapis.com" and request.headers["Authorization"].startswith("Bearer at-")
        assert request.headers["Authorization"][len("Bearer at-"):] not in {f"rt-{e}" for e in self.revoked}
        self.calls.append((request.method, url.path))
        event_id = url.path.rsplit("/", 1)[-1] if url.path.count("/") > 5 else None
        if request.method == "POST":
            body = json.loads(request.content)
            assert url.params["conferenceDataVersion"] == "1" and url.params["sendUpdates"] == "all"
            if body["id"] in self.events:
                return httpx.Response(409, json={"error": {"code": 409, "message": "The requested identifier already exists."}})
            self.events[body["id"]] = self._stored(body)
            if self.lose_insert_reply:
                self.lose_insert_reply -= 1
                return httpx.Response(503, json={"error": {"message": "Backend Error"}})
            return httpx.Response(200, json=self.events[body["id"]])
        if request.method == "PATCH":
            if self.fail_patch:
                self.fail_patch -= 1
                return httpx.Response(500, json={"error": {"message": "Backend Error"}})
            if event_id not in self.events:
                return httpx.Response(404, json={"error": {"message": "Not Found"}})
            self.events[event_id].update(self._stored({**json.loads(request.content), "id": event_id}, keep=self.events[event_id]))
            return httpx.Response(200, json=self.events[event_id])
        if request.method == "DELETE":
            if event_id not in self.events or self.events[event_id].get("status") == "cancelled":
                return httpx.Response(410, json={"error": {"message": "Resource has been deleted"}})
            self.events[event_id]["status"] = "cancelled"
            return httpx.Response(204)
        raise AssertionError(f"unexpected {request.method} {url}")

    @staticmethod
    def _stored(body: dict, keep: dict | None = None) -> dict:
        ev = {**(keep or {}), **body, "htmlLink": f"https://calendar.google.com/event?eid={body['id']}", "status": "confirmed"}
        if body.get("conferenceData", {}).get("createRequest"):
            ev["hangoutLink"] = f"https://meet.google.com/{body['id'][:3]}-{body['id'][3:7]}-{body['id'][7:10]}"
        return ev


@pytest.fixture()
def google(app, client):
    fake = FakeGoogle()
    app.state.google_transport = httpx.MockTransport(fake.handler)
    app.state.google = None
    yield fake
    app.state.google_transport = None
    app.state.google = None


def connect(client, fake, email):
    url = client.post("/api/calendar/connect", {}, as_=email).json()["url"]
    q = parse_qs(urlsplit(url).query)
    assert q["access_type"] == ["offline"] and "https://www.googleapis.com/auth/calendar.events" in q["scope"][0]
    assert q["redirect_uri"] == ["http://testserver/api/calendar/oauth/callback"] and q["login_hint"] == [email]
    code = f"code-{len(fake.codes)}"
    fake.codes[code] = email
    r = client.c.get("/api/calendar/oauth/callback", params={"state": q["state"][0], "code": code}, follow_redirects=False)
    assert r.status_code == 303
    return r.headers["location"]


def make_opp(client, as_=REP, account="Norvale Pharma"):
    acc = client.post("/api/accounts", {"name": account, "country": "Sweden"}, as_=as_).json()
    r = client.post("/api/opportunities", {"name": "Norvale · LinkedIn", "account_id": acc["id"], "next_action_code": "05", "next_action_due": "2030-01-01"}, as_=as_)
    return r.json()


def meeting_body(opp, **kw):
    body = {"entity_type": "opportunity", "entity_id": opp["id"], "title": "Norvale discovery", "starts_at": "2030-01-15T14:30:00+01:00",
            "duration_minutes": 45, "time_zone": "Europe/Stockholm", "attendees": ["Sofia@norvale.example"], "reminder_day": True}
    body.update(kw)
    return body


# ── API ───────────────────────────────────────────────────────────────

def test_connect_create_update_cancel(client, google):
    assert client.get("/api/calendar/status", as_=REP).json()["connected"] is False
    assert "calendar=connected" in connect(client, google, REP)
    status = client.get("/api/calendar/status", as_=REP).json()
    assert status["connected"] and status["connection"]["google_email"] == REP

    import asyncio, asyncpg  # noqa: E401

    async def stored():
        con = await asyncpg.connect(RAW_DB)
        try:
            return await con.fetchval("SELECT refresh_token_encrypted FROM calendar_connections")
        finally:
            await con.close()
    assert f"rt-{REP}" not in asyncio.run(stored())

    opp = make_opp(client)
    m = client.post("/api/meetings", meeting_body(opp), as_=REP).json()
    assert m["sync_status"] == "synced", m
    assert m["google_event_id"] == m["id"].replace("-", "") and m["meet_url"].startswith("https://meet.google.com/")
    ev = google.events[m["google_event_id"]]
    assert ev["attendees"] == [{"email": "sofia@norvale.example"}]
    assert ev["start"] == {"dateTime": "2030-01-15T13:30:00+00:00", "timeZone": "Europe/Stockholm"}
    assert ev["end"]["dateTime"] == "2030-01-15T14:15:00+00:00"
    assert ev["reminders"] == {"useDefault": False, "overrides": [{"method": "popup", "minutes": 15}, {"method": "popup", "minutes": 1440}]}
    assert f"/opportunities/{opp['id']}" in ev["description"]
    detail = client.get(f"/api/opportunities/{opp['id']}", as_=REP).json()
    assert any(a["summary"].startswith("Meeting scheduled: Norvale discovery · 15 Jan 2030, 14:30 Europe/Stockholm") for a in detail["activities"])

    r = client.patch(f"/api/meetings/{m['id']}", {"title": "Norvale scoping", "duration_minutes": 60}, as_=REP).json()
    assert r["sync_status"] == "synced"
    assert [c[0] for c in google.calls] == ["POST", "PATCH"], "an update must change the same event, never add one"
    assert google.events[m["google_event_id"]]["summary"] == "Norvale scoping" and len(google.events) == 1

    c = client.post(f"/api/meetings/{m['id']}/cancel", {}, as_=REP).json()
    assert c["sync_status"] == "cancelled" and google.events[m["google_event_id"]]["status"] == "cancelled"
    assert client.patch(f"/api/meetings/{m['id']}", {"title": "x"}, as_=REP).status_code == 409
    assert client.get("/api/meetings", as_=REP).json() == []


def test_failures_are_visible_and_retry_never_duplicates(client, google):
    connect(client, google, REP)
    opp = make_opp(client)
    google.lose_insert_reply = 1  # Google creates the event but the reply is lost
    m = client.post("/api/meetings", meeting_body(opp), as_=REP).json()
    assert m["sync_status"] == "failed" and "503" in m["sync_error"]
    r = client.post(f"/api/meetings/{m['id']}/retry", {}, as_=REP).json()
    assert r["sync_status"] == "synced" and r["sync_error"] is None
    assert len(google.events) == 1 and [c[0] for c in google.calls] == ["POST", "POST", "PATCH"]

    google.fail_patch = 1
    r = client.patch(f"/api/meetings/{m['id']}", {"title": "Moved"}, as_=REP).json()
    assert r["sync_status"] == "failed"
    log = client.get("/api/calendar/sync-status", as_=REP).json()["log"]
    assert [entry["ok"] for entry in log[:2]] == [False, True] and "500" in log[0]["message"]
    assert client.post(f"/api/meetings/{m['id']}/retry", {}, as_=REP).json()["sync_status"] == "synced"
    assert google.events[r["google_event_id"]]["summary"] == "Moved" and len(google.events) == 1


def test_not_connected_meetings_sync_once_connected(client, google):
    opp = make_opp(client, as_=REP2)
    m = client.post("/api/meetings", meeting_body(opp), as_=REP2).json()
    assert m["sync_status"] == "not_connected" and "hasn’t connected" in m["sync_error"] and not google.calls
    connect(client, google, REP2)
    assert client.get(f"/api/meetings/{m['id']}", as_=REP2).json()["sync_status"] == "synced"


def test_revoked_access_asks_to_reconnect(client, google):
    connect(client, google, REP)
    google.revoked.add(f"rt-{REP}")
    m = client.post("/api/meetings", meeting_body(make_opp(client)), as_=REP).json()
    assert m["sync_status"] == "failed" and "reconnect" in m["sync_error"]
    assert client.get("/api/calendar/status", as_=REP).json()["connected"] is False
    # Next meeting says so plainly instead of trying again.
    m2 = client.post("/api/meetings", meeting_body(make_opp(client, account="Oriel Packaging"), title="Second"), as_=REP)
    assert m2.status_code == 201 and m2.json()["sync_status"] == "not_connected"
    google.revoked.clear()
    connect(client, google, REP)
    assert {x["sync_status"] for x in client.get("/api/meetings", as_=REP).json()} == {"synced"}


def test_wrong_google_account_or_bad_state_is_rejected(client, google):
    url = client.post("/api/calendar/connect", {}, as_=REP).json()["url"]
    state = parse_qs(urlsplit(url).query)["state"][0]
    google.codes["c"] = REP2
    r = client.c.get("/api/calendar/oauth/callback", params={"state": state, "code": "c"}, follow_redirects=False)
    assert "calendar=error" in r.headers["location"] and "rep2" in r.headers["location"]
    r = client.c.get("/api/calendar/oauth/callback", params={"state": "forged.123", "code": "c"}, follow_redirects=False)
    assert "calendar=error" in r.headers["location"]
    r = client.c.get("/api/calendar/oauth/callback", params={"error": "access_denied"}, follow_redirects=False)
    assert "declined" in r.headers["location"]
    assert client.get("/api/calendar/status", as_=REP).json()["connected"] is False


def test_disconnect_revokes(client, google):
    connect(client, google, REP)
    assert client.post("/api/calendar/disconnect", {}, as_=REP).json() == {"ok": True}
    assert f"rt-{REP}" in google.revoked and client.get("/api/calendar/status", as_=REP).json()["connection"] is None


def test_meeting_validation_and_permissions(client, google):
    opp = make_opp(client)
    r = client.post("/api/meetings", {"title": "", "attendees": ["not-an-email"], "time_zone": "Mars/Base", "starts_at": "2030-01-15T14:30:00"}, as_=REP)
    fields = {e["field"] for e in r.json()["detail"]["errors"]}
    assert r.status_code == 422 and fields == {"title", "attendees", "time_zone", "starts_at"}
    m = client.post("/api/meetings", meeting_body(opp), as_=REP).json()
    assert client.patch(f"/api/meetings/{m['id']}", {"title": "Mine now"}, as_=REP2).status_code == 403
    assert client.post(f"/api/meetings/{m['id']}/cancel", {}, as_=REP2).status_code == 403
    assert client.patch(f"/api/meetings/{m['id']}", {"title": "Manager edit"}, as_=MANAGER).status_code == 200
    # Everyone sees meetings on a record they open.
    on_record = client.get("/api/meetings", params={"entity_type": "opportunity", "entity_id": opp["id"]}, as_=REP2).json()
    assert [x["title"] for x in on_record] == ["Manager edit"]


def test_sync_status_scope(client, google):
    connect(client, google, REP)
    client.get("/api/me", as_=REP2)
    mine = client.get("/api/calendar/sync-status", as_=REP).json()
    assert [u["email"] for u in mine["users"]] == [REP]
    team = {u["email"]: u for u in client.get("/api/calendar/sync-status", as_=MANAGER).json()["users"]}
    assert team[REP]["status"] == "connected" and team[REP2]["status"] is None


def test_calendar_not_configured(client, app):
    from app.config import Settings, get_settings

    app.dependency_overrides[get_settings] = lambda: Settings(dev_auth=True, admin_emails=ADMIN, google_client_id="x", google_client_secret="")
    try:
        r = client.post("/api/calendar/connect", {}, as_=REP)
        assert r.status_code == 503 and "CRM_GOOGLE_CLIENT_SECRET" in r.json()["detail"]
        m = client.post("/api/meetings", meeting_body(make_opp(client)), as_=REP).json()
        assert m["sync_status"] == "not_connected" and "isn’t set up" in m["sync_error"]
    finally:
        app.dependency_overrides.clear()


def test_booking_links_are_shared(client):
    bad = client.post("/api/booking-links", {"name": "Call", "url": "https://example.com/x"}, as_=REP)
    assert bad.status_code == 422
    link = client.post("/api/booking-links", {"name": "30-min discovery", "url": "https://calendar.app.google/abc123"}, as_=REP).json()
    assert [x["name"] for x in client.get("/api/booking-links", as_=REP2).json()] == ["30-min discovery"]
    assert client.c.delete(f"/api/booking-links/{link['id']}", headers={"X-Dev-User": REP2}).status_code == 403
    assert client.patch(f"/api/booking-links/{link['id']}", {"active": False}, as_=REP).json()["active"] is False
    assert client.c.delete(f"/api/booking-links/{link['id']}", headers={"X-Dev-User": ADMIN}).json() == {"ok": True}
