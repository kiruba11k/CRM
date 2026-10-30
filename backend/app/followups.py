"""
backend/app/followups.py - §6.1 time-specific follow-ups in Google Calendar.

A prospect or opportunity whose next action has a time and "add to my
calendar" ticked keeps ONE follow-up event in its owner's calendar,
titled "[Account] — [Action]". After every save the record is reconciled:

- rescheduled or reworded  → the same event is updated (never a second one)
- owner changed            → cancelled in the old owner's calendar, created in the new one's
- action completed early, unticked, record closed or nurtured → cancelled
- the event's time already passed → it stays in the calendar as history and,
  if a new follow-up is wanted, a new event is created for it

The CRM stays the source of truth: nothing in Google changes the record.
A Google problem never blocks saving the record; it shows on the follow-up
with a retry, like any meeting.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import asyncpg
from fastapi import Request
from loguru import logger

from . import domain
from .config import Settings, get_settings

FOLLOW_UP_MINUTES = 15
_TABLE = {"prospect": "prospects", "opportunity": "opportunities"}


def _settings(request: Request) -> Settings:
    # Honour test/deployment overrides of the settings dependency.
    return request.app.dependency_overrides.get(get_settings, get_settings)()


def _wanted(entity_type: str, rec: dict) -> bool:
    if entity_type == "prospect":
        open_action = rec["status"] not in domain.CLOSED_PROSPECT_STATUSES
    else:
        open_action = rec["stage"] not in domain.CLOSED_STAGES and not rec["on_nurture"]
    return bool(open_action and rec["next_action_in_calendar"] and rec["next_action_due"] and rec["next_action_time"] and rec["owner_id"])


def _starts(rec: dict) -> tuple[datetime, str]:
    tz_name = rec["next_action_time_zone"] or "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        tz, tz_name = ZoneInfo("UTC"), "UTC"
    return datetime.combine(rec["next_action_due"], rec["next_action_time"], tzinfo=tz), tz_name


async def reconcile(request: Request, con: asyncpg.Connection, entity_type: str, entity_id: UUID) -> None:
    """Bring the record's follow-up event in line with its next action."""
    from .routers import calendar  # avoid a router import cycle at module load

    try:
        settings = _settings(request)
        rec = await con.fetchrow(f"SELECT * FROM {_TABLE[entity_type]} WHERE id = $1", entity_id)
        if rec is None:
            return
        rec = dict(rec)
        existing = await con.fetchrow(
            "SELECT * FROM meetings WHERE entity_type = $1 AND entity_id = $2 AND follow_up_active", entity_type, entity_id)
        now = datetime.now(timezone.utc)
        to_sync: list[tuple[UUID, str]] = []

        if not _wanted(entity_type, rec):
            if existing is not None:
                if existing["starts_at"] > now:
                    await con.execute("UPDATE meetings SET cancelled = true, follow_up_active = false, updated_at = now() WHERE id = $1", existing["id"])
                    to_sync.append((existing["id"], "cancel"))
                else:
                    await con.execute("UPDATE meetings SET follow_up_active = false WHERE id = $1", existing["id"])
        else:
            starts, tz_name = _starts(rec)
            title = await calendar.default_title(con, entity_type, entity_id,
                                                 domain.next_action_title(rec["next_action_code"], rec["next_action_other"]))
            desired = {"title": title, "starts_at": starts, "ends_at": starts + timedelta(minutes=FOLLOW_UP_MINUTES),
                       "time_zone": tz_name, "owner_id": rec["owner_id"]}
            if existing is not None:
                same = all(existing[k] == v for k, v in desired.items())
                if existing["owner_id"] != rec["owner_id"]:
                    # Lives in the old owner's calendar: remove it there.
                    await con.execute("UPDATE meetings SET cancelled = true, follow_up_active = false, updated_at = now() WHERE id = $1", existing["id"])
                    to_sync.append((existing["id"], "cancel"))
                    existing = None
                elif not same and existing["starts_at"] <= now:
                    # That follow-up already happened: keep it as history.
                    await con.execute("UPDATE meetings SET follow_up_active = false WHERE id = $1", existing["id"])
                    existing = None
                elif not same:
                    await con.execute(
                        "UPDATE meetings SET title = $2, starts_at = $3, ends_at = $4, time_zone = $5, sync_status = 'pending', updated_at = now() WHERE id = $1",
                        existing["id"], desired["title"], desired["starts_at"], desired["ends_at"], desired["time_zone"])
                    to_sync.append((existing["id"], "update"))
            if existing is None:
                new_id = await con.fetchval(
                    "INSERT INTO meetings(kind, follow_up_active, entity_type, entity_id, owner_id, title, starts_at, ends_at, time_zone, "
                    "add_meet, reminder_15, reminder_day, created_by) VALUES ('follow_up', true, $1, $2, $3, $4, $5, $6, $7, false, $8, $9, $3) RETURNING id",
                    entity_type, entity_id, rec["owner_id"], desired["title"], desired["starts_at"], desired["ends_at"], desired["time_zone"],
                    bool(domain.REMINDERS["meeting_15"]), bool(domain.REMINDERS["meeting_day"]))
                to_sync.append((new_id, "create"))

        for meeting_id, action in to_sync:
            if settings.calendar_missing:
                status = "cancelled" if action == "cancel" else "not_connected"
                msg = None if action == "cancel" else f"Google Calendar sync isn’t set up on the server yet (missing {', '.join(settings.calendar_missing)})."
                await con.execute("UPDATE meetings SET sync_status = $2, sync_error = $3 WHERE id = $1 AND (google_event_id IS NULL OR $2 <> 'cancelled')",
                                  meeting_id, status, msg)
            else:
                await calendar.sync_meeting(con, calendar._google(request, settings), settings, meeting_id, action)
    except Exception:  # noqa: BLE001 - the record is saved; the follow-up shows its own state
        logger.exception(f"Follow-up sync failed for {entity_type} {entity_id}")


async def current(con: asyncpg.Connection, entity_type: str, entity_id: UUID) -> Optional[dict]:
    row = await con.fetchrow(
        "SELECT id, title, starts_at, time_zone, sync_status, sync_error, html_link, google_event_id FROM meetings "
        "WHERE entity_type = $1 AND entity_id = $2 AND follow_up_active", entity_type, entity_id)
    return dict(row) if row else None
