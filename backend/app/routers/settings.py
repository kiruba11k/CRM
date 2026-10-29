"""Settings (§8): controlled lists, stage probabilities, reminder settings,
the shared launch checklist (§9, §10) and an audit of every change.

Admins change lists, stages and reminders; managers and admins tick the
launch checklist; everyone can read the current settings.
"""
import re
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from .. import domain, listconfig
from ..auth import User, current_user, get_con, require_admin

router = APIRouter(prefix="/settings", tags=["settings"])

LABELS = {
    "sources": "Sources", "nurture_reasons": "Nurture reasons", "lost_reasons": "Lost reasons",
    "service_lines": "Service lines", "account_statuses": "Account statuses", "currencies": "Currencies",
}
# Where each list's values are stored on records (renames update these).
COLUMNS = {
    "sources": [("prospects", "source"), ("opportunities", "deal_source")],
    "nurture_reasons": [("opportunities", "nurture_reason")],
    "lost_reasons": [("opportunities", "lost_reason")],
    "service_lines": [("opportunities", "service_line")],
    "account_statuses": [("accounts", "status")],
    "currencies": [("opportunities", "currency")],
}
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
REMINDER_LABELS = {
    "meeting_15": "15-minute meeting reminder", "meeting_day": "Day-before meeting reminder",
    "due_before": "Next-business-day flag", "escalation": "Manager escalation", "escalation_days": "Escalate after",
}

LAUNCH_ITEMS: list[tuple[str, str, str, str]] = [
    ("d_platform", "decision", "Build platform", "Custom build: FastAPI, Neon PostgreSQL, React + TypeScript, Render"),
    ("d_users", "decision", "Number of users", "Design for a small team; confirm the count"),
    ("d_currency", "decision", "Currency", "Multi-currency with no summing until an FX rule is agreed"),
    ("d_access", "decision", "Access rules", "Shared visibility, owner editing, manager/admin oversight"),
    ("d_geo", "decision", "Geography depth", "Country required; region/city optional"),
    ("d_stages", "decision", "Opportunity stages", "Starter stages and probabilities from §3"),
    ("d_statuses", "decision", "Prospect statuses", "List from §3"),
    ("d_calendar", "decision", "Google Calendar", "Implement first"),
    ("d_gmail", "decision", "Gmail", "Contextual links first"),
    ("d_tasks", "decision", "Google Tasks", "Defer"),
    ("d_services", "decision", "Service-line list", "Confirm exact services"),
    ("d_reminders", "decision", "Reminder defaults", "Start with §5 defaults, adjust after pilot"),
    ("t_relationships", "test", "Record relationships", "One account, many contacts and opportunities, no duplicate accounts"),
    ("t_lifecycle", "test", "Prospect lifecycle", "Statuses move freely; a qualified pursuit becomes an opportunity without losing history"),
    ("t_views", "test", "Consistent views", "One update shows in every saved view and report"),
    ("t_dropdown", "test", "Next Action dropdown", "Only listed options or Other; same list for prospects and opportunities"),
    ("t_other", "test", "Other validation", "Description required, 50 characters max"),
    ("t_followup", "test", "Mandatory follow-up", "Active prospects and open non-nurtured opportunities need owner, action and due date"),
    ("t_risk", "test", "Risk validation", "Qualified needs a rating; High needs reason and mitigation"),
    ("t_nurture", "test", "Nurture validation", "Yes needs reason, revisit date and action; stage is kept"),
    ("t_nurture_forecast", "test", "Nurture reminders/forecast", "In Nurture Pipeline, out of active forecast, only revisit reminder"),
    ("t_closure", "test", "Closure", "Won needs value and date; Lost needs reason and date; reminders stop"),
    ("t_calendar", "test", "Calendar idempotency", "Updating an event never duplicates it; failures visible and retryable"),
    ("t_permissions", "test", "Permissions", "Access matches the agreed role model"),
    ("t_export", "test", "Export / recovery", "CSV export works; backup and restore documented"),
]
_ITEM_KEYS = {k for k, *_ in LAUNCH_ITEMS}


