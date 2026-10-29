"""
backend/app/google_calendar.py - per-user Google Calendar access (§6).

Each user connects their own calendar with Google's OAuth authorization-code
flow (offline access, scope calendar.events). The refresh token is stored
encrypted with a key derived from CRM_TOKEN_KEY; short-lived access tokens
are kept in memory only. Events are created with a client-chosen ID (the
CRM meeting ID), so a retried create can never produce a second event.
"""
import base64
import hashlib
import hmac
import json
import time
from typing import Optional
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"]
STATE_TTL = 600


class CalendarError(Exception):
    """`reconnect` = the user must authorise again (revoked or expired grant)."""

    def __init__(self, message: str, status: int = 0, reconnect: bool = False):
        super().__init__(message)
        self.message, self.status, self.reconnect = message, status, reconnect


# ── Secrets ───────────────────────────────────────────────────────────

def _key(secret: str, purpose: bytes) -> bytes:
    return hashlib.sha256(purpose + b":" + secret.encode()).digest()


def fernet(secret: str) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(_key(secret, b"token-encryption")))


def encrypt(secret: str, value: str) -> str:
    return fernet(secret).encrypt(value.encode()).decode()


def decrypt(secret: str, value: str) -> str:
    try:
        return fernet(secret).decrypt(value.encode()).decode()
    except InvalidToken as e:
        raise CalendarError("Stored Google credentials can’t be read (CRM_TOKEN_KEY changed?). Reconnect Google Calendar.", reconnect=True) from e


def make_state(secret: str, user_id: str, now: Optional[float] = None) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"u": user_id, "t": int(now or time.time())}).encode()).decode().rstrip("=")
    sig = hmac.new(_key(secret, b"oauth-state"), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def read_state(secret: str, state: str, now: Optional[float] = None) -> str:
    """Return the user ID in a valid, unexpired state, else raise."""
    try:
        payload, sig = state.split(".", 1)
    except ValueError as e:
        raise CalendarError("Invalid sign-in state.") from e
    good = hmac.new(_key(secret, b"oauth-state"), payload.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, good):
        raise CalendarError("Invalid sign-in state.")
    data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    if (now or time.time()) - data["t"] > STATE_TTL:
        raise CalendarError("The Google sign-in took too long. Try connecting again.")
    return data["u"]


def auth_url(client_id: str, redirect_uri: str, state: str, login_hint: str, domain: str) -> str:
    return AUTH_URL + "?" + urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code", "scope": " ".join(SCOPES),
        "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
        "state": state, "login_hint": login_hint, "hd": domain,
    })


def id_token_claims(id_token: str) -> dict:
    """Claims of an ID token received directly from Google's token endpoint
    over TLS (so its signature needn't be re-checked, per Google's docs)."""
    try:
        part = id_token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError) as e:
        raise CalendarError("Google returned an unreadable ID token.") from e


# ── HTTP ──────────────────────────────────────────────────────────────

def _google_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200]
    err = body.get("error")
    if isinstance(err, dict):
        return err.get("message") or json.dumps(err)[:200]
    return body.get("error_description") or str(err or body)[:200]


