"""
backend/app/records.py - small SQL helpers shared by the routers.

Column names passed in always come from Pydantic model fields (never from
user input), so building the column lists here is injection-safe; values
always go through asyncpg parameters.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable, Optional
from uuid import UUID

import asyncpg
from fastapi import HTTPException

# Fields whose changes are written to record_history (§8.3).
TRACKED_FIELDS = {
    "account": ["name", "owner_id", "status", "country"],
    "prospect": ["status", "owner_id", "account_id", "next_action_code", "next_action_due"],
    "opportunity": [
        "stage", "owner_id", "estimated_value", "currency", "expected_close", "risk_rating",
        "on_nurture", "nurture_until", "next_action_code", "next_action_due", "actual_value", "lost_reason",
    ],
}


def plain(row: Optional[asyncpg.Record]) -> Optional[dict]:
    return dict(row) if row is not None else None


def _text(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return format(v.normalize(), "f")
    return str(v)


async def get_or_404(con: asyncpg.Connection, table: str, id_: UUID, label: str) -> dict:
    row = await con.fetchrow(f"SELECT * FROM {table} WHERE id = $1", id_)
    if row is None:
        raise HTTPException(404, f"{label} not found.")
    return dict(row)


async def insert(con: asyncpg.Connection, table: str, data: dict) -> dict:
    cols = list(data)
    placeholders = ", ".join(f"${i}" for i in range(1, len(cols) + 1))
    row = await con.fetchrow(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) RETURNING *", *data.values()
    )
    return dict(row)


async def update(con: asyncpg.Connection, table: str, id_: UUID, data: dict) -> dict:
    if not data:
        return await get_or_404(con, table, id_, table)
    cols = list(data)
    sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(cols, start=2))
    row = await con.fetchrow(
        f"UPDATE {table} SET {sets}, updated_at = now() WHERE id = $1 RETURNING *", id_, *data.values()
    )
    return dict(row)


async def record_changes(
    con: asyncpg.Connection, entity_type: str, entity_id: UUID, before: Optional[dict], after: dict, user_id: str
) -> int:
    rows = []
    for f in TRACKED_FIELDS[entity_type]:
        old = _text(before.get(f)) if before else None
        new = _text(after.get(f))
        if old != new and not (before is None and new is None):
            rows.append((entity_type, entity_id, f, old, new, UUID(user_id)))
    if rows:
        await con.executemany(
            "INSERT INTO record_history(entity_type, entity_id, field, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
            rows,
        )
    return len(rows)


async def log_activity(con: asyncpg.Connection, entity_type: str, entity_id: UUID, kind: str, summary: str, user_id: str) -> None:
    await con.execute(
        "INSERT INTO activities(entity_type, entity_id, kind, summary, created_by) VALUES ($1, $2, $3, $4, $5)",
        entity_type, entity_id, kind, summary, UUID(user_id),
    )


async def history(con: asyncpg.Connection, entity_type: str, entity_id: UUID) -> list[dict]:
    rows = await con.fetch(
        "SELECT h.field, h.old_value, h.new_value, h.changed_at, u.name AS changed_by "
        "FROM record_history h LEFT JOIN users u ON u.id = h.changed_by "
        "WHERE h.entity_type = $1 AND h.entity_id = $2 ORDER BY h.changed_at DESC, h.id DESC",
        entity_type, entity_id,
    )
    return [dict(r) for r in rows]


async def activities(con: asyncpg.Connection, pairs: Iterable[tuple[str, UUID]], limit: int = 100) -> list[dict]:
    pairs = list(pairs)
    if not pairs:
        return []
    types = [p[0] for p in pairs]
    ids = [p[1] for p in pairs]
    rows = await con.fetch(
        "SELECT a.id, a.entity_type, a.entity_id, a.kind, a.summary, a.occurred_at, u.name AS created_by "
        "FROM activities a LEFT JOIN users u ON u.id = a.created_by "
        "JOIN unnest($1::text[], $2::uuid[]) AS k(t, i) ON a.entity_type = k.t AND a.entity_id = k.i "
        "ORDER BY a.occurred_at DESC LIMIT $3",
        types, ids, limit,
    )
    return [dict(r) for r in rows]


def raise_if_errors(errors: list[dict]) -> None:
    if errors:
        raise HTTPException(422, {"message": "Fix the highlighted fields before saving.", "errors": errors})
