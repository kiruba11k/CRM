"""
backend/app/tasksync.py - §6.3 one-way sync of next actions to Google Tasks.

A user who turns Tasks on gets a "LeadStrategus CRM" list in Google Tasks.
Every open next action they own (or nurture revisit) is one task there,
titled "[Account] — [Action]", due on the action's date, with the record's
context and link in its notes. After every save of a record:

- rescheduled or reworded  → the same task is updated (never a second one)
- action completed in CRM  → the task is ticked off in Google
- record closed, action removed, Tasks turned off → the task is deleted
- owner changed            → deleted from the old owner's list, created in the new one's

One-way by design: nothing done in Google Tasks changes the CRM. A task is
shown as synced only after Google confirms it; failures stay visible with
a retry. Google Tasks has no client-chosen IDs, so a retried create first
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
FOOTER = "Managed by LeadStrategus CRM: update the action there; changes made here are not copied back."


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
        if existing is not None and (completed or not want or existing["owner_id"] != want["owner_id"]):
            await con.execute("UPDATE task_links SET active = false, updated_at = now() WHERE id = $1", existing["id"])
            ops.append((existing["id"], "complete" if completed else "delete"))
            existing = None
        if want:
            title = await calendar.default_title(con, entity_type, entity_id, domain.next_action_title(want["code"], want["other"]))
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
