"""
backend/app/tasksync.py - §6.3 sync of next actions with Google Tasks.

A user who turns Tasks on gets a "LeadStrategus CRM" list in Google Tasks.
Every open next action they own (or nurture revisit) is one task there,
titled "[Account] — [Action]", due on the action's date, with the record's
context and link in its notes. After every save of a record:

- rescheduled or reworded  → the same task is updated (never a second one)
- action completed in CRM  → the task is ticked off in Google
- record closed, action removed, Tasks turned off → the task is deleted
- owner changed            → deleted from the old owner's list, created in the new one's

Two-way where it's safe (pull_user): ticking a task off in Google flags the
record "done in Google" so its owner picks the next action in the CRM (every
open record must have one, so the CRM never invents it); changing the due
date in Google reschedules the action; deleting the task stops syncing it
until the action changes. Titles and notes stay CRM-owned. A task is shown
as synced only after Google confirms it; failures stay visible with a retry. Google Tasks has no client-chosen IDs, so a retried create first
looks for the task an unanswered attempt made (by a marker in its notes).
"""
import asyncio
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import Request
from loguru import logger

from . import domain, google_calendar as gc
from .config import Settings

LIST_TITLE = "LeadStrategus CRM"
_TABLE = {"prospect": "prospects", "opportunity": "opportunities"}
_PATH = {"prospect": "prospects", "opportunity": "opportunities"}
FOOTER = "Managed by LeadStrategus CRM. Tick it off or change its date here and the CRM follows; change the action itself in the CRM."


def marker(link_id: UUID) -> str:
    return f"[crm-task:{link_id}]"


def desired(entity_type: str, rec: dict) -> Optional[dict]:
    """The to-do the record should have in its owner's Google Tasks, if any."""
    if entity_type == "prospect":
        if rec["status"] in domain.CLOSED_PROSPECT_STATUSES or not rec["next_action_code"] or not rec["next_action_due"] or not rec["owner_id"]:
            return None
        return {"owner_id": rec["owner_id"], "code": rec["next_action_code"], "other": rec["next_action_other"], "due": rec["next_action_due"]}
    if rec["stage"] in domain.CLOSED_STAGES:
        return None
    if rec["on_nurture"]:
        # The nurture revisit is the one reminder a nurtured deal keeps (§4.2).
        if not rec["nurture_until"]:
            return None
        return {"owner_id": rec["nurture_owner_id"] or rec["owner_id"], "code": rec["nurture_next_action_code"] or "17",
                "other": rec["nurture_next_action_other"], "due": rec["nurture_until"]}
    if not rec["next_action_code"] or not rec["next_action_due"]:
        return None
    return {"owner_id": rec["owner_id"], "code": rec["next_action_code"], "other": rec["next_action_other"], "due": rec["next_action_due"]}


async def _log(con: asyncpg.Connection, link_id: UUID, user_id: UUID, action: str, ok: bool, message: str) -> None:
    await con.execute("INSERT INTO calendar_sync_log(task_link_id, user_id, action, ok, message) VALUES ($1, $2, $3, $4, $5)",
                      link_id, user_id, f"tasks: {action}", ok, message)


async def _ensure_list(con: asyncpg.Connection, google: gc.Google, refresh: str, user_id: UUID, fresh: bool = False) -> str:
    list_id = None if fresh else await con.fetchval("SELECT tasks_list_id FROM calendar_connections WHERE user_id = $1", user_id)
    if not list_id:
        list_id = await google.create_tasklist(refresh, LIST_TITLE)
        await con.execute("UPDATE calendar_connections SET tasks_list_id = $2 WHERE user_id = $1", user_id, list_id)
    return list_id


