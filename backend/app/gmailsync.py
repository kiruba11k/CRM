"""
backend/app/gmailsync.py - Gmail auto-logging.

Each person can turn this on (Meetings page). The CRM then reads the
*headers* of their mail (gmail.metadata scope: From, To, Cc, Subject, date;
never bodies) and, for every email exchanged with someone who is a prospect
in the CRM, logs an "email" activity on that prospect and on their open
opportunities, and moves the prospect's last-activity date forward.

- Internal-only mail (everyone at the Workspace domain) is ignored.
- The first sync looks back BACKFILL_DAYS; later syncs read only what is new
  since the last one (Gmail history), run hourly and on "Sync now".
- An email is logged once per record even when several colleagues have it
  (keyed by its RFC Message-ID), and an email someone removed from the CRM
  is never logged again.
"""
import asyncio
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import Request
from loguru import logger

from . import google_calendar as gc
from .config import Settings

BACKFILL_DAYS = 30
CATCH_UP_DAYS = 7      # when Gmail's history has expired (long gap)
MAX_SCAN = 1500        # messages looked at in one backfill
CONCURRENCY = 8
SKIP_LABELS = {"DRAFT", "SPAM", "TRASH", "CHAT"}


def parse(msg: dict, me: str, domain: str) -> Optional[dict]:
    """Who, when, which way. None for drafts, spam, trash and chats."""
    labels = set(msg.get("labelIds") or [])
    if labels & SKIP_LABELS:
        return None
    headers: dict[str, str] = {}
    for h in (msg.get("payload") or {}).get("headers") or []:
        headers.setdefault(h.get("name", "").lower(), h.get("value", ""))
    me = me.lower()
    sender = [a.lower() for _, a in getaddresses([headers.get("from", "")]) if a]
    recipients = [a.lower() for _, a in getaddresses([headers.get("to", ""), headers.get("cc", "")]) if a]
    outgoing = "SENT" in labels or me in sender
    suffix = "@" + domain.lower()
    people = (recipients if outgoing else sender + recipients)
    external = sorted({a for a in people if "@" in a and a != me and not a.endswith(suffix)})
    subject = " ".join((headers.get("subject") or "").split())[:200] or "(no subject)"
    return {
        "id": msg["id"], "key": (headers.get("message-id") or "").strip()[:250] or f"gmail:{msg['id']}",
        "thread_id": msg.get("threadId"), "subject": subject, "direction": "out" if outgoing else "in",
        "at": datetime.fromtimestamp(int(msg.get("internalDate", "0")) / 1000, tz=timezone.utc),
        "external": external, "sender": sender[0] if sender else None,
    }


async def log_message(con: asyncpg.Connection, user_id: UUID, m: dict) -> int:
    """Log one parsed email on the matching prospects and their open deals.
    Returns how many activities were added."""
    if not m["external"]:
        return 0
    if await con.fetchval("SELECT 1 FROM gmail_exclusions WHERE user_id = $1 AND message_id = $2", user_id, m["key"]):
        return 0
    prospects = await con.fetch(
        "SELECT id, full_name, lower(email) AS email FROM prospects WHERE lower(email) = ANY($1::text[])", m["external"])
    if not prospects:
        return 0
    added = 0
    for p in prospects:
        if m["direction"] == "out":
            summary = f"Email sent to {p['full_name']}: {m['subject']}"
        else:
            summary = f"Email from {p['full_name']}: {m['subject']}" if m["sender"] == p["email"] else f"Email with {p['full_name']}: {m['subject']}"
        targets = [("prospect", p["id"])] + [("opportunity", r["id"]) for r in await con.fetch(
            "SELECT id FROM opportunities WHERE primary_contact_id = $1 AND stage NOT IN ('Won', 'Lost')", p["id"])]
        for entity_type, entity_id in targets:
            res = await con.execute(
                "INSERT INTO activities(entity_type, entity_id, kind, summary, occurred_at, created_by, gmail_message_id, gmail_thread_id, email_direction) "
                "VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING",
                entity_type, entity_id, summary, m["at"], user_id, m["key"], m["thread_id"], m["direction"])
            added += res.endswith(" 1")
        await con.execute(
            "UPDATE prospects SET last_activity_at = GREATEST(COALESCE(last_activity_at, $2), $2) WHERE id = $1", p["id"], m["at"])
    return added