class _In(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class OptionIn(_In):
    value: str


class OptionPatch(_In):
    value: str
    rename_to: Optional[str] = None
    active: Optional[bool] = None


class OrderIn(_In):
    values: list[str]


class StagesIn(_In):
    probabilities: dict[str, int]


class RemindersIn(_In):
    meeting_15: Optional[bool] = None
    meeting_day: Optional[bool] = None
    due_before: Optional[bool] = None
    escalation: Optional[bool] = None
    escalation_days: Optional[int] = None


class ChecklistPatch(_In):
    done: Optional[bool] = None
    note: Optional[str] = None


def _list_key(key: str) -> str:
    if key not in domain.EDITABLE_LISTS:
        raise HTTPException(404, "That list isn’t editable. Next actions, stages, prospect statuses and risk ratings are fixed v2 rules.")
    return key


async def _audit(con: asyncpg.Connection, area: str, summary: str, user: User) -> None:
    await con.execute("INSERT INTO settings_changes(area, summary, changed_by) VALUES ($1, $2, $3)", area, summary, UUID(user.id))


async def _in_use(con: asyncpg.Connection, key: str, value: str) -> int:
    n = 0
    for table, col in COLUMNS[key]:
        n += await con.fetchval(f"SELECT count(*) FROM {table} WHERE {col} = $1", value)
    return n


def _check_value(key: str, value: str) -> str:
    value = (value or "").strip()
    if key == "currencies":
        value = value.upper()
        if not CURRENCY_RE.match(value):
            raise HTTPException(422, "Use a three-letter ISO currency code, e.g. CHF.")
    elif not 1 <= len(value) <= 80:
        raise HTTPException(422, "Options need 1 to 80 characters.")
    return value


async def _applied(con: asyncpg.Connection) -> None:
    await listconfig.load(con)


# ── Read ──────────────────────────────────────────────────────────────

@router.get("")
async def get_settings_view(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    lists = {}
    for key in domain.EDITABLE_LISTS:
        rows = await con.fetch("SELECT value, active, position FROM list_options WHERE list_key = $1 ORDER BY position, value", key)
        usage: dict[str, int] = {}
        for table, col in COLUMNS[key]:
            for r in await con.fetch(f"SELECT {col} AS v, count(*) AS n FROM {table} WHERE {col} IS NOT NULL GROUP BY {col}"):
                usage[r["v"]] = usage.get(r["v"], 0) + r["n"]
        lists[key] = {
            "label": LABELS[key],
            "options": [{"value": r["value"], "active": r["active"], "in_use": usage.get(r["value"], 0),
                         "protected": r["value"] in domain.PROTECTED[key]} for r in rows],
        }
    return {
        "lists": lists,
        "stages": [{"name": s, "probability": p, "editable": s not in domain.CLOSED_STAGES, "default": domain.DEFAULT_PROBABILITIES[s]}
                   for s, p in domain.STAGES],
        "reminders": dict(domain.REMINDERS),
        "reminder_defaults": dict(domain.DEFAULT_REMINDERS),
    }


@router.get("/changes")
async def changes(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(
        "SELECT c.area, c.summary, c.changed_at, u.name AS changed_by FROM settings_changes c "
        "LEFT JOIN users u ON u.id = c.changed_by ORDER BY c.changed_at DESC, c.id DESC LIMIT 100")
    return [dict(r) for r in rows]


# ── Controlled lists (admin) ──────────────────────────────────────────

@router.post("/lists/{key}", status_code=201)
async def add_option(key: str, body: OptionIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    key = _list_key(key)
    value = _check_value(key, body.value)
    existing = await con.fetchrow("SELECT active FROM list_options WHERE list_key = $1 AND lower(value) = lower($2)", key, value)
    if existing is not None:
        raise HTTPException(409, f"“{value}” is already in {LABELS[key]}{'' if existing['active'] else ' (retired: turn it back on instead)'}.")
    async with con.transaction():
        pos = await con.fetchval("SELECT coalesce(max(position), -1) + 1 FROM list_options WHERE list_key = $1", key)
        await con.execute("INSERT INTO list_options(list_key, value, position) VALUES ($1, $2, $3)", key, value, pos)
        await _audit(con, LABELS[key], f"Added “{value}”.", user)
    await _applied(con)
    return await get_settings_view(con, user)


@router.patch("/lists/{key}")
async def change_option(key: str, body: OptionPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    """Rename (updates every record using it) and/or retire / restore."""
    key = _list_key(key)
    row = await con.fetchrow("SELECT value, active FROM list_options WHERE list_key = $1 AND value = $2", key, body.value)
    if row is None:
        raise HTTPException(404, f"“{body.value}” isn’t in {LABELS[key]}.")
    protected = body.value in domain.PROTECTED[key]
    async with con.transaction():
        if body.active is not None and body.active != row["active"]:
            if not body.active:
                if protected:
                    raise HTTPException(409, f"“{body.value}” is used by the CRM itself (e.g. as the import fallback), so it can’t be retired.")
                left = await con.fetchval("SELECT count(*) FROM list_options WHERE list_key = $1 AND active AND value <> $2", key, body.value)
                if not left:
                    raise HTTPException(409, f"{LABELS[key]} needs at least one active option.")
            await con.execute("UPDATE list_options SET active = $3, updated_at = now() WHERE list_key = $1 AND value = $2", key, body.value, body.active)
            used = await _in_use(con, key, body.value)
            await _audit(con, LABELS[key], (f"Retired “{body.value}” ({used} record(s) keep it)." if not body.active else f"Restored “{body.value}”."), user)
        if body.rename_to is not None and body.rename_to != body.value:
            if key == "currencies":
                raise HTTPException(422, "Currency codes can’t be renamed: add the new code and retire the old one.")
            if protected:
                raise HTTPException(409, f"“{body.value}” is used by the CRM itself, so it can’t be renamed.")
            new = _check_value(key, body.rename_to)
            if await con.fetchval("SELECT 1 FROM list_options WHERE list_key = $1 AND lower(value) = lower($2) AND value <> $3", key, new, body.value):
                raise HTTPException(409, f"“{new}” is already in {LABELS[key]}.")
            await con.execute("UPDATE list_options SET value = $3, updated_at = now() WHERE list_key = $1 AND value = $2", key, body.value, new)
            moved = 0
            for table, col in COLUMNS[key]:
                moved += int((await con.execute(f"UPDATE {table} SET {col} = $2 WHERE {col} = $1", body.value, new)).split()[-1])
            await _audit(con, LABELS[key], f"Renamed “{body.value}” to “{new}” on {moved} record(s).", user)
    await _applied(con)
    return await get_settings_view(con, user)


@router.put("/lists/{key}/order")
async def reorder(key: str, body: OrderIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    key = _list_key(key)
    current = {r["value"] for r in await con.fetch("SELECT value FROM list_options WHERE list_key = $1", key)}
    if set(body.values) != current or len(body.values) != len(current):
        raise HTTPException(422, "Send every option of the list exactly once.")
    async with con.transaction():
        await con.executemany("UPDATE list_options SET position = $3, updated_at = now() WHERE list_key = $1 AND value = $2",
                              [(key, v, i) for i, v in enumerate(body.values)])
        await _audit(con, LABELS[key], "Changed the order.", user)
    await _applied(con)
    return await get_settings_view(con, user)


# ── Stage probabilities and reminders (admin) ─────────────────────────

@router.put("/stages")
async def set_stages(body: StagesIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    open_stages = [s for s, _ in domain.STAGES if s not in domain.CLOSED_STAGES]
    unknown = set(body.probabilities) - set(open_stages)
    if unknown:
        raise HTTPException(422, f"Only open stages take a probability (Won is 100%, Lost 0%); unknown: {', '.join(sorted(unknown))}.")
    probs = {**{s: p for s, p in domain.STAGES if s in open_stages}, **body.probabilities}
    seq = [probs[s] for s in open_stages]
    if any(not 1 <= p <= 99 for p in seq) or any(b <= a for a, b in zip(seq, seq[1:])):
        raise HTTPException(422, "Probabilities must be between 1% and 99% and rise with each stage.")
    before = dict(domain.STAGES)
    async with con.transaction():
        await listconfig.save_setting(con, "stage_probabilities", probs, user.id)
        diff = [f"{s} {before[s]}% → {probs[s]}%" for s in open_stages if before[s] != probs[s]]
        await _audit(con, "Stage probabilities", ("Changed " + ", ".join(diff) + ".") if diff else "No change.", user)
    await _applied(con)
    return await get_settings_view(con, user)


@router.put("/reminders")
async def set_reminders(body: RemindersIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    patch = body.model_dump(exclude_unset=True, exclude_none=True)
    if "escalation_days" in patch and not 1 <= patch["escalation_days"] <= 20:
        raise HTTPException(422, "Escalate after 1 to 20 business days.")
    new = {**domain.REMINDERS, **patch}
    async with con.transaction():
        await listconfig.save_setting(con, "reminders", new, user.id)
        show = lambda v: ("on" if v else "off") if isinstance(v, bool) else f"{v} business day(s)"  # noqa: E731
        diff = [f"{REMINDER_LABELS[k]} {show(domain.REMINDERS[k])} → {show(v)}" for k, v in new.items() if domain.REMINDERS.get(k) != v]
        await _audit(con, "Reminders", ("Changed " + ", ".join(diff) + ".") if diff else "No change.", user)
    await _applied(con)
    return await get_settings_view(con, user)


# ── Launch checklist (managers and admins) ────────────────────────────

async def _checklist(con: asyncpg.Connection) -> list[dict]:
    state = {r["item_key"]: r for r in await con.fetch(
        "SELECT c.item_key, c.done, c.note, c.updated_at, u.name AS updated_by FROM launch_checklist c LEFT JOIN users u ON u.id = c.updated_by")}
    out = []
    for key, kind, name, detail in LAUNCH_ITEMS:
        r = state.get(key)
        out.append({"key": key, "kind": kind, "name": name, "detail": detail, "done": bool(r and r["done"]),
                    "note": r["note"] if r else None, "updated_by": r["updated_by"] if r else None, "updated_at": r["updated_at"] if r else None})
    return out


@router.get("/checklist")
async def get_checklist(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return await _checklist(con)


@router.patch("/checklist/{item_key}")
async def update_checklist(item_key: str, body: ChecklistPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    if not user.can_edit_all:
        raise HTTPException(403, "Managers and admins sign off the launch checklist.")
    if item_key not in _ITEM_KEYS:
        raise HTTPException(404, "Checklist item not found.")
    patch = body.model_dump(exclude_unset=True)
    name = next(n for k, _, n, _ in LAUNCH_ITEMS if k == item_key)
    async with con.transaction():
        await con.execute(
            "INSERT INTO launch_checklist(item_key, done, note, updated_by) VALUES ($1, coalesce($2, false), $3, $4) "
            "ON CONFLICT (item_key) DO UPDATE SET done = coalesce($2, launch_checklist.done), "
            "note = CASE WHEN $5 THEN $3 ELSE launch_checklist.note END, updated_by = $4, updated_at = now()",
            item_key, patch.get("done"), patch.get("note") or None, UUID(user.id), "note" in patch)
        if "done" in patch:
            await _audit(con, "Launch checklist", f"{'Ticked' if patch['done'] else 'Unticked'} “{name}”.", user)
    return await _checklist(con)
