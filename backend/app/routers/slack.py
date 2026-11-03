"""Settings → Slack: channels (incoming webhooks), their events, test and log."""
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from .. import google_calendar as gc, slack
from ..auth import User, current_user, get_con, require
from ..config import Settings, get_settings

router = APIRouter(prefix="/slack", tags=["slack"])
admin = require("manage_settings")
_COLS = "id, name, webhook_hint, events, active, last_daily_date, last_ok_at, last_error, created_at"


async def _view(con: asyncpg.Connection, settings: Settings) -> dict:
    return {
        "events": [{"key": k, **v} for k, v in slack.EVENTS.items()],
        "ready": bool(settings.token_key),
        "channels": [dict(r) for r in await con.fetch(f"SELECT {_COLS} FROM slack_channels ORDER BY created_at")],
        "log": [dict(r) for r in await con.fetch(
            "SELECT l.at, l.event, l.ok, l.message, c.name AS channel FROM slack_log l LEFT JOIN slack_channels c ON c.id = l.channel_id "
            "ORDER BY l.at DESC, l.id DESC LIMIT 30")],
    }


@router.get("")
async def view(con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(current_user)):
    return await _view(con, settings)


def _events(evts: list[str]) -> list[str]:
    bad = set(evts) - set(slack.EVENTS)
    if bad:
        raise HTTPException(422, f"Unknown event: {', '.join(sorted(bad))}.")
    return [k for k in slack.EVENTS if k in evts]


def _webhook(url: str) -> str:
    url = url.strip()
    if not slack.WEBHOOK_RE.match(url):
        raise HTTPException(422, "Paste the channel’s incoming webhook URL. It starts with https://hooks.slack.com/services/")
    return url


class ChannelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    webhook_url: str
    events: Optional[list[str]] = None


@router.post("", status_code=201)
async def add(body: ChannelIn, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(admin)):
    if not settings.token_key:
        raise HTTPException(503, "CRM_TOKEN_KEY isn’t set on the server, so the webhook can’t be stored safely.")
    name = " ".join(body.name.split())[:80]
    if not name:
        raise HTTPException(422, "Name the channel, e.g. #sales-wins.")
    url = _webhook(body.webhook_url)
    events = _events(body.events if body.events is not None else [k for k, v in slack.EVENTS.items() if v["default"]])
    await con.execute("INSERT INTO slack_channels(name, webhook_encrypted, webhook_hint, events, created_by) VALUES ($1, $2, $3, $4, $5)",
                      name, gc.encrypt(settings.token_key, url), "…" + url[-6:], events, UUID(user.id))
    await con.execute("INSERT INTO settings_changes(area, summary, changed_by) VALUES ('Slack', $1, $2)", f"Added Slack channel {name}.", UUID(user.id))
    return await _view(con, settings)


class ChannelPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    webhook_url: Optional[str] = None
    events: Optional[list[str]] = None
    active: Optional[bool] = None


@router.patch("/{channel_id}")
async def change(channel_id: UUID, body: ChannelPatch, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                 user: User = Depends(admin)):
    if not await con.fetchval("SELECT 1 FROM slack_channels WHERE id = $1", channel_id):
        raise HTTPException(404, "Channel not found.")
    if body.name is not None:
        await con.execute("UPDATE slack_channels SET name = $2 WHERE id = $1", channel_id, " ".join(body.name.split())[:80] or "Slack")
    if body.webhook_url is not None:
        url = _webhook(body.webhook_url)
        await con.execute("UPDATE slack_channels SET webhook_encrypted = $2, webhook_hint = $3, last_error = NULL WHERE id = $1",
                          channel_id, gc.encrypt(settings.token_key, url), "…" + url[-6:])
    if body.events is not None:
        await con.execute("UPDATE slack_channels SET events = $2 WHERE id = $1", channel_id, _events(body.events))
    if body.active is not None:
        await con.execute("UPDATE slack_channels SET active = $2 WHERE id = $1", channel_id, body.active)
    return await _view(con, settings)


@router.delete("/{channel_id}")
async def remove(channel_id: UUID, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(admin)):
    name = await con.fetchval("DELETE FROM slack_channels WHERE id = $1 RETURNING name", channel_id)
    if name:
        await con.execute("INSERT INTO settings_changes(area, summary, changed_by) VALUES ('Slack', $1, $2)", f"Removed Slack channel {name}.", UUID(user.id))
    return await _view(con, settings)


@router.post("/{channel_id}/test")
async def test(channel_id: UUID, request: Request, settings: Settings = Depends(get_settings), user: User = Depends(admin)):
    ok = await slack.deliver(request.app.state.pool, settings.token_key, "test",
                             f":wave: Test from LeadStrategus CRM, sent by {slack._esc(user.name)}. Notifications for this channel are working.",
                             transport=getattr(request.app.state, "slack_transport", None), channel_id=channel_id)
    if not ok:
        raise HTTPException(502, "Slack didn’t accept the message. Check the webhook URL (and that the Slack app is still installed).")
    return {"sent": True}


@router.post("/summary-now")
async def summary_now(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(admin)):
    from .. import digest
    sent = await slack.daily_summary(con, request.app.state.pool, settings.token_key, settings.app_url, digest.local_now().date(),
                                     transport=getattr(request.app.state, "slack_transport", None), force=True)
    return {"sent": sent}
