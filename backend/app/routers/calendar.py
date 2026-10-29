"""Google Calendar + Meet sync, meetings and shared booking links (§6).

Meetings are saved in the CRM first, then pushed to the owner's own Google
Calendar. A sync is reported as done only after Google confirms it;
failures are stored on the meeting, logged, and can be retried.
"""
import re
from datetime import timedelta
from typing import Literal, Optional
from urllib.parse import urlencode
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from .. import domain, google_calendar as gc
from ..auth import User, current_user, get_con
from ..config import Settings, get_settings
from ..records import log_activity, raise_if_errors
from ..schemas import BookingLinkIn, BookingLinkPatch, MeetingIn, MeetingPatch

router = APIRouter(tags=["calendar"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
BOOKING_RE = re.compile(r"^https://(calendar\.app\.google|calendar\.google\.com)/\S+$")
_PATH = {"account": "accounts", "prospect": "prospects", "opportunity": "opportunities"}
_TABLE = {"account": ("accounts", "name"), "prospect": ("prospects", "full_name"), "opportunity": ("opportunities", "name")}

_MEETING_SQL = """
SELECT m.*, u.name AS owner_name,
       CASE m.entity_type
         WHEN 'account' THEN (SELECT name FROM accounts WHERE id = m.entity_id)
         WHEN 'prospect' THEN (SELECT full_name FROM prospects WHERE id = m.entity_id)
         WHEN 'opportunity' THEN (SELECT name FROM opportunities WHERE id = m.entity_id)
       END AS entity_name
FROM meetings m JOIN users u ON u.id = m.owner_id
"""


def _google(request: Request, settings: Settings) -> gc.Google:
    missing = settings.calendar_missing
    if missing:
        raise HTTPException(503, f"Google Calendar sync isn’t set up on the server yet (missing {', '.join(missing)}).")
    g = getattr(request.app.state, "google", None)
    if g is None:
        g = gc.Google(settings.google_client_id, settings.google_client_secret, getattr(request.app.state, "google_transport", None))
        request.app.state.google = g
    return g


# ── Sync ──────────────────────────────────────────────────────────────

async def _log(con: asyncpg.Connection, meeting_id: Optional[UUID], user_id: UUID, action: str, ok: bool, message: str) -> None:
    await con.execute("INSERT INTO calendar_sync_log(meeting_id, user_id, action, ok, message) VALUES ($1, $2, $3, $4, $5)",
                      meeting_id, user_id, action, ok, message)


async def sync_meeting(con: asyncpg.Connection, google: gc.Google, settings: Settings, meeting_id: UUID, action: str) -> dict:
    m = dict(await con.fetchrow("SELECT * FROM meetings WHERE id = $1", meeting_id))
    conn = await con.fetchrow("SELECT * FROM calendar_connections WHERE user_id = $1", m["owner_id"])
    if conn is None or conn["status"] != "connected":
        if m["cancelled"] and not m["google_event_id"]:
            await con.execute("UPDATE meetings SET sync_status = 'cancelled', sync_error = NULL WHERE id = $1", meeting_id)
            return await _meeting(con, meeting_id)
        owner = await con.fetchval("SELECT name FROM users WHERE id = $1", m["owner_id"])
        msg = (f"{owner} hasn’t connected Google Calendar." if conn is None
               else f"{owner}’s Google Calendar access expired: reconnect it, then retry.")
        await con.execute("UPDATE meetings SET sync_status = 'not_connected', sync_error = $2 WHERE id = $1", meeting_id, msg)
        await _log(con, meeting_id, m["owner_id"], action, False, msg)
        return await _meeting(con, meeting_id)

    link = f"{settings.app_url}/{_PATH[m['entity_type']]}/{m['entity_id']}" if m["entity_type"] else None
    try:
        refresh = gc.decrypt(settings.token_key, conn["refresh_token_encrypted"])
        if m["cancelled"]:
            if m["google_event_id"]:
                await google.delete_event(refresh, m["google_event_id"])
            await con.execute("UPDATE meetings SET sync_status = 'cancelled', sync_error = NULL, synced_at = now() WHERE id = $1", meeting_id)
            message = "Cancelled in Google Calendar; attendees notified." if m["google_event_id"] else "Cancelled (was never in Google Calendar)."
        else:
            if m["google_event_id"]:
                event = await google.patch_event(refresh, m["google_event_id"], gc.event_body(m, link, with_id=False))
                message = f"Updated Google Calendar event {event['id']}."
            else:
                try:
                    event = await google.insert_event(refresh, gc.event_body(m, link, with_id=True))
                    message = f"Created Google Calendar event {event['id']}."
                except gc.CalendarError as e:
                    if e.status != 409:
                        raise
                    # An earlier attempt did create it (e.g. the reply was lost): update that one.
                    event = await google.patch_event(refresh, gc.event_id_for(str(meeting_id)), gc.event_body(m, link, with_id=False))
                    message = f"Found the event from an earlier attempt and updated it ({event['id']})."
            await con.execute(
                "UPDATE meetings SET google_event_id = $2, html_link = $3, meet_url = coalesce($4, meet_url), "
                "sync_status = 'synced', sync_error = NULL, synced_at = now() WHERE id = $1",
                meeting_id, event["id"], event.get("htmlLink"), gc.meet_link(event))
        await con.execute("UPDATE calendar_connections SET last_sync_at = now(), last_error = NULL WHERE user_id = $1", m["owner_id"])
        await _log(con, meeting_id, m["owner_id"], action, True, message)
    except gc.CalendarError as e:
        await con.execute("UPDATE meetings SET sync_status = 'failed', sync_error = $2 WHERE id = $1", meeting_id, e.message)
        await con.execute(
            "UPDATE calendar_connections SET last_error = $2, status = CASE WHEN $3 THEN 'needs_reconnect' ELSE status END WHERE user_id = $1",
            m["owner_id"], e.message, e.reconnect)
        await _log(con, meeting_id, m["owner_id"], action, False, e.message)
    return await _meeting(con, meeting_id)


async def _meeting(con: asyncpg.Connection, meeting_id: UUID) -> dict:
    row = await con.fetchrow(_MEETING_SQL + " WHERE m.id = $1", meeting_id)
    if row is None:
        raise HTTPException(404, "Meeting not found.")
    return dict(row)


# ── Connect / disconnect ──────────────────────────────────────────────

@router.get("/calendar/status")
async def status(con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    row = await con.fetchrow("SELECT google_email, status, connected_at, last_sync_at, last_error FROM calendar_connections WHERE user_id = $1", UUID(user.id))
    return {"configured": not settings.calendar_missing, "missing": settings.calendar_missing,
            "connected": row is not None and row["status"] == "connected", "connection": dict(row) if row else None}


@router.post("/calendar/connect")
async def connect(request: Request, settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    _google(request, settings)
    state = gc.make_state(settings.token_key, user.id)
    return {"url": gc.auth_url(settings.google_client_id, settings.calendar_redirect_uri, state, user.email, settings.allowed_domain)}


@router.get("/calendar/oauth/callback", include_in_schema=False)
async def oauth_callback(request: Request, state: str = "", code: str = "", error: str = "",
                         con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings)):
    """Google redirects the browser here; the signed state says who it is."""
    def back(result: str, message: str = "") -> RedirectResponse:
        q = {"calendar": result, **({"message": message} if message else {})}
        return RedirectResponse(f"{settings.app_url}/meetings?{urlencode(q)}", status_code=303)

    if error:
        return back("error", "Google Calendar wasn’t connected (access was declined).")
    try:
        google = _google(request, settings)
        user_id = gc.read_state(settings.token_key, state)
        user = await con.fetchrow("SELECT id, email, active FROM users WHERE id = $1", UUID(user_id))
        if user is None or not user["active"]:
            raise gc.CalendarError("Your CRM access isn’t active.")
        tokens = await google.exchange_code(code, settings.calendar_redirect_uri)
        claims = gc.id_token_claims(tokens.get("id_token", ""))
        email = (claims.get("email") or "").lower()
        if email != user["email"]:
            raise gc.CalendarError(f"You signed in to Google as {email or 'another account'}; connect the calendar of {user['email']}.")
        if "calendar.events" not in tokens.get("scope", ""):
            raise gc.CalendarError("Calendar access wasn’t granted. Connect again and allow access to your calendar.")
        if not tokens.get("refresh_token"):
            raise gc.CalendarError("Google didn’t return offline access. Remove the CRM in your Google account’s third-party access, then connect again.")
    except gc.CalendarError as e:
        return back("error", e.message)
    except HTTPException as e:
        return back("error", str(e.detail))
    await con.execute(
        "INSERT INTO calendar_connections(user_id, google_email, refresh_token_encrypted, scopes) VALUES ($1, $2, $3, $4) "
        "ON CONFLICT (user_id) DO UPDATE SET google_email = EXCLUDED.google_email, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, "
        "scopes = EXCLUDED.scopes, status = 'connected', connected_at = now(), last_error = NULL",
        user["id"], email, gc.encrypt(settings.token_key, tokens["refresh_token"]), tokens.get("scope", ""))
    await _log(con, None, user["id"], "connect", True, f"Connected Google Calendar for {email}.")
    # Push anything that was waiting for this connection.
    waiting = await con.fetch(
        "SELECT id FROM meetings WHERE owner_id = $1 AND NOT cancelled AND sync_status IN ('not_connected', 'failed') AND ends_at > now()", user["id"])
    for w in waiting:
        await sync_meeting(con, google, settings, w["id"], "retry")
    return back("connected")


@router.post("/calendar/disconnect")
async def disconnect(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    row = await con.fetchrow("DELETE FROM calendar_connections WHERE user_id = $1 RETURNING refresh_token_encrypted", UUID(user.id))
    if row and not settings.calendar_missing:
        try:
            await _google(request, settings).revoke(gc.decrypt(settings.token_key, row["refresh_token_encrypted"]))
        except gc.CalendarError:
            pass
    await _log(con, None, UUID(user.id), "disconnect", True, "Disconnected Google Calendar.")
    return {"ok": True}


@router.get("/calendar/sync-status")
async def sync_status(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Managers and admins see everyone; salespeople see themselves."""
    only = None if user.can_edit_all else UUID(user.id)
    users = await con.fetch(
        "SELECT u.id, u.name, u.email, c.status, c.google_email, c.last_sync_at, c.last_error, "
        "(SELECT count(*) FROM meetings m WHERE m.owner_id = u.id AND m.sync_status IN ('failed', 'not_connected') AND NOT m.cancelled) AS unsynced, "
        "(SELECT count(*) FROM booking_links b WHERE b.owner_id = u.id AND b.active) AS booking_links "
        "FROM users u LEFT JOIN calendar_connections c ON c.user_id = u.id "
        "WHERE u.active AND ($1::uuid IS NULL OR u.id = $1) ORDER BY u.name", only)
    log = await con.fetch(
        "SELECT l.at, l.action, l.ok, l.message, l.meeting_id, u.name AS user_name, m.title AS meeting_title "
        "FROM calendar_sync_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN meetings m ON m.id = l.meeting_id "
        "WHERE ($1::uuid IS NULL OR l.user_id = $1) ORDER BY l.at DESC, l.id DESC LIMIT 50", only)
    return {"users": [dict(r) for r in users], "log": [dict(r) for r in log]}


# ── Meetings ──────────────────────────────────────────────────────────

def _check_meeting(rec: dict) -> list[dict]:
    errors = []
    if not (rec.get("title") or "").strip():
        errors.append({"field": "title", "message": "Meeting title is required."})
    if rec.get("starts_at") is None:
        errors.append({"field": "starts_at", "message": "Date and time are required."})
    elif rec["starts_at"].tzinfo is None:
        errors.append({"field": "starts_at", "message": "Date and time need a time zone offset."})
    if not 5 <= int(rec.get("duration_minutes") or 0) <= 24 * 60:
        errors.append({"field": "duration_minutes", "message": "Duration must be between 5 minutes and 24 hours."})
    try:
        ZoneInfo(rec.get("time_zone") or "")
    except (ZoneInfoNotFoundError, ValueError):
        errors.append({"field": "time_zone", "message": "Unknown time zone."})
    bad = [a for a in rec.get("attendees") or [] if not EMAIL_RE.match(a)]
    if bad:
        errors.append({"field": "attendees", "message": f"Not an email address: {', '.join(bad)}."})
    if bool(rec.get("entity_type")) != bool(rec.get("entity_id")):
        errors.append({"field": "entity_id", "message": "Choose the linked record."})
    return errors


def _can_change(user: User, m: dict) -> None:
    if not (user.can_edit_all or str(m["owner_id"]) == user.id):
        raise HTTPException(403, "Only the meeting’s owner, a manager or an admin can change it.")


def _when(m: dict) -> str:
    local = m["starts_at"].astimezone(ZoneInfo(m["time_zone"]))
    return local.strftime("%-d %b %Y, %H:%M ") + m["time_zone"]


@router.post("/meetings", status_code=201)
async def create_meeting(body: MeetingIn, request: Request, con: asyncpg.Connection = Depends(get_con),
                         settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    rec = body.model_dump()
    for k, setting in (("reminder_15", "meeting_15"), ("reminder_day", "meeting_day")):
        if rec[k] is None:
            rec[k] = bool(domain.REMINDERS[setting])
    rec["attendees"] = list(dict.fromkeys(a.strip().lower() for a in rec["attendees"] if a.strip()))
    raise_if_errors(_check_meeting(rec))
    if rec["entity_type"]:
        table, _ = _TABLE[rec["entity_type"]]
        if not await con.fetchval(f"SELECT 1 FROM {table} WHERE id = $1", rec["entity_id"]):
            raise_if_errors([{"field": "entity_id", "message": "The linked record no longer exists."}])
    google = _google(request, settings) if not settings.calendar_missing else None
    starts = rec["starts_at"]
    async with con.transaction():
        mid = await con.fetchval(
            "INSERT INTO meetings(entity_type, entity_id, owner_id, title, description, starts_at, ends_at, time_zone, attendees, "
            "add_meet, reminder_15, reminder_day, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$3) RETURNING id",
            rec["entity_type"], rec["entity_id"], UUID(user.id), rec["title"], rec["description"], starts,
            starts + timedelta(minutes=rec["duration_minutes"]), rec["time_zone"], rec["attendees"],
            rec["add_meet"], rec["reminder_15"], rec["reminder_day"])
        m = await _meeting(con, mid)
        if rec["entity_type"]:
            who = f" · with {', '.join(rec['attendees'])}" if rec["attendees"] else ""
            await log_activity(con, rec["entity_type"], rec["entity_id"], "meeting", f"Meeting scheduled: {m['title']} · {_when(m)}{who}", user.id)
    if google is None:
        msg = f"Google Calendar sync isn’t set up on the server yet (missing {', '.join(settings.calendar_missing)})."
        await con.execute("UPDATE meetings SET sync_status = 'not_connected', sync_error = $2 WHERE id = $1", mid, msg)
        return await _meeting(con, mid)
    return await sync_meeting(con, google, settings, mid, "create")


@router.get("/meetings")
async def list_meetings(scope: Literal["mine", "all"] = "mine", upcoming: bool = True, entity_type: Optional[str] = None,
                        entity_id: Optional[UUID] = None, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(
        _MEETING_SQL + " WHERE ($1::uuid IS NULL OR m.owner_id = $1) AND (NOT $2 OR (m.ends_at > now() AND NOT m.cancelled)) "
        "AND ($3::text IS NULL OR m.entity_type = $3) AND ($4::uuid IS NULL OR m.entity_id = $4) "
        "ORDER BY m.starts_at " + ("ASC" if upcoming else "DESC") + " LIMIT 200",
        UUID(user.id) if scope == "mine" and not entity_id else None, upcoming, entity_type, entity_id)
    return [dict(r) for r in rows]


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return await _meeting(con, meeting_id)


@router.patch("/meetings/{meeting_id}")
async def update_meeting(meeting_id: UUID, body: MeetingPatch, request: Request, con: asyncpg.Connection = Depends(get_con),
                         settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    m = await _meeting(con, meeting_id)
    _can_change(user, m)
    if m["cancelled"]:
        raise HTTPException(409, "This meeting was cancelled. Schedule a new one instead.")
    patch = body.model_dump(exclude_unset=True)
    if "attendees" in patch:
        patch["attendees"] = list(dict.fromkeys(a.strip().lower() for a in patch["attendees"] or [] if a.strip()))
    duration = patch.pop("duration_minutes", None) or int((m["ends_at"] - m["starts_at"]).total_seconds() // 60)
    merged = {**m, **patch, "duration_minutes": duration}
    raise_if_errors(_check_meeting(merged))
    merged["ends_at"] = merged["starts_at"] + timedelta(minutes=duration)
    cols = [c for c in ("title", "description", "starts_at", "ends_at", "time_zone", "attendees", "add_meet", "reminder_15", "reminder_day")]
    sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(cols, start=2))
    await con.execute(f"UPDATE meetings SET {sets}, sync_status = 'pending', updated_at = now() WHERE id = $1", meeting_id, *[merged[c] for c in cols])
    if settings.calendar_missing:
        return await _meeting(con, meeting_id)
    return await sync_meeting(con, _google(request, settings), settings, meeting_id, "update")


@router.post("/meetings/{meeting_id}/retry")
async def retry_meeting(meeting_id: UUID, request: Request, con: asyncpg.Connection = Depends(get_con),
                        settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    m = await _meeting(con, meeting_id)
    _can_change(user, m)
    return await sync_meeting(con, _google(request, settings), settings, meeting_id, "retry")


@router.post("/meetings/{meeting_id}/cancel")
async def cancel_meeting(meeting_id: UUID, request: Request, con: asyncpg.Connection = Depends(get_con),
                         settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    m = await _meeting(con, meeting_id)
    _can_change(user, m)
    if m["cancelled"]:
        return m
    await con.execute("UPDATE meetings SET cancelled = true, updated_at = now() WHERE id = $1", meeting_id)
    if m["entity_type"]:
        await log_activity(con, m["entity_type"], m["entity_id"], "meeting", f"Meeting cancelled: {m['title']} · {_when(m)}", user.id)
    if settings.calendar_missing:
        await con.execute("UPDATE meetings SET sync_status = 'cancelled' WHERE id = $1 AND google_event_id IS NULL", meeting_id)
        return await _meeting(con, meeting_id)
    return await sync_meeting(con, _google(request, settings), settings, meeting_id, "cancel")


# ── Booking links ─────────────────────────────────────────────────────

_LINK_SQL = "SELECT b.*, u.name AS owner_name FROM booking_links b JOIN users u ON u.id = b.owner_id"


async def _link(con: asyncpg.Connection, link_id: UUID) -> dict:
    row = await con.fetchrow(_LINK_SQL + " WHERE b.id = $1", link_id)
    if row is None:
        raise HTTPException(404, "Booking link not found.")
    return dict(row)


def _can_change_link(user: User, link: dict) -> None:
    if not (user.role == "admin" or str(link["owner_id"]) == user.id):
        raise HTTPException(403, "Only the link’s owner or an admin can change it.")


@router.get("/booking-links")
async def list_links(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return [dict(r) for r in await con.fetch(_LINK_SQL + " ORDER BY b.active DESC, u.name, b.name")]


@router.post("/booking-links", status_code=201)
async def create_link(body: BookingLinkIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    errors = []
    if not body.name:
        errors.append({"field": "name", "message": "Give the link a name, e.g. “30-min discovery call”."})
    if not BOOKING_RE.match(body.url or ""):
        errors.append({"field": "url", "message": "Paste the booking page link from Google Calendar (https://calendar.app.google/… or https://calendar.google.com/…)."})
    raise_if_errors(errors)
    link_id = await con.fetchval("INSERT INTO booking_links(owner_id, name, url) VALUES ($1, $2, $3) RETURNING id", UUID(user.id), body.name, body.url)
    return await _link(con, link_id)


@router.patch("/booking-links/{link_id}")
async def update_link(link_id: UUID, body: BookingLinkPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    link = await _link(con, link_id)
    _can_change_link(user, link)
    patch = body.model_dump(exclude_unset=True)
    if "name" in patch and not patch["name"]:
        raise_if_errors([{"field": "name", "message": "Name can’t be empty."}])
    if patch:
        sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(patch, start=2))
        await con.execute(f"UPDATE booking_links SET {sets} WHERE id = $1", link_id, *patch.values())
    return await _link(con, link_id)


@router.delete("/booking-links/{link_id}")
async def delete_link(link_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    _can_change_link(user, await _link(con, link_id))
    await con.execute("DELETE FROM booking_links WHERE id = $1", link_id)
    return {"ok": True}

