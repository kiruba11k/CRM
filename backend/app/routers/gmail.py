"""Gmail auto-logging: turn on/off, status, sync now, remove a logged email."""
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import gmailsync, google_calendar as gc
from ..auth import User, current_user, get_con
from ..config import Settings, get_settings
from .calendar import _google

router = APIRouter(prefix="/gmail", tags=["gmail"])


@router.get("/status")
async def status(con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    c = await con.fetchrow(
        "SELECT status, scopes, gmail_enabled, gmail_synced_at, gmail_error, gmail_history_id FROM calendar_connections WHERE user_id = $1", UUID(user.id))
    logged = await con.fetchval(
        "SELECT count(DISTINCT gmail_message_id) FROM activities WHERE created_by = $1 AND gmail_message_id IS NOT NULL "
        "AND occurred_at > now() - interval '30 days'", UUID(user.id))
    return {
        "configured": not settings.calendar_missing,
        "connected": c is not None and c["status"] == "connected",
        "granted": bool(c and gc.GMAIL_SCOPE in c["scopes"]),
        "enabled": bool(c and c["gmail_enabled"]),
        "first_sync_done": bool(c and c["gmail_history_id"]),
        "synced_at": c["gmail_synced_at"] if c else None,
        "error": c["gmail_error"] if c else None,
        "logged_30_days": logged,
    }


@router.post("/enable")
async def enable(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                 user: User = Depends(current_user)):
    """Turn auto-logging on. Without Gmail access yet, returns Google's consent
    URL; the callback then turns it on and starts the first sync."""
    google = _google(request, settings)
    c = await con.fetchrow("SELECT status, scopes FROM calendar_connections WHERE user_id = $1", UUID(user.id))
    if c is None or c["status"] != "connected" or gc.GMAIL_SCOPE not in c["scopes"]:
        state = gc.make_state(settings.token_key, user.id, gmail=True)
        return {"url": gc.auth_url(settings.google_client_id, settings.calendar_redirect_uri, state, user.email, settings.allowed_domain, gmail=True)}
    await con.execute("UPDATE calendar_connections SET gmail_enabled = true, gmail_error = NULL WHERE user_id = $1", UUID(user.id))
    gmailsync.start_sync(request, google, settings, UUID(user.id))
    return {"enabled": True}


@router.post("/disable")
async def disable(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Stop logging. Emails already logged stay on the records."""
    await con.execute("UPDATE calendar_connections SET gmail_enabled = false, gmail_history_id = NULL, gmail_error = NULL WHERE user_id = $1",
                      UUID(user.id))
    return {"enabled": False}


@router.post("/sync")
async def sync_now(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                   user: User = Depends(current_user)):
    res = await gmailsync.sync_user(con, _google(request, settings), settings, UUID(user.id))
    if res["status"] == "off":
        raise HTTPException(409, "Gmail auto-logging is off. Turn it on first.")
    if res["status"] == "needs_reconnect":
        raise HTTPException(409, "Google access needs renewing: turn Gmail auto-logging on again.")
    if res["status"] == "error":
        raise HTTPException(502, res["error"])
    return res


@router.delete("/logged/{activity_id}")
async def remove(activity_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Take an auto-logged email off every record and never log it again."""
    a = await con.fetchrow("SELECT gmail_message_id, created_by FROM activities WHERE id = $1", activity_id)
    if a is None or not a["gmail_message_id"]:
        raise HTTPException(404, "That isn’t an auto-logged email.")
    if not (user.can_edit_all or str(a["created_by"]) == user.id):
        raise HTTPException(403, "Only the person whose mailbox logged it, a manager or an admin can remove it.")
    async with con.transaction():
        n = await con.fetchval("WITH d AS (DELETE FROM activities WHERE gmail_message_id = $1 RETURNING 1) SELECT count(*) FROM d", a["gmail_message_id"])
        await con.execute("INSERT INTO gmail_exclusions(user_id, message_id) SELECT DISTINCT u, $1 FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING",
                          a["gmail_message_id"], [a["created_by"], UUID(user.id)])
    return {"removed": n}