async def sync_link(con: asyncpg.Connection, google: gc.Google, settings: Settings, link_id: UUID, action: str) -> None:
    link = dict(await con.fetchrow("SELECT * FROM task_links WHERE id = $1", link_id))
    owner = link["owner_id"]
    conn = await con.fetchrow("SELECT * FROM calendar_connections WHERE user_id = $1", owner)
    if conn is None or conn["status"] != "connected" or not conn["tasks_enabled"]:
        if action in ("delete", "complete") and not link["google_task_id"]:
            await con.execute("UPDATE task_links SET sync_status = $2, sync_error = NULL WHERE id = $1",
                              link_id, "completed" if action == "complete" else "removed")
            return
        name = await con.fetchval("SELECT name FROM users WHERE id = $1", owner)
        msg = (f"{name}’s Google access expired: reconnect, then retry." if conn is not None and conn["status"] != "connected"
               else f"{name} hasn’t turned on Google Tasks.")
        await con.execute("UPDATE task_links SET sync_status = 'not_connected', sync_error = $2 WHERE id = $1", link_id, msg)
        await _log(con, link_id, owner, action, False, msg)
        return
    try:
        refresh = gc.decrypt(settings.token_key, conn["refresh_token_encrypted"])
        list_id = link["tasklist_id"] or await _ensure_list(con, google, refresh, owner)
        if action in ("delete", "complete"):
            if link["google_task_id"]:
                if action == "delete":
                    await google.delete_task(refresh, list_id, link["google_task_id"])
                else:
                    try:
                        await google.patch_task(refresh, list_id, link["google_task_id"], {"status": "completed"})
                    except gc.CalendarError as e:
                        if e.status not in (404, 410):  # removed in Google already
                            raise
            status, message = ("removed", "Removed from Google Tasks.") if action == "delete" else ("completed", "Ticked off in Google Tasks.")
            await con.execute("UPDATE task_links SET sync_status = $2, sync_error = NULL, synced_at = now() WHERE id = $1", link_id, status)
        else:
            body = {"title": link["title"], "notes": f"{link['notes']}\n\n{marker(link_id)}".strip(),
                    "due": f"{link['due'].isoformat()}T00:00:00.000Z"}
            task = None
            if link["google_task_id"]:
                try:
                    task = await google.patch_task(refresh, list_id, link["google_task_id"], body)
                    message = "Updated in Google Tasks."
                except gc.CalendarError as e:
                    if e.status not in (404, 410):
                        raise
                    # Deleted in Google: the CRM still wants it, so recreate it.
            if task is None:
                if link["attempted"]:
                    task = await google.find_task(refresh, list_id, marker(link_id))
                await con.execute("UPDATE task_links SET attempted = true WHERE id = $1", link_id)
                if task is not None:
                    task = await google.patch_task(refresh, list_id, task["id"], body)
                    message = "Found the task from an earlier attempt and updated it."
                else:
                    try:
                        task = await google.insert_task(refresh, list_id, body)
                    except gc.CalendarError as e:
                        if e.status != 404:
                            raise
                        # The CRM's list was deleted in Google: make a new one.
                        list_id = await _ensure_list(con, google, refresh, owner, fresh=True)
                        task = await google.insert_task(refresh, list_id, body)
                    message = "Created in Google Tasks."
            await con.execute(
                "UPDATE task_links SET google_task_id = $2, tasklist_id = $3, sync_status = 'synced', sync_error = NULL, synced_at = now() WHERE id = $1",
                link_id, task["id"], list_id)
        await con.execute("UPDATE calendar_connections SET last_sync_at = now(), last_error = NULL WHERE user_id = $1", owner)
        await _log(con, link_id, owner, action, True, message)
    except gc.CalendarError as e:
        await con.execute("UPDATE task_links SET sync_status = 'failed', sync_error = $2 WHERE id = $1", link_id, e.message)
        await con.execute(
            "UPDATE calendar_connections SET last_error = $2, status = CASE WHEN $3 THEN 'needs_reconnect' ELSE status END WHERE user_id = $1",
            owner, e.message, e.reconnect)
        await _log(con, link_id, owner, action, False, e.message)


async def reconcile(request: Request, con: asyncpg.Connection, entity_type: str, entity_id: UUID, completed: bool = False) -> None:
    """Bring the record's Google task in line with its next action. Never raises."""
    from .followups import _settings
    from .routers import calendar

    try:
        settings = _settings(request)
        rec = await con.fetchrow(f"SELECT * FROM {_TABLE[entity_type]} WHERE id = $1", entity_id)
        if rec is None:
            return
        want = desired(entity_type, dict(rec))
        if want and not await con.fetchval("SELECT tasks_enabled FROM calendar_connections WHERE user_id = $1", want["owner_id"]):
            want = None
        existing = await con.fetchrow("SELECT * FROM task_links WHERE entity_type = $1 AND entity_id = $2 AND active", entity_type, entity_id)
        ops: list[tuple[UUID, str]] = []
        want_title = (await calendar.default_title(con, entity_type, entity_id, domain.next_action_title(want["code"], want["other"]))
                      if want else None)
        if existing is not None and existing["completed_in_google_at"] and (
                completed or not want or (want["due"], want_title) != (existing["due"], existing["title"])):
            # Ticked off in Google and the action has now moved on in the CRM:
            # that task is finished; the new action gets a new task.
            await con.execute("UPDATE task_links SET active = false, sync_status = 'completed', updated_at = now() WHERE id = $1", existing["id"])
            existing = None
        if existing is not None and (completed or not want or existing["owner_id"] != want["owner_id"]):
            await con.execute("UPDATE task_links SET active = false, updated_at = now() WHERE id = $1", existing["id"])
            ops.append((existing["id"], "complete" if completed else "delete"))
            existing = None
        if want:
            title = want_title
            context, _ = await calendar.record_context(con, entity_type, entity_id)
            link = f"{settings.app_url}/{_PATH[entity_type]}/{entity_id}"
            notes = gc.event_description(context, None, link) + "\n\n" + FOOTER
            if existing is not None:
                if (existing["title"], existing["due"], existing["notes"]) != (title, want["due"], notes):
                    await con.execute("UPDATE task_links SET title = $2, due = $3, notes = $4, sync_status = 'pending', updated_at = now() WHERE id = $1",
                                      existing["id"], title, want["due"], notes)
                    ops.append((existing["id"], "update"))
            else:
                new_id = await con.fetchval(
                    "INSERT INTO task_links(entity_type, entity_id, owner_id, title, notes, due) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
                    entity_type, entity_id, want["owner_id"], title, notes, want["due"])
                ops.append((new_id, "create"))
        if ops and not settings.calendar_missing:
            google = calendar._google(request, settings)
            for link_id, action in ops:
                await sync_link(con, google, settings, link_id, action)
    except Exception:  # noqa: BLE001 - the record is saved; the task shows its own state
        logger.exception(f"Google Tasks sync failed for {entity_type} {entity_id}")


