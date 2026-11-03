"""Going-quiet deal alerts and quarterly targets (quotas)."""
from datetime import date
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .. import alerts, domain, quotas
from ..auth import User, current_user, get_con

router = APIRouter(tags=["insights"])


@router.get("/alerts/stale")
async def stale(scope: Literal["me", "team"] = "me", as_of: Optional[date] = None,
                con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    owner = UUID(user.id) if scope == "me" else None
    items = await alerts.stale_deals(con, owner, as_of)
    return {"scope": scope, "stale_days": domain.REMINDERS.get("stale_days"), "count": len(items), "items": items}


def _period(period: Optional[str]) -> str:
    if period is None:
        return quotas.period_of(date.today())
    import re
    if not re.fullmatch(r"\d{4}-Q[1-4]", period):
        raise HTTPException(422, "Use a quarter like 2026-Q4.")
    return period


@router.get("/quotas")
async def get_quotas(period: Optional[str] = None, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    p = _period(period)
    out = await quotas.attainment(con, p)
    out.update(previous=quotas.shift(p, -1), next=quotas.shift(p, 1), can_edit=user.can_edit_all,
               this_quarter=quotas.period_of(date.today()))
    return out


class QuotaIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period: str
    user_id: UUID
    currency: str
    amount: Optional[Decimal] = Field(default=None, ge=0, le=Decimal("999999999999"))


@router.put("/quotas")
async def set_quota(body: QuotaIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    if not user.can_edit_all:
        raise HTTPException(403, "Only managers and admins set targets.")
    p = _period(body.period)
    cur = body.currency.strip().upper()
    if cur not in domain.accepted("currencies"):
        raise HTTPException(422, f"{cur} isn’t one of the CRM’s currencies.")
    who = await con.fetchrow("SELECT name, email FROM users WHERE id = $1", body.user_id)
    if who is None:
        raise HTTPException(404, "No such user.")
    name = who["name"] or who["email"]
    async with con.transaction():
        if not body.amount:
            await con.execute("DELETE FROM quotas WHERE user_id = $1 AND period = $2 AND currency = $3", body.user_id, p, cur)
            summary = f"Removed {name}’s {p} target in {cur}."
        else:
            await con.execute(
                "INSERT INTO quotas(user_id, period, currency, amount, updated_by) VALUES ($1, $2, $3, $4, $5) "
                "ON CONFLICT (user_id, period, currency) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()",
                body.user_id, p, cur, body.amount, UUID(user.id))
            summary = f"Set {name}’s {p} target to {cur} {body.amount:,.0f}."
        await con.execute("INSERT INTO settings_changes(area, summary, changed_by) VALUES ('Targets', $1, $2)", summary, UUID(user.id))
    return await get_quotas(p, con, user)