async def _new_ids(google: gc.Google, refresh: str, history_id: Optional[str], now: datetime) -> tuple[list[str], str, Optional[int]]:
    """Message IDs to look at, the history ID to resume from next time, and
    (for a backfill) the oldest internalDate in ms worth logging."""
    days = BACKFILL_DAYS
    if history_id:
        try:
            ids: list[str] = []
            token, latest = None, history_id
            while True:
                data = await google.gmail_history(refresh, history_id, token)
                for h in data.get("history") or []:
                    ids += [a["message"]["id"] for a in h.get("messagesAdded") or []]
                latest = data.get("historyId") or latest
                token = data.get("nextPageToken")
                if not token:
                    return list(dict.fromkeys(ids)), str(latest), None
        except gc.CalendarError as e:
            if e.status != 404:
                raise
            days = CATCH_UP_DAYS  # history too old: catch up on the last week instead
    latest = str((await google.gmail_profile(refresh))["historyId"])  # before listing, so nothing slips between
    cutoff = int((now - timedelta(days=days)).timestamp() * 1000)
    ids, token = [], None
    while len(ids) < MAX_SCAN:
        data = await google.gmail_list(refresh, token)
        batch = [m["id"] for m in data.get("messages") or []]
        ids += batch
        token = data.get("nextPageToken")
        if not token or not batch:
            break
        last = await google.gmail_message(refresh, batch[-1])  # newest first: stop once past the cutoff
        if last and int(last.get("internalDate", "0")) < cutoff:
            break
    return ids[:MAX_SCAN], latest, cutoff


async def sync_user(con: asyncpg.Connection, google: gc.Google, settings: Settings, user_id: UUID,
                    now: Optional[datetime] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    conn = await con.fetchrow(
        "SELECT c.*, u.email FROM calendar_connections c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1 AND u.active", user_id)
    if conn is None or not conn["gmail_enabled"]:
        return {"status": "off"}
    if conn["status"] != "connected" or gc.GMAIL_SCOPE not in conn["scopes"]:
        return {"status": "needs_reconnect"}
    try:
        refresh = gc.decrypt(settings.token_key, conn["refresh_token_encrypted"])
        ids, latest, cutoff = await _new_ids(google, refresh, conn["gmail_history_id"], now)
        sem = asyncio.Semaphore(CONCURRENCY)

        async def fetch(mid: str) -> Optional[dict]:
            async with sem:
                return await google.gmail_message(refresh, mid)

        raw = await asyncio.gather(*(fetch(i) for i in ids))
        parsed = [p for p in (parse(r, conn["email"], settings.allowed_domain) for r in raw if r) if p]
        if cutoff is not None:
            parsed = [p for p in parsed if p["at"].timestamp() * 1000 >= cutoff]
        logged = 0
        for m in sorted(parsed, key=lambda x: x["at"]):
            logged += await log_message(con, user_id, m)
    except gc.CalendarError as e:
        await con.execute(
            "UPDATE calendar_connections SET gmail_error = $2, status = CASE WHEN $3 THEN 'needs_reconnect' ELSE status END WHERE user_id = $1",
            user_id, e.message[:300], e.reconnect)
        logger.warning(f"Gmail sync for {conn['email']} failed: {e.message}")
        return {"status": "error", "error": e.message}
    await con.execute(
        "UPDATE calendar_connections SET gmail_history_id = $2, gmail_synced_at = $3, gmail_error = NULL WHERE user_id = $1",
        user_id, latest, now)
    return {"status": "ok", "checked": len(ids), "logged": logged}


async def sync_all(con: asyncpg.Connection, google: gc.Google, settings: Settings) -> dict:
    out = {"users": 0, "logged": 0, "errors": 0}
    for r in await con.fetch(
            "SELECT c.user_id FROM calendar_connections c JOIN users u ON u.id = c.user_id WHERE c.gmail_enabled AND u.active"):
        res = await sync_user(con, google, settings, r["user_id"])
        out["users"] += 1
        out["logged"] += res.get("logged", 0)
        out["errors"] += res["status"] in ("error", "needs_reconnect")
    return out


def start_sync(request: Request, google: gc.Google, settings: Settings, user_id: UUID) -> None:
    """First sync after turning it on runs in the background (it can take a minute)."""
    async def run() -> None:
        async with request.app.state.pool.acquire() as con:
            await sync_user(con, google, settings, user_id)
    task = asyncio.create_task(run())
    request.app.state.import_tasks.add(task)
    task.add_done_callback(request.app.state.import_tasks.discard)
