"""
backend/app/digest.py - the daily digest email.

Everyone gets their own overdue and due-today next actions, what's due next,
deals going quiet and their quarter so far. Managers and admins also get a
team summary (overdue per person, escalations, quiet deals). A user with
nothing to act on gets no email that day.

`run` is called by a scheduled job every hour; it sends once per user per
local day, after the admin-set hour, and retries a failed send up to 3 times.
"""
import html
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import asyncpg
from loguru import logger

from . import alerts, domain, quotas
from .mailer import Mailer, MailError
from .routers.actions import collect

MAX_ATTEMPTS = 3
MAX_LINES = 10


def local_now(now: Optional[datetime] = None) -> datetime:
    try:
        tz = ZoneInfo(domain.REMINDERS.get("digest_time_zone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    return (now or datetime.now(timezone.utc)).astimezone(tz)


def money(cur: str, v) -> str:
    return f"{cur} {Decimal(v or 0):,.0f}"


def _plural(n: int, word: str, many: Optional[str] = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


async def build(con: asyncpg.Connection, user: dict, today: date, app_url: str) -> dict:
    uid = user["id"] if isinstance(user["id"], UUID) else UUID(str(user["id"]))
    mine = await collect(con, uid, today)
    quiet = await alerts.stale_deals(con, uid, today)
    q = await quotas.attainment(con, quotas.period_of(today), today, uid)
    manager = "team_view" in (user.get("permissions") or [])
    team = await collect(con, None, today) if manager else None
    team_quiet = await alerts.stale_deals(con, None, today) if manager else []

    soon = [i for i in mine["upcoming"] if i["days_until"] <= 1]
    revisits = [i for i in mine["nurture"] if i["days_until"] is not None and i["days_until"] <= 0]
    team_over: dict[str, int] = {}
    if team:
        for i in team["overdue"]:
            team_over[i["owner_name"] or "Unassigned"] = team_over.get(i["owner_name"] or "Unassigned", 0) + 1

    worth = bool(mine["done_in_google"] or mine["overdue"] or mine["today"] or soon or quiet or revisits or (manager and (team_over or team_quiet)))
    parts = []
    if mine["overdue"]:
        parts.append(f"{len(mine['overdue'])} overdue")
    if mine["today"]:
        parts.append(f"{len(mine['today'])} due today")
    if quiet:
        parts.append(_plural(len(quiet), "deal") + " going quiet")
    if not parts and manager and team_over:
        parts.append(f"team: {sum(team_over.values())} overdue")
    subject = "Your CRM day: " + (", ".join(parts) if parts else "all clear")

    link = lambda kind, id_: f"{app_url}/{'prospects' if kind == 'prospect' else 'opportunities'}/{id_}"  # noqa: E731
    first = (user.get("name") or user["email"]).split(" ")[0]
    sections: list[tuple[str, list[tuple[str, str, str]]]] = []  # (heading, [(text, detail, url)])

    def action_lines(items, detail):
        return [(f"{i['label']}: {i['title']}", f"{i['account_name'] or ''} · {detail(i)}", link(i["kind"], i["id"]))
                for i in items[:MAX_LINES]]

    if mine["done_in_google"]:
        sections.append((f"Done in Google Tasks: set the next action ({len(mine['done_in_google'])})", action_lines(
            mine["done_in_google"], lambda i: "ticked off in Google")))
    if mine["overdue"]:
        sections.append((f"Overdue ({len(mine['overdue'])})", action_lines(
            mine["overdue"], lambda i: f"{i['business_days_overdue']} business day(s) late" + (" · escalated" if i.get("escalated") else ""))))
    if mine["today"]:
        sections.append((f"Due today ({len(mine['today'])})", action_lines(
            mine["today"], lambda i: i["due_time"].strftime("%H:%M") if i.get("due_time") else "today")))
    if soon:
        sections.append((f"Due tomorrow ({len(soon)})", action_lines(soon, lambda i: i["due"].strftime("%a %d %b"))))
    if revisits:
        sections.append((f"Nurture revisits due ({len(revisits)})", [
            (f"Revisit: {i['title']}", f"{i['account_name'] or ''} · {i['nurture_reason'] or ''}", f"{app_url}/opportunities/{i['id']}")
            for i in revisits[:MAX_LINES]]))
    if quiet:
        sections.append((f"Deals going quiet ({len(quiet)})", [
            (f"{d['name']}", f"{d['account_name']} · {d['stage']} · " + "; ".join(r["label"] for r in d["reasons"]), f"{app_url}/opportunities/{d['id']}")
            for d in quiet[:MAX_LINES]]))
    quarter = []
    if q["rows"]:
        for line in q["rows"][0]["by_currency"]:
            if line["target"]:
                quarter.append(f"{money(line['currency'], line['won'])} won of {money(line['currency'], line['target'])} "
                               f"({line['attainment']:.0f}%), {line['projected']:.0f}% with weighted pipeline")
            elif line["won"]:
                quarter.append(f"{money(line['currency'], line['won'])} won (no target set)")
    if manager and team:
        lines = [(f"{name}: {n} overdue", "", f"{app_url}/") for name, n in sorted(team_over.items(), key=lambda x: -x[1])]
        esc = team["counts"]["escalated"]
        if esc:
            lines.append((f"{_plural(esc, 'action')} escalated to managers", "", f"{app_url}/"))
        if team_quiet:
            lines.append((f"{_plural(len(team_quiet), 'deal')} going quiet across the team", "", f"{app_url}/pipeline"))
        if lines:
            sections.append(("Team", lines))

    days_left = q["days_total"] - q["days_elapsed"]
    head = f"Good morning {first}. Here's what needs you today."
    text = [head, ""]
    for h, lines in sections:
        text.append(h.upper())
        text += [f"- {t}" + (f" ({d})" if d else "") + f"\n  {u}" for t, d, u in lines]
        text.append("")
    if quarter:
        text += [f"YOUR QUARTER ({q['period']}, {days_left} days left)"] + [f"- {x}" for x in quarter] + [""]
    text += [f"Open My Actions: {app_url}/", "", "Turn this email off in the CRM: Settings → Reminders → My daily digest."]

    e = html.escape
    body = [f'<p style="margin:0 0 16px;font-size:15px">{e(head)}</p>']
    for h, lines in sections:
        body.append(f'<h3 style="margin:20px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#5b6170">{e(h)}</h3>')
        body.append('<table role="presentation" style="width:100%;border-collapse:collapse">')
        for t, d, u in lines:
            body.append(f'<tr><td style="padding:7px 0;border-bottom:1px solid #eceef3"><a href="{e(u)}" style="color:#1d2433;font-weight:600;text-decoration:none">{e(t)}</a>'
                        + (f'<br><span style="color:#6b7280;font-size:13px">{e(d)}</span>' if d else "") + "</td></tr>")
        body.append("</table>")
    if quarter:
        body.append(f'<h3 style="margin:20px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#5b6170">Your quarter ({e(q["period"])}, {days_left} days left)</h3>')
        body += [f'<p style="margin:4px 0">{e(x)}</p>' for x in quarter]
    body.append(f'<p style="margin:24px 0 8px"><a href="{e(app_url)}/" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open My Actions</a></p>')
    body.append('<p style="color:#9ca3af;font-size:12px;margin-top:20px">Turn this email off in the CRM: Settings → Reminders → My daily digest.</p>')
    page = ('<!doctype html><html><body style="margin:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#1d2433">'
            '<div style="max-width:600px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e6e8ef">'
            '<div style="font-weight:700;color:#4f46e5;margin-bottom:12px">LeadStrategus CRM</div>'
            + "".join(body) + "</div></div></body></html>")
    return {"subject": subject, "html": page, "text": "\n".join(text), "worth_sending": worth,
            "counts": {"overdue": len(mine["overdue"]), "today": len(mine["today"]), "tomorrow": len(soon), "quiet": len(quiet)}}


async def _claim(con: asyncpg.Connection, user_id: UUID, day: date) -> bool:
    row = await con.fetchrow(
        "INSERT INTO digest_log(user_id, digest_date, status) VALUES ($1, $2, 'sending') "
        "ON CONFLICT (user_id, digest_date) DO UPDATE SET status = 'sending', attempts = digest_log.attempts + 1, updated_at = now() "
        "WHERE digest_log.status = 'failed' AND digest_log.attempts < $3 RETURNING id", user_id, day, MAX_ATTEMPTS)
    return row is not None


async def _mark(con: asyncpg.Connection, user_id: UUID, day: date, status: str, detail: Optional[str] = None) -> None:
    await con.execute("UPDATE digest_log SET status = $3, detail = $4, updated_at = now() WHERE user_id = $1 AND digest_date = $2",
                      user_id, day, status, detail)


async def run(con: asyncpg.Connection, mailer: Mailer, app_url: str, now: Optional[datetime] = None, force: bool = False) -> dict:
    """Send today's digests that are due. `force` ignores the hour and weekday
    (an admin pressing "Send now"), never the once-a-day rule."""
    rem = domain.REMINDERS
    local = local_now(now)
    day = local.date()
    base = {"date": day, "time_zone": str(local.tzinfo), "sent": 0, "skipped": 0, "failed": 0, "already": 0}
    if not rem.get("digest") and not force:
        return {**base, "status": "off"}
    if not force:
        if rem.get("digest_weekdays_only") and local.weekday() >= 5:
            return {**base, "status": "weekend"}
        if local.hour < int(rem.get("digest_hour", 8)):
            return {**base, "status": "too_early"}
    if not mailer.configured:
        return {**base, "status": "not_configured"}
    users = await con.fetch("SELECT u.id, u.email, u.name, u.role, r.permissions FROM users u JOIN roles r ON r.key = u.role "
                            "WHERE u.active AND u.digest_enabled ORDER BY u.email")
    for u in users:
        if not await _claim(con, u["id"], day):
            base["already"] += 1
            continue
        try:
            d = await build(con, dict(u), day, app_url)
            if not d["worth_sending"]:
                await _mark(con, u["id"], day, "skipped", "Nothing due")
                base["skipped"] += 1
                continue
            await mailer.send(u["email"], d["subject"], d["html"], d["text"])
            await _mark(con, u["id"], day, "sent", d["subject"])
            base["sent"] += 1
        except MailError as e:
            logger.warning(f"Digest to {u['email']} failed: {e}")
            await _mark(con, u["id"], day, "failed", str(e)[:300])
            base["failed"] += 1
        except Exception as e:  # never let one user stop the rest
            logger.exception(f"Digest for {u['email']} failed")
            await _mark(con, u["id"], day, "failed", f"Unexpected error: {type(e).__name__}")
            base["failed"] += 1
    return {**base, "status": "done"}
