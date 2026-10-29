"""Accounts: one record per company (§1, §2.1)."""
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from .. import domain
from ..auth import User, current_user, ensure_can_assign, ensure_can_edit, get_con
from ..records import activities, get_or_404, history, insert, raise_if_errors, record_changes, update
from ..schemas import AccountIn, AccountPatch

router = APIRouter(prefix="/accounts", tags=["accounts"])

_LIST_SQL = """
SELECT a.*, u.name AS owner_name,
       (SELECT count(*) FROM prospects p WHERE p.account_id = a.id) AS prospect_count,
       (SELECT count(*) FROM opportunities o WHERE o.account_id = a.id AND o.stage NOT IN ('Won','Lost') AND NOT o.on_nurture) AS open_count,
       (SELECT count(*) FROM opportunities o WHERE o.account_id = a.id AND o.stage = 'Won') AS won_count
FROM accounts a LEFT JOIN users u ON u.id = a.owner_id
WHERE ($1::text IS NULL OR a.status = $1)
  AND ($2::text IS NULL OR a.country = $2)
  AND ($3::uuid IS NULL OR a.owner_id = $3)
  AND ($4::text IS NULL OR a.name ILIKE '%' || $4 || '%' OR a.industry ILIKE '%' || $4 || '%')
ORDER BY a.name
"""


@router.get("")
async def list_accounts(
    status: Optional[str] = None, country: Optional[str] = None, owner_id: Optional[UUID] = None, q: Optional[str] = None,
    con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
):
    return [dict(r) for r in await con.fetch(_LIST_SQL, status, country, owner_id, q)]


@router.get("/duplicates")
async def possible_duplicates(name: str, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """§8.2 avoid duplicate records: called as the user types a new account name."""
    key = domain.account_name_key(name)
    if len(key) < 3:
        return []
    rows = await con.fetch(
        "SELECT id, name, country FROM accounts "
        "WHERE name_key = $1 OR name_key LIKE $1 || '%' OR $1 LIKE name_key || '%' ORDER BY name LIMIT 5",
        key,
    )
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def create_account(body: AccountIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    data = body.model_dump()
    data["owner_id"] = data["owner_id"] or UUID(user.id)
    ensure_can_assign(user, data["owner_id"])
    errors, warnings = domain.validate_account(data)
    raise_if_errors(errors)
    data["name_key"] = domain.account_name_key(data["name"])
    existing = await con.fetchrow("SELECT id, name FROM accounts WHERE name_key = $1", data["name_key"])
    if existing:
        raise HTTPException(409, {"message": f"An account named “{existing['name']}” already exists.", "existing_id": str(existing["id"])})
    async with con.transaction():
        row = await insert(con, "accounts", data)
        await record_changes(con, "account", row["id"], None, row, user.id)
    return {**row, "warnings": warnings}


@router.get("/{account_id}")
async def get_account(account_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    acc = await get_or_404(con, "accounts", account_id, "Account")
    prospects = [dict(r) for r in await con.fetch(
        "SELECT p.*, u.name AS owner_name FROM prospects p LEFT JOIN users u ON u.id = p.owner_id WHERE p.account_id = $1 ORDER BY p.full_name",
        account_id,
    )]
    opps = [dict(r) for r in await con.fetch(
        "SELECT o.*, u.name AS owner_name FROM opportunities o LEFT JOIN users u ON u.id = o.owner_id "
        "WHERE o.account_id = $1 ORDER BY (o.stage IN ('Won','Lost')), o.expected_close NULLS LAST, o.created_at DESC",
        account_id,
    )]
    pairs = [("account", account_id)] + [("prospect", p["id"]) for p in prospects] + [("opportunity", o["id"]) for o in opps]
    return {
        **acc,
        "prospects": prospects,
        "opportunities": opps,
        "activities": await activities(con, pairs),
        "history": await history(con, "account", account_id),
    }


@router.patch("/{account_id}")
async def update_account(
    account_id: UUID, body: AccountPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    before = await get_or_404(con, "accounts", account_id, "Account")
    ensure_can_edit(user, before["owner_id"])
    patch = body.model_dump(exclude_unset=True)
    if "owner_id" in patch:
        ensure_can_assign(user, patch["owner_id"])
    merged = {**before, **patch}
    errors, warnings = domain.validate_account(merged)
    raise_if_errors(errors)
    if "name" in patch:
        patch["name_key"] = domain.account_name_key(patch["name"])
        clash = await con.fetchrow("SELECT id, name FROM accounts WHERE name_key = $1 AND id <> $2", patch["name_key"], account_id)
        if clash:
            raise HTTPException(409, {"message": f"An account named “{clash['name']}” already exists.", "existing_id": str(clash["id"])})
    async with con.transaction():
        row = await update(con, "accounts", account_id, patch)
        await record_changes(con, "account", account_id, before, row, user.id)
    return {**row, "warnings": warnings}