class Google:
    """Token exchange/refresh and Calendar event calls for one deployment.
    Access tokens are cached in memory per refresh token."""

    def __init__(self, client_id: str, client_secret: str, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.client_id, self.client_secret = client_id, client_secret
        self._c = httpx.AsyncClient(timeout=20, transport=transport)
        self._access: dict[str, tuple[str, float]] = {}

    async def aclose(self) -> None:
        await self._c.aclose()

    async def _post_token(self, data: dict) -> dict:
        try:
            resp = await self._c.post(TOKEN_URL, data={**data, "client_id": self.client_id, "client_secret": self.client_secret})
        except httpx.TransportError as e:
            raise CalendarError(f"Couldn’t reach Google: {e}", 503) from e
        if resp.status_code >= 400:
            msg = _google_message(resp)
            reconnect = "invalid_grant" in resp.text
            raise CalendarError(
                "Google access was revoked or expired: reconnect Google Calendar." if reconnect else f"Google sign-in failed: {msg}",
                resp.status_code, reconnect)
        return resp.json()

    async def exchange_code(self, code: str, redirect_uri: str) -> dict:
        return await self._post_token({"code": code, "redirect_uri": redirect_uri, "grant_type": "authorization_code"})

    async def access_token(self, refresh_token: str) -> str:
        cached = self._access.get(refresh_token)
        if cached and cached[1] > time.time() + 60:
            return cached[0]
        data = await self._post_token({"refresh_token": refresh_token, "grant_type": "refresh_token"})
        self._access[refresh_token] = (data["access_token"], time.time() + int(data.get("expires_in", 3600)))
        return data["access_token"]

    async def revoke(self, refresh_token: str) -> None:
        self._access.pop(refresh_token, None)
        try:
            await self._c.post(REVOKE_URL, data={"token": refresh_token})
        except httpx.TransportError:
            pass  # best effort: the stored token is deleted either way

    async def _call(self, refresh_token: str, method: str, url: str, **kw) -> Optional[dict]:
        token = await self.access_token(refresh_token)
        try:
            resp = await self._c.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
        except httpx.TransportError as e:
            raise CalendarError(f"Couldn’t reach Google Calendar: {e}", 503) from e
        if resp.status_code == 401:
            self._access.pop(refresh_token, None)
            raise CalendarError("Google Calendar rejected the saved access: reconnect Google Calendar.", 401, reconnect=True)
        if resp.status_code >= 400:
            raise CalendarError(f"Google Calendar returned {resp.status_code}: {_google_message(resp)}", resp.status_code)
        return resp.json() if resp.content else None

    async def insert_event(self, refresh_token: str, body: dict) -> dict:
        return await self._call(refresh_token, "POST", EVENTS_URL, params={"conferenceDataVersion": 1, "sendUpdates": "all"}, json=body)

    async def patch_event(self, refresh_token: str, event_id: str, body: dict) -> dict:
        return await self._call(refresh_token, "PATCH", f"{EVENTS_URL}/{event_id}", params={"conferenceDataVersion": 1, "sendUpdates": "all"}, json=body)

    async def delete_event(self, refresh_token: str, event_id: str) -> None:
        try:
            await self._call(refresh_token, "DELETE", f"{EVENTS_URL}/{event_id}", params={"sendUpdates": "all"})
        except CalendarError as e:
            if e.status not in (404, 410):  # already gone counts as cancelled
                raise


def event_id_for(meeting_id: str) -> str:
    """Google event IDs use base32hex (0-9, a-v); a UUID's hex digits qualify."""
    return meeting_id.replace("-", "")


def event_body(m: dict, link: Optional[str], with_id: bool) -> dict:
    reminders = [{"method": "popup", "minutes": 15}] if m["reminder_15"] else []
    if m["reminder_day"]:
        reminders.append({"method": "popup", "minutes": 24 * 60})
    description = m.get("description") or ""
    if link:
        description = f"{description}\n\nLeadStrategus CRM: {link}".strip()
    body = {
        "summary": m["title"],
        "description": description,
        "start": {"dateTime": m["starts_at"].isoformat(), "timeZone": m["time_zone"]},
        "end": {"dateTime": m["ends_at"].isoformat(), "timeZone": m["time_zone"]},
        "attendees": [{"email": a} for a in m["attendees"]],
        "reminders": {"useDefault": False, "overrides": reminders},
        "extendedProperties": {"private": {"crm_meeting_id": str(m["id"])}},
    }
    if with_id:
        body["id"] = event_id_for(str(m["id"]))
    if m["add_meet"] and not m.get("meet_url"):
        body["conferenceData"] = {"createRequest": {"requestId": str(m["id"]), "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
    return body


def meet_link(event: dict) -> Optional[str]:
    if event.get("hangoutLink"):
        return event["hangoutLink"]
    for ep in (event.get("conferenceData") or {}).get("entryPoints", []):
        if ep.get("entryPointType") == "video":
            return ep.get("uri")
    return None
