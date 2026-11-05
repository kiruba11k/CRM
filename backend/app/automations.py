"""Workflow automation (CRM review P2): simple "when … then …" rules that an
admin sets up in Settings → Automations.

  When a deal is created / moves to a stage, or a contact is created / gets a
  status → set the next action (N business days ahead), assign an owner, add
  it to a list, or log a note on it.

Rules run inside the same save, after the record passes its usual checks.
What they change is written straight to the record (with history and a
timeline note naming the rule), so a rule never triggers another rule.
"""
import json
from datetime import date, timedelta
from typing import Any, Optional
from uuid import UUID

import asyncpg
from loguru import logger

from . import domain
from .records import log_activity, record_changes

TABLE = {"opportunity": "opportunities", "prospect": "prospects"}


def add_business_days(start: date, n: int) -> date:
    d = start
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def _fired(rule: dict, entity: str, before: Optional[dict], after: dict) -> bool:
    if rule["trigger"] == "created":
        return before is None
    field = "stage" if entity == "opportunity" else "status"
    if rule["trigger"] != f"{field}_changed" or before is None or before[field] == after[field]:
        return False
    return rule["trigger_value"] in (None, "", after[field])


def _open(entity: str, rec: dict) -> bool:
    if entity == "opportunity":
        return rec["stage"] not in domain.CLOSED_STAGES and not rec["on_nurture"]
    return rec["status"] not in domain.CLOSED_PROSPECT_STATUSES


async def run(con: asyncpg.Connection, entity: str, before: Optional[dict], after: dict, user_id: str) -> dict:
    """Apply every active rule that this save fires. Returns the record as it now stands."""
    rules = [dict(r) for r in await con.fetch(
        "SELECT * FROM automations WHERE active AND entity = $1 ORDER BY created_at", entity)]
    fired = [r for r in rules if _fired(r, entity, before, after)]
    if not fired:
        return after
    table, rec = TABLE[entity], dict(after)
    for rule in fired:
        p: dict[str, Any] = json.loads(rule["params"] or "{}")
        patch: dict[str, Any] = {}
        note = None
        a = rule["action"]
        if a == "set_next_action":
            # Keep a next action the person set in this same save; skip closed / nurtured records.
            if not _open(entity, rec) or not p.get("code") or p["code"] not in domain.NEXT_ACTIONS:
                continue
            if before is not None and (before.get("next_action_code"), before.get("next_action_due")) != (rec.get("next_action_code"), rec.get("next_action_due")):
                continue
            due = add_business_days(date.today(), max(0, int(p.get("days") or 0)))
            other = (p.get("other") or "Follow up")[: domain.OTHER_MAX_LEN] if p["code"] == domain.OTHER_CODE else None
            patch = {"next_action_code": p["code"], "next_action_other": other, "next_action_due": due}
            note = f"next action set to “{domain.next_action_label(p['code'], other)}” due {due:%d %b %Y}"
        elif a == "assign_owner":
            uid = p.get("user_id")
            if not uid or str(rec.get("owner_id")) == uid or not await con.fetchval("SELECT 1 FROM users WHERE id = $1 AND active", UUID(uid)):
                continue
            patch = {"owner_id": UUID(uid)}
            note = "owner set to " + (await con.fetchval("SELECT name FROM users WHERE id = $1", UUID(uid)) or "someone")
        elif a == "add_to_list":
            lst = await con.fetchrow("SELECT id, name, entity FROM record_lists WHERE id = $1", UUID(p["list_id"])) if p.get("list_id") else None
            if not lst or lst["entity"] != table:
                continue
            await con.execute("INSERT INTO record_list_members(list_id, record_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", lst["id"], rec["id"])
            note = f"added to the list “{lst['name']}”"
        elif a == "log_note":
            text = (p.get("text") or "").strip()
            if not text:
                continue
            note = text[:300]
        if patch:
            new = dict(await con.fetchrow(
                f"UPDATE {table} SET {', '.join(f'{k} = ${i}' for i, k in enumerate(patch, start=2))}, updated_at = now() WHERE id = $1 RETURNING *",
                rec["id"], *patch.values()))
            await record_changes(con, entity, rec["id"], rec, new, user_id)
            rec = new
        await log_activity(con, entity, rec["id"], "automation", f"Automation “{rule['name']}”: {note}", user_id)
        await con.execute("UPDATE automations SET run_count = run_count + 1, last_run_at = now() WHERE id = $1", rule["id"])
        logger.info(f"Automation {rule['name']} ran on {entity} {rec['id']}")
    return rec
