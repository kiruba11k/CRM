"""My Actions (§5.3, §7): every open next action, grouped by urgency."""
from datetime import date
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends

from .. import domain
from ..auth import User, current_user, get_con

router = APIRouter(prefix="/actions", tags=["actions"])

# Active prospects, open non-nurtured opportunities, and nurture revisits.
_SQL = """
SELECT 'prospect' AS kind, p.id, p.full_name AS title, a.name AS account_name, p.owner_id, u.name AS owner_name,
       p.next_action_code AS code, p.next_action_other AS other, p.next_action_due AS due, NULL::text AS nurture_reason,
       p.next_action_time AS due_time, p.next_action_in_calendar AS in_calendar
FROM prospects p LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN users u ON u.id = p.owner_id
WHERE p.status <> 'Disqualified' AND p.next_action_due IS NOT NULL AND ($1::uuid IS NULL OR p.owner_id = $1)
UNION ALL
SELECT 'opportunity', o.id, o.name, a.name, o.owner_id, u.name,
       o.next_action_code, o.next_action_other, o.next_action_due, NULL,
       o.next_action_time, o.next_action_in_calendar
FROM opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN users u ON u.id = o.owner_id
WHERE o.stage NOT IN ('Won', 'Lost') AND NOT o.on_nurture AND o.next_action_due IS NOT NULL AND ($1::uuid IS NULL OR o.owner_id = $1)
UNION ALL
SELECT 'nurture', o.id, o.name, a.name, COALESCE(o.nurture_owner_id, o.owner_id), u.name,
       o.nurture_next_action_code, o.nurture_next_action_other, o.nurture_until, o.nurture_reason,
       NULL::time, false
FROM opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN users u ON u.id = COALESCE(o.nurture_owner_id, o.owner_id)
WHERE o.on_nurture AND o.stage NOT IN ('Won', 'Lost') AND ($1::uuid IS NULL OR COALESCE(o.nurture_owner_id, o.owner_id) = $1)
ORDER BY due, due_time NULLS LAST
"""


@router.get("")
async def my_actions(
    scope: Literal["me", "team"] = "me",
    as_of: Optional[date] = None,
    con: asyncpg.Connection = Depends(get_con),
    user: User = Depends(current_user),
):
    today = as_of or date.today()
    owner = UUID(user.id) if scope == "me" else None
    sections = {"overdue": [], "today": [], "upcoming": [], "nurture": []}
    rem = domain.REMINDERS
    for r in await con.fetch(_SQL, owner):
        item = dict(r)
        item["label"] = domain.next_action_label(item["code"], item["other"])
        due = item["due"]
        if item["kind"] == "nurture":
            item["days_until"] = (due - today).days if due else None
            sections["nurture"].append(item)
        elif due < today:
            item["business_days_overdue"] = domain.business_days_between(due, today)
            item["escalated"] = bool(rem["escalation"]) and item["business_days_overdue"] >= rem["escalation_days"]
            sections["overdue"].append(item)
        elif due == today:
            sections["today"].append(item)
        else:
            item["days_until"] = (due - today).days
            # Optional §5 reminder one business day before the due date.
            item["due_next_business_day"] = bool(rem["due_before"]) and domain.business_days_between(today, due) == 1
            sections["upcoming"].append(item)
    counts = {k: len(v) for k, v in sections.items()}
    counts["next_7_days"] = sum(1 for i in sections["upcoming"] if i["days_until"] <= 7)
    counts["escalated"] = sum(1 for i in sections["overdue"] if i["escalated"])
    counts["due_next_business_day"] = sum(1 for i in sections["upcoming"] if i["due_next_business_day"])
    return {"as_of": today, "scope": scope, "counts": counts, **sections}
