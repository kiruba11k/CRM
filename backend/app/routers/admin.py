"""Controlled lists, the signed-in user and CSV export (§8). People and roles: routers/people.py."""
import csv
import io
from typing import Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from .. import domain
from ..auth import User, current_user, get_con

router = APIRouter(tags=["admin"])


@router.get("/lists")
async def lists(user: User = Depends(current_user)):
    return domain.lists_payload()


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return user.__dict__


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
    if not user.can("export_data"):
        raise HTTPException(403, "You need the “Export CSV” permission. Ask an admin.")
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
