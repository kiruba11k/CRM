"""Controlled lists, users and CSV export (§8)."""
import csv
import io
from typing import Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from .. import domain
from ..auth import User, current_user, get_con, require_admin
from ..records import get_or_404
from ..schemas import UserPatch

router = APIRouter(tags=["admin"])


@router.get("/lists")
async def lists(user: User = Depends(current_user)):
    return domain.lists_payload()


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return user.__dict__


@router.get("/users")
async def users(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return [dict(r) for r in await con.fetch("SELECT id, email, name, role, active FROM users ORDER BY name")]


@router.patch("/users/{user_id}")
async def update_user(user_id: UUID, body: UserPatch, con: asyncpg.Connection = Depends(get_con), admin: User = Depends(require_admin)):
    await get_or_404(con, "users", user_id, "User")
    patch = body.model_dump(exclude_unset=True)
    if str(user_id) == admin.id and (patch.get("role", "admin") != "admin" or patch.get("active") is False):
        raise HTTPException(409, "You can't remove your own admin access.")
    cols = list(patch)
    if not cols:
        return await get_or_404(con, "users", user_id, "User")
    sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(cols, start=2))
    row = await con.fetchrow(f"UPDATE users SET {sets} WHERE id = $1 RETURNING id, email, name, role, active", user_id, *patch.values())
    return dict(row)


_EXPORTS = {
    "accounts": "SELECT a.*, u.email AS owner_email FROM accounts a LEFT JOIN users u ON u.id = a.owner_id ORDER BY a.name",
    "prospects": "SELECT p.*, a.name AS account_name, u.email AS owner_email FROM prospects p "
                 "LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.full_name",
    "opportunities": "SELECT o.*, a.name AS account_name, u.email AS owner_email FROM opportunities o "
                     "JOIN accounts a ON a.id = o.account_id LEFT JOIN users u ON u.id = o.owner_id ORDER BY o.created_at",
    "history": "SELECT h.*, u.email AS changed_by_email FROM record_history h LEFT JOIN users u ON u.id = h.changed_by ORDER BY h.id",
}


@router.get("/export/{entity}.csv")
async def export_csv(
    entity: Literal["accounts", "prospects", "opportunities", "history"],
    con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
):
    if not user.can_edit_all:
        raise HTTPException(403, "CSV export is for managers and admins.")
    rows = await con.fetch(_EXPORTS[entity])
    buf = io.StringIO()
    writer = csv.writer(buf)
    if rows:
        writer.writerow(rows[0].keys())
        for r in rows:
            writer.writerow(["" if v is None else v for v in r.values()])
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="crm-{entity}.csv"'},
    )
