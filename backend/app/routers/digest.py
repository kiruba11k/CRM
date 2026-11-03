"""Daily digest email: personal preference, preview, test send and the
scheduled run (called hourly by .github/workflows/daily-digest.yml, which
also runs Gmail auto-logging)."""
import hmac
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from .. import digest, domain, listconfig
from ..auth import User, current_user, get_con, require_admin
from ..config import Settings, get_settings
from ..mailer import Mailer, MailError

router = APIRouter(prefix="/digest", tags=["digest"])


def get_mailer(request: Request) -> Mailer:
    m = getattr(request.app.state, "mailer", None)
    if m is None:
        m = request.app.state.mailer = Mailer(get_settings())
    return m


async def _me(con: asyncpg.Connection, user: User, mailer: Mailer) -> dict:
    row = await con.fetchrow("SELECT id, email, name, role, digest_enabled FROM users WHERE id = $1", UUID(user.id))
    last = await con.fetchrow("SELECT digest_date, status, detail, updated_at FROM digest_log WHERE user_id = $1 "
                              "ORDER BY digest_date DESC LIMIT 1", UUID(user.id))
    rem = domain.REMINDERS
    return {"enabled": row["digest_enabled"], "email": row["email"], "configured": mailer.configured,
            "schedule": {"on": rem.get("digest"), "hour": rem.get("digest_hour"), "time_zone": rem.get("digest_time_zone"),
                         "weekdays_only": rem.get("digest_weekdays_only")},
            "last": dict(last) if last else None}


@router.get("/me")
async def me(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user), mailer: Mailer = Depends(get_mailer)):
    return await _me(con, user, mailer)


class PrefIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


@router.patch("/me")
async def set_me(body: PrefIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
                 mailer: Mailer = Depends(get_mailer)):
    await con.execute("UPDATE users SET digest_enabled = $2 WHERE id = $1", UUID(user.id), body.enabled)
    return await _me(con, user, mailer)


async def _build_for(con: asyncpg.Connection, user: User, settings: Settings) -> dict:
    row = await con.fetchrow("SELECT id, email, name, role FROM users WHERE id = $1", UUID(user.id))
    return await digest.build(con, {**dict(row), "permissions": user.permissions}, digest.local_now().date(), settings.app_url)


@router.get("/preview")
async def preview(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
                  settings: Settings = Depends(get_settings)):
    return await _build_for(con, user, settings)


@router.post("/test")
async def send_test(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
                    settings: Settings = Depends(get_settings), mailer: Mailer = Depends(get_mailer)):
    if not mailer.configured:
        raise HTTPException(422, "Email isn’t set up on the server yet: add CRM_SMTP_HOST, CRM_SMTP_USER and CRM_SMTP_PASSWORD on Render.")
    d = await _build_for(con, user, settings)
    try:
        await mailer.send(user.email, "[Test] " + d["subject"], d["html"], d["text"])
    except MailError as e:
        raise HTTPException(502, str(e)) from e
    return {"sent_to": user.email, "subject": d["subject"]}


@router.post("/run")
async def run_now(con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin),
                  settings: Settings = Depends(get_settings), mailer: Mailer = Depends(get_mailer)):
    """Admin: send today's digests now (anyone already sent today is skipped)."""
    return await digest.run(con, mailer, settings.app_url, force=True)


@router.post("/cron")
async def cron(request: Request, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
               mailer: Mailer = Depends(get_mailer), x_cron_secret: Optional[str] = Header(default=None)):
    if not settings.cron_secret or not x_cron_secret or not hmac.compare_digest(x_cron_secret, settings.cron_secret):
        raise HTTPException(403, "Bad or missing X-Cron-Secret.")
    await listconfig.ensure_fresh(con, 0)
    from .. import insights
    await insights.take_snapshot(con)   # daily pipeline snapshot for the trend on Reports
    # Gmail auto-logging rides on the same hourly call, before the digest so
    # today's emails count as activity.
    gmail = None
    if not settings.calendar_missing:
        from .. import gmailsync
        from .calendar import _google
        gmail = await gmailsync.sync_all(con, _google(request, settings), settings)
        from .. import tasksync
        await tasksync.pull_all(request, con, _google(request, settings), settings)
    return {**await digest.run(con, mailer, settings.app_url), "gmail": gmail}
