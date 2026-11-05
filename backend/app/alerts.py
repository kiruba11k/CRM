"""
backend/app/alerts.py - "going quiet" alerts for open deals.

Deal health for open, non-nurtured opportunities (CRM review §4.7). Each
flag adds points and carries its reason; the total gives High / Medium / Low:
  no_action / action_overdue   missing or late next action
  quiet     nothing has happened on it for `stale_days` (admin setting):
            no activity, field change, linked email or past meeting, and no
            auto-logged email with anyone at its company;
  overdue   its expected close date has passed;
  slipping  its close date has been pushed later two or more times;
  stalled   in the same stage for `stalled_days`; high_risk; large deal.
"""
from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

import asyncpg

from . import domain

SLIP_THRESHOLD = 2

_SQL = """
SELECT o.id, o.name, a.name AS account_name, o.owner_id, u.name AS owner_name, o.stage, o.currency,
       o.estimated_value, o.expected_close, o.created_at, o.next_action_code, o.next_action_due, o.risk_rating,
       GREATEST(
         o.created_at,
         (SELECT max(x.occurred_at) FROM activities x WHERE x.entity_type = 'opportunity' AND x.entity_id = o.id),
         (SELECT max(h.changed_at) FROM record_history h WHERE h.entity_type = 'opportunity' AND h.entity_id = o.id),
         (SELECT max(e.linked_at) FROM email_threads e WHERE e.entity_type = 'opportunity' AND e.entity_id = o.id),
         (SELECT max(x.occurred_at) FROM activities x WHERE x.entity_type = 'account' AND x.entity_id = o.account_id
                                                      AND x.kind = 'email' AND x.occurred_at <= now()),
         (SELECT max(m.starts_at) FROM meetings m WHERE m.entity_type = 'opportunity' AND m.entity_id = o.id
                                                    AND NOT m.cancelled AND m.starts_at <= now())
       ) AS last_touch,
       (SELECT max(h.changed_at) FROM record_history h
         WHERE h.entity_type = 'opportunity' AND h.entity_id = o.id AND h.field = 'stage') AS stage_changed_at,
       (SELECT count(*) FROM record_history h
         WHERE h.entity_type = 'opportunity' AND h.entity_id = o.id AND h.field = 'expected_close'
           AND h.old_value IS NOT NULL AND h.new_value IS NOT NULL AND h.new_value > h.old_value) AS close_pushes
FROM opportunities o
JOIN accounts a ON a.id = o.account_id
LEFT JOIN users u ON u.id = o.owner_id
WHERE o.stage NOT IN ('Won', 'Lost') AND NOT o.on_nurture AND ($1::uuid IS NULL OR o.owner_id = $1)
"""


def _days(since: Optional[datetime], now: datetime) -> Optional[int]:
    return None if since is None else max(0, (now - since).days)


LEVELS = ["Low", "Medium", "High"]


def level_of(score: int) -> Optional[str]:
    """Score → health level; below 2 is healthy (not listed)."""
    return None if score < 2 else "Low" if score <= 2 else "Medium" if score <= 4 else "High"


async def stale_deals(con: asyncpg.Connection, owner_id: Optional[UUID], today: Optional[date] = None,
                      now: Optional[datetime] = None) -> list[dict]:
    """At-risk open deals with a health level (High / Medium / Low) and a
    stated reason for every flag. Sorted by level, then deal value."""
    now = now or datetime.now(timezone.utc)
    today = today or now.date()
    limit = int(domain.REMINDERS.get("stale_days") or 14)
    stalled = int(domain.REMINDERS.get("stalled_days") or 45)
    esc = int(domain.REMINDERS.get("escalation_days") or 3)
    rows = await con.fetch(_SQL, owner_id)
    # "Large deal": top quarter of open deal values in its currency (needs 4+ deals to mean anything).
    by_cur: dict[str, list] = {}
    for r in await con.fetch("SELECT currency, estimated_value FROM opportunities WHERE stage NOT IN ('Won','Lost') AND NOT on_nurture AND estimated_value > 0"):
        by_cur.setdefault(r["currency"], []).append(r["estimated_value"])
    p75 = {c: sorted(v)[int(len(v) * 0.75)] for c, v in by_cur.items() if len(v) >= 4}
    out = []
    for r in rows:
        quiet = _days(r["last_touch"], now) or 0
        in_stage = _days(r["stage_changed_at"] or r["created_at"], now) or 0
        reasons, score = [], 0

        def flag(code: str, label: str, pts: int) -> None:
            nonlocal score
            reasons.append({"code": code, "label": label, "points": pts})
            score += pts

        if not r["next_action_code"]:
            flag("no_action", "No next action", 3)
        elif r["next_action_due"] and r["next_action_due"] < today:
            late = domain.business_days_between(r["next_action_due"], today)
            flag("action_overdue", f"Next action {late} business day{'s' if late != 1 else ''} overdue", 2 if late >= esc else 1)
        if quiet >= limit:
            flag("quiet", f"No activity for {quiet} days", 3 if quiet >= 2 * limit else 2)
        close = r["expected_close"]
        if close and close < today:
            n = (today - close).days
            flag("overdue", f"Expected close date passed {n} day{'s' if n != 1 else ''} ago", 2)
        if r["close_pushes"] >= SLIP_THRESHOLD:
            flag("slipping", f"Close date pushed back {r['close_pushes']} times", 2)
        if in_stage >= stalled:
            flag("stalled", f"In {r['stage']} for {in_stage} days", 1)
        if r["risk_rating"] == "High":
            flag("high_risk", "Rated High risk", 1)
        if score and r["estimated_value"] and r["currency"] in p75 and r["estimated_value"] >= p75[r["currency"]]:
            flag("large", "Large deal: more at stake", 1)
        level = level_of(score)
        if not level:
            continue
        out.append({
            "id": r["id"], "name": r["name"], "account_name": r["account_name"], "owner_id": r["owner_id"],
            "owner_name": r["owner_name"], "stage": r["stage"], "currency": r["currency"],
            "estimated_value": r["estimated_value"], "expected_close": close, "last_touch": r["last_touch"],
            "days_quiet": quiet, "days_in_stage": in_stage, "close_pushes": r["close_pushes"],
            "reasons": reasons, "score": score, "level": level,
        })
    out.sort(key=lambda d: (-LEVELS.index(d["level"]), -float(d["estimated_value"] or 0), -d["score"]))
    return out