# ── Reading back from Google ──────────────────────────────────────────

PULL_EVERY = 60   # seconds between pulls for one person (My Actions calls it on load)


async def pull_user(request: Request, con: asyncpg.Connection, google: gc.Google, settings: Settings, user_id: UUID,
                    force: bool = False) -> dict:
    from datetime import date as _date, datetime as _dt, timedelta, timezone

    conn = await con.fetchrow("SELECT * FROM calendar_connections WHERE user_id = $1", user_id)
    if conn is None or conn["status"] != "connected" or not conn["tasks_enabled"] or not conn["tasks_list_id"]:
        return {"status": "off", "done": 0, "rescheduled": 0, "removed": 0}
    now = _dt.now(timezone.utc)
    if not force and conn["tasks_pulled_at"] and (now - conn["tasks_pulled_at"]).total_seconds() < PULL_EVERY:
        return {"status": "recent", "done": 0, "rescheduled": 0, "removed": 0}
    since = (conn["tasks_pulled_at"] - timedelta(minutes=5)).isoformat() if conn["tasks_pulled_at"] else None
    try:
        refresh = gc.decrypt(settings.token_key, conn["refresh_token_encrypted"])
        tasks = await google.list_tasks(refresh, conn["tasks_list_id"], since)
    except gc.CalendarError as e:
        await con.execute("UPDATE calendar_connections SET last_error = $2, status = CASE WHEN $3 THEN 'needs_reconnect' ELSE status END WHERE user_id = $1",
                          user_id, e.message, e.reconnect)
        return {"status": "error", "error": e.message, "done": 0, "rescheduled": 0, "removed": 0}
    links = {r["google_task_id"]: dict(r) for r in await con.fetch(
        "SELECT * FROM task_links WHERE owner_id = $1 AND active AND google_task_id IS NOT NULL", user_id)}
    out = {"status": "ok", "done": 0, "rescheduled": 0, "removed": 0}
    for t in tasks:
        link = links.get(t.get("id"))
        if link is None:
            continue
        et, eid = link["entity_type"], link["entity_id"]
        if t.get("deleted"):
            await con.execute("UPDATE task_links SET active = false, sync_status = 'removed', sync_error = 'Deleted in Google Tasks', updated_at = now() WHERE id = $1", link["id"])
            await _log(con, link["id"], user_id, "pulled", True, "Deleted in Google Tasks: no longer synced until the action changes.")
            out["removed"] += 1
            continue
        if t.get("status") == "completed":
            if not link["completed_in_google_at"]:
                await con.execute("UPDATE task_links SET completed_in_google_at = now(), updated_at = now() WHERE id = $1", link["id"])
                await con.execute("INSERT INTO activities(entity_type, entity_id, kind, summary, created_by) VALUES ($1, $2, 'action_done', $3, $4)",
                                  et, eid, f"Marked done in Google Tasks: {link['title']}. Set the next action in the CRM.", user_id)
                out["done"] += 1
            continue
        if link["completed_in_google_at"]:   # unticked again in Google
            await con.execute("UPDATE task_links SET completed_in_google_at = NULL WHERE id = $1", link["id"])
        due = t.get("due")
        new_due = _date.fromisoformat(due[:10]) if due else None
        if new_due and new_due != link["due"]:
            rec = await con.fetchrow(f"SELECT * FROM {_TABLE[et]} WHERE id = $1", eid)
            if rec is None:
                continue
            field = "nurture_until" if et == "opportunity" and rec["on_nurture"] else "next_action_due"
            old = rec[field]
            async with con.transaction():
                await con.execute(f"UPDATE {_TABLE[et]} SET {field} = $2, updated_at = now() WHERE id = $1", eid, new_due)
                await con.execute("UPDATE task_links SET due = $2, updated_at = now() WHERE id = $1", link["id"], new_due)
                await con.execute("INSERT INTO record_history(entity_type, entity_id, field, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5, $6)",
                                  et, eid, field, old.isoformat() if old else None, new_due.isoformat(), user_id)
                await con.execute("INSERT INTO activities(entity_type, entity_id, kind, summary, created_by) VALUES ($1, $2, 'rescheduled', $3, $4)",
                                  et, eid, f"Rescheduled in Google Tasks: {old.isoformat() if old else '—'} → {new_due.isoformat()}.", user_id)
            from . import followups
            await followups.reconcile(request, con, et, eid)   # move the Calendar follow-up too
            out["rescheduled"] += 1
    await con.execute("UPDATE calendar_connections SET tasks_pulled_at = $2 WHERE user_id = $1", user_id, now)
    return out


