"""
backend/app/slack.py - Slack notifications through incoming webhooks.

Admins add channels (Settings → Slack): a name, the channel's incoming
webhook URL (stored encrypted with CRM_TOKEN_KEY) and the events it wants.
Deal events are posted in the background after the deal is saved, so Slack
being slow or down never affects the CRM; every delivery is logged.
The daily team summary goes out with the hourly job, after the digest hour.
"""
import asyncio
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

import asyncpg
import httpx
from fastapi import Request
from loguru import logger

from . import domain, google_calendar as gc

EVENTS: dict[str, dict[str, Any]] = {
    "deal_won": {"label": "Deal won", "default": True},
    "deal_lost": {"label": "Deal lost", "default": True},
    "deal_created": {"label": "New deal created", "default": False},
    "stage_changed": {"label": "Deal moved to another stage", "default": False},
    "daily_summary": {"label": "Daily team summary (overdue actions, deals going quiet, wins)", "default": True},
}
WEBHOOK_RE = re.compile(r"^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,200}$")


def _money(v: Any, cur: str) -> str:
    sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(cur, f"{cur} ")
    return f"{sym}{Decimal(v or 0):,.0f}"


def _esc(s: str) -> str:   # Slack mrkdwn escaping
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def post(client: httpx.AsyncClient, webhook: str, text: str, blocks: Optional[list] = None) -> None:
    body: dict = {"text": text}
    if blocks:
        body["blocks"] = blocks
    r = await client.post(webhook, json=body, timeout=10)
    if r.status_code >= 300:
        raise RuntimeError(f"Slack said {r.status_code}: {r.text[:120]}")


async def deliver(pool: asyncpg.Pool, token_key: str, event: str, text: str, blocks: Optional[list] = None,
                  transport: Optional[httpx.AsyncBaseTransport] = None, channel_id: Optional[UUID] = None) -> int:
    """Post to every active channel subscribed to `event` (or one channel). Returns how many succeeded."""
    async with pool.acquire() as con:
        rows = await con.fetch(
            "SELECT id, name, webhook_encrypted FROM slack_channels WHERE active AND ($1::uuid IS NOT NULL AND id = $1 OR $1::uuid IS NULL AND $2 = ANY(events))",
            channel_id, event)
        ok = 0
        async with httpx.AsyncClient(transport=transport) as client:
            for r in rows:
                try:
                    await post(client, gc.decrypt(token_key, r["webhook_encrypted"]), text, blocks)
                    await con.execute("UPDATE slack_channels SET last_ok_at = now(), last_error = NULL WHERE id = $1", r["id"])
                    await con.execute("INSERT INTO slack_log(channel_id, event, ok, message) VALUES ($1, $2, true, $3)", r["id"], event, text[:300])
                    ok += 1
                except (httpx.HTTPError, RuntimeError, gc.CalendarError) as e:
                    msg = getattr(e, "message", None) or str(e) or type(e).__name__
                    logger.warning(f"Slack post to {r['name']} failed: {msg}")
                    await con.execute("UPDATE slack_channels SET last_error = $2 WHERE id = $1", r["id"], msg[:300])
                    await con.execute("INSERT INTO slack_log(channel_id, event, ok, message) VALUES ($1, $2, false, $3)", r["id"], event, f"{msg[:200]} · {text[:100]}")
        return ok


def _spawn(request: Request, coro) -> None:
    task = asyncio.create_task(coro)
    request.app.state.import_tasks.add(task)
    task.add_done_callback(request.app.state.import_tasks.discard)


async def _deal_text(con: asyncpg.Connection, opp_id: UUID, app_url: str) -> Optional[dict]:
    r = await con.fetchrow(
        "SELECT o.*, a.name AS account_name, u.name AS owner_name FROM opportunities o JOIN accounts a ON a.id = o.account_id "
        "LEFT JOIN users u ON u.id = o.owner_id WHERE o.id = $1", opp_id)
    if r is None:
        return None
    d = dict(r)
    d["link"] = f"{app_url}/opportunities/{opp_id}"
    d["title"] = f"<{d['link']}|{_esc(d['name'])}>"
    return d


