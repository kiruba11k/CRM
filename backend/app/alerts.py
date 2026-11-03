"""
backend/app/alerts.py - "going quiet" alerts for open deals.

An open, non-nurtured opportunity is flagged when:
  quiet     nothing has happened on it for `stale_days` (admin setting):
            no activity, field change, linked email or past meeting;
  overdue   its expected close date has passed;
  slipping  its close date has been pushed later two or more times.
"""
from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

import asyncpg

from . import domain

SLIP_THRESHOLD = 2

_SQL = """
SELECT o.id, o.name, a.name AS account_name, o.owner_id, u.name AS owner_name, o.stage, o.currency,
       o.estimated_value, o.expected_close, o.created_at,
       GREATEST(
         o.created_at,
         (SELECT max(x.occurred_at) FROM activities x WHERE x.entity_type = 'opportunity' AND x.entity_id = o.id),
         (SELECT max(h.changed_at) FROM record_history h WHERE h.entity_type = 'opportunity' AND h.entity_id = o.id),
         (SELECT max(e.linked_at) FROM email_threads e WHERE e.entity_type = 'opportunity' AND e.entity_id = o.id),
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


async def stale_deals(con: asyncpg.Connection, owner_id: Optional[UUID], today: Optional[date] = None,
                      now: Optional[datetime] = None) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    today = today or now.date()
    limit = int(domain.REMINDERS.get("stale_days") or 14)
    out = []
    for r in await con.fetch(_SQL, owner_id):
        quiet = _days(r["last_touch"], now) or 0
        reasons = []
        if quiet >= limit:
            reasons.append({"code": "quiet", "label": f"No activity for {quiet} days"})
        close = r["expected_close"]
        if close and close < today:
            n = (today - close).days
            reasons.append({"code": "overdue", "label": f"Expected close date passed {n} day{'s' if n != 1 else ''} ago"})
        if r["close_pushes"] >= SLIP_THRESHOLD:
            reasons.append({"code": "slipping", "label": f"Close date pushed back {r['close_pushes']} times"})
        if not reasons:
            continue
        out.append({
            "id": r["id"], "name": r["name"], "account_name": r["account_name"], "owner_id": r["owner_id"],
            "owner_name": r["owner_name"], "stage": r["stage"], "currency": r["currency"],
            "estimated_value": r["estimated_value"], "expected_close": close, "last_touch": r["last_touch"],
            "days_quiet": quiet, "days_in_stage": _days(r["stage_changed_at"] or r["created_at"], now),
            "close_pushes": r["close_pushes"], "reasons": reasons,
        })
    out.sort(key=lambda d: (-len(d["reasons"]), -d["days_quiet"]))
    return out