async def pull_all(request: Request, con: asyncpg.Connection, google: gc.Google, settings: Settings) -> dict:
    total = {"users": 0, "done": 0, "rescheduled": 0, "removed": 0}
    for r in await con.fetch("SELECT c.user_id FROM calendar_connections c JOIN users u ON u.id = c.user_id "
                             "WHERE c.tasks_enabled AND c.status = 'connected' AND u.active"):
        res = await pull_user(request, con, google, settings, r["user_id"], force=True)
        total["users"] += 1
        for k in ("done", "rescheduled", "removed"):
            total[k] += res.get(k, 0)
    return total


async def backfill(request: Request, user_id: UUID) -> None:
    """Mirror every open next action the user owns (run after turning Tasks on)."""
    async with request.app.state.pool.acquire() as con:
        rows = await con.fetch(
            "SELECT 'prospect' AS t, id FROM prospects WHERE owner_id = $1 AND status <> 'Disqualified' AND next_action_due IS NOT NULL "
            "UNION ALL SELECT 'opportunity', id FROM opportunities WHERE stage NOT IN ('Won', 'Lost') "
            "AND (owner_id = $1 OR (on_nurture AND nurture_owner_id = $1))", user_id)
        for r in rows:
            await reconcile(request, con, r["t"], r["id"])
        # Retry anything that failed or waited while Tasks was off or disconnected.
        for r in await con.fetch("SELECT entity_type, entity_id, id FROM task_links WHERE owner_id = $1 AND active AND sync_status IN ('failed', 'not_connected')", user_id):
            from .followups import _settings
            from .routers import calendar
            settings = _settings(request)
            await sync_link(con, calendar._google(request, settings), settings, r["id"], "retry")


def start_backfill(request: Request, user_id: UUID) -> None:
    task = asyncio.create_task(backfill(request, user_id))
    request.app.state.import_tasks.add(task)  # the app's set of background tasks
    task.add_done_callback(request.app.state.import_tasks.discard)


async def disable(con: asyncpg.Connection, google: Optional[gc.Google], settings: Settings, user_id: UUID) -> None:
    """Turn Tasks off: remove the CRM's list from Google and stop mirroring."""
    conn = await con.fetchrow("SELECT * FROM calendar_connections WHERE user_id = $1", user_id)
    if conn is not None and conn["tasks_list_id"] and google is not None and conn["status"] == "connected":
        try:
            await google.delete_tasklist(gc.decrypt(settings.token_key, conn["refresh_token_encrypted"]), conn["tasks_list_id"])
        except gc.CalendarError as e:
            logger.warning(f"Couldn’t delete the Google Tasks list for {user_id}: {e.message}")
    await con.execute("UPDATE task_links SET active = false, sync_status = 'removed', updated_at = now() WHERE owner_id = $1 AND active", user_id)
    await con.execute("UPDATE calendar_connections SET tasks_enabled = false, tasks_list_id = NULL WHERE user_id = $1", user_id)


async def current(con: asyncpg.Connection, entity_type: str, entity_id: UUID) -> Optional[dict]:
    row = await con.fetchrow(
        "SELECT id, title, due, sync_status, sync_error, synced_at, owner_id FROM task_links "
        "WHERE entity_type = $1 AND entity_id = $2 AND active", entity_type, entity_id)
    return dict(row) if row else None
