"""§6.3 Google Tasks: turn one-way sync on or off, see its state, retry."""
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import google_calendar as gc, tasksync
from ..auth import User, current_user, get_con
from ..config import Settings, get_settings
from .calendar import _google

router = APIRouter(prefix="/tasks", tags=["calendar"])


@router.get("/status")
async def status(con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    conn = await con.fetchrow("SELECT status, scopes, tasks_enabled FROM calendar_connections WHERE user_id = $1", UUID(user.id))
    counts = {r["sync_status"]: r["n"] for r in await con.fetch(
        "SELECT sync_status, count(*) AS n FROM task_links WHERE owner_id = $1 AND active GROUP BY sync_status", UUID(user.id))}
    return {
        "configured": not settings.calendar_missing,
        "connected": conn is not None and conn["status"] == "connected",
        "enabled": bool(conn and conn["tasks_enabled"]),
        "granted": bool(conn and gc.TASKS_SCOPE in conn["scopes"]),
        "counts": counts,
    }


@router.post("/enable")
async def enable(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                 user: User = Depends(current_user)):
    """Turn sync on. Without Tasks access yet, returns Google's consent URL
    (asking for Calendar + Tasks); the callback then turns it on."""
    _google(request, settings)
    conn = await con.fetchrow("SELECT status, scopes FROM calendar_connections WHERE user_id = $1", UUID(user.id))
    if conn is None or conn["status"] != "connected" or gc.TASKS_SCOPE not in conn["scopes"]:
        state = gc.make_state(settings.token_key, user.id, tasks=True)
        return {"url": gc.auth_url(settings.google_client_id, settings.calendar_redirect_uri, state, user.email, settings.allowed_domain, tasks=True)}
    await con.execute("UPDATE calendar_connections SET tasks_enabled = true WHERE user_id = $1", UUID(user.id))
    tasksync.start_backfill(request, UUID(user.id))
    return {"enabled": True}


@router.post("/disable")
async def disable(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                  user: User = Depends(current_user)):
    await tasksync.disable(con, None if settings.calendar_missing else _google(request, settings), settings, UUID(user.id))
    return {"enabled": False}


@router.post("/links/{link_id}/retry")
async def retry(link_id: UUID, request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                user: User = Depends(current_user)):
    link = await con.fetchrow("SELECT owner_id, active FROM task_links WHERE id = $1", link_id)
    if link is None:
        raise HTTPException(404, "Task not found.")
    if not (user.can_edit_all or str(link["owner_id"]) == user.id):
        raise HTTPException(403, "Only the task’s owner, a manager or an admin can retry it.")
    await tasksync.sync_link(con, _google(request, settings), settings, link_id, "retry" if link["active"] else "delete")
    return await con.fetchrow("SELECT id, title, due, sync_status, sync_error, synced_at, owner_id FROM task_links WHERE id = $1", link_id)


@router.post("/pull")
async def pull(request: Request, force: bool = False, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
               user: User = Depends(current_user)):
    """Read back what changed in my Google Tasks (ticked off, re-dated, deleted).
    My Actions calls this on load; it runs at most once a minute unless forced."""
    if settings.calendar_missing:
        return {"status": "off", "done": 0, "rescheduled": 0, "removed": 0}
    return await tasksync.pull_user(request, con, _google(request, settings), settings, UUID(user.id), force=force)