def deal_event(request: Request, before: Optional[dict], after: dict, actor_name: str) -> None:
    """Called after a deal is saved. Works out the event and posts it in the background."""
    from .followups import _settings

    settings = _settings(request)
    if not settings.token_key:
        return
    stage, prev = after.get("stage"), (before or {}).get("stage")
    if before is None:
        event = "deal_created"
    elif stage != prev and stage == domain.WON:
        event = "deal_won"
    elif stage != prev and stage == domain.LOST:
        event = "deal_lost"
    elif stage != prev:
        event = "stage_changed"
    else:
        return
    pool = request.app.state.pool
    transport = getattr(request.app.state, "slack_transport", None)

    async def run() -> None:
        async with pool.acquire() as con:
            if not await con.fetchval("SELECT 1 FROM slack_channels WHERE active AND $1 = ANY(events) LIMIT 1", event):
                return
            d = await _deal_text(con, after["id"], settings.app_url)
        if d is None:
            return
        who = _esc(d["owner_name"] or actor_name)
        acct = _esc(d["account_name"])
        if event == "deal_won":
            text = f":tada: *{who}* won {d['title']} ({acct}) for *{_money(d['actual_value'] or d['estimated_value'], d['currency'])}*"
        elif event == "deal_lost":
            text = f":small_red_triangle_down: {d['title']} ({acct}) was lost: {_esc(d['lost_reason'] or 'no reason given')}"
        elif event == "deal_created":
            value = f" · {_money(d['estimated_value'], d['currency'])}" if d["estimated_value"] else ""
            text = f":sparkles: New deal {d['title']} ({acct}){value} · owner {who}"
        else:
            text = f":arrow_right: {d['title']} ({acct}) moved {_esc(prev or '')} → *{_esc(stage)}*" + (f" · {_money(d['estimated_value'], d['currency'])}" if d["estimated_value"] else "")
        await deliver(pool, settings.token_key, event, text, transport=transport)

    _spawn(request, run())


async def daily_summary(con: asyncpg.Connection, pool: asyncpg.Pool, token_key: str, app_url: str, today: date,
                        transport: Optional[httpx.AsyncBaseTransport] = None, force: bool = False) -> int:
    """The team summary, once a day per channel."""
    from . import alerts
    from .routers.actions import collect

    channels = await con.fetch("SELECT id FROM slack_channels WHERE active AND 'daily_summary' = ANY(events) "
                               "AND ($2 OR last_daily_date IS DISTINCT FROM $1)", today, force)
    if not channels:
        return 0
    team = await collect(con, None, today)
    quiet = await alerts.stale_deals(con, None, today)
    won = await con.fetch("SELECT o.name, o.currency, o.actual_value, u.name AS owner FROM opportunities o LEFT JOIN users u ON u.id = o.owner_id "
                          "WHERE o.stage = 'Won' AND o.won_date >= $1::date - 7 ORDER BY o.won_date DESC LIMIT 5", today)
    per: dict[str, int] = {}
    for i in team["overdue"]:
        per[i["owner_name"] or "Unassigned"] = per.get(i["owner_name"] or "Unassigned", 0) + 1
    lines = [f"*CRM summary · {today.strftime('%a %d %b')}*"]
    c = team["counts"]
    lines.append(f"• {c['overdue']} overdue next action{'s' if c['overdue'] != 1 else ''}" + (f" ({c['escalated']} escalated)" if c["escalated"] else "")
                 + (": " + ", ".join(f"{_esc(k)} {v}" for k, v in sorted(per.items(), key=lambda x: -x[1])) if per else ""))
    lines.append(f"• {c['today']} due today")
    if quiet:
        lines.append(f"• {len(quiet)} deal{'s' if len(quiet) != 1 else ''} going quiet: " + ", ".join(
            f"<{app_url}/opportunities/{d['id']}|{_esc(d['name'])}>" for d in quiet[:5]) + (" …" if len(quiet) > 5 else ""))
    if won:
        lines.append("• Won in the last 7 days: " + ", ".join(f"{_esc(w['name'])} ({_money(w['actual_value'], w['currency'])}, {_esc(w['owner'] or '')})" for w in won))
    lines.append(f"<{app_url}/|Open the CRM>")
    sent = 0
    for ch in channels:
        if await deliver(pool, token_key, "daily_summary", "\n".join(lines), transport=transport, channel_id=ch["id"]):
            await con.execute("UPDATE slack_channels SET last_daily_date = $2 WHERE id = $1", ch["id"], today)
            sent += 1
    return sent
