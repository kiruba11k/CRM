"""Activities & Meetings: every logged call, email, meeting, note and change
across the CRM, filterable by type, owner and date."""
from datetime import date
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends

from ..auth import User, current_user, get_con

router = APIRouter(prefix="/activities", tags=["activities"])

_SQL = """
SELECT a.id, a.entity_type, a.entity_id, a.kind, a.summary, a.occurred_at, a.email_direction, a.outcome,
       u.name AS created_by, a.created_by AS created_by_id,
       COALESCE(o.name, p.full_name, ac.name) AS record_name,
       COALESCE(oa.name, pa.name, ac.name) AS account_name
FROM activities a
LEFT JOIN users u ON u.id = a.created_by
LEFT JOIN opportunities o ON a.entity_type = 'opportunity' AND o.id = a.entity_id
LEFT JOIN accounts oa ON oa.id = o.account_id
LEFT JOIN prospects p ON a.entity_type = 'prospect' AND p.id = a.entity_id
LEFT JOIN accounts pa ON pa.id = p.account_id
LEFT JOIN accounts ac ON a.entity_type = 'account' AND ac.id = a.entity_id
WHERE ($1::text IS NULL OR a.kind = $1)
  AND ($2::uuid IS NULL OR a.created_by = $2)
  AND ($3::date IS NULL OR a.occurred_at::date >= $3)
  AND ($4::date IS NULL OR a.occurred_at::date <= $4)
  AND ($5::text IS NULL OR a.entity_type = $5)
ORDER BY a.occurred_at DESC
LIMIT $6
"""


@router.get("")
async def list_activities(kind: Optional[str] = None, owner: Optional[UUID] = None, since: Optional[date] = None, until: Optional[date] = None,
                          entity_type: Optional[Literal["account", "prospect", "opportunity"]] = None, limit: int = 200,
                          con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(_SQL, kind, owner, since, until, entity_type, max(1, min(limit, 500)))
    kinds = [r["kind"] for r in await con.fetch("SELECT kind, count(*) FROM activities GROUP BY kind ORDER BY count(*) DESC")]
    return {"kinds": kinds, "items": [dict(r) for r in rows]}
