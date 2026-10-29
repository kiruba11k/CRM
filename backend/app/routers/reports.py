"""Pipeline, forecast and nurture totals (§3.2, §7).

Totals are always grouped by currency: unlike currencies are never summed
until an FX rule is agreed (§2.3).
"""
from collections import defaultdict
from decimal import Decimal

import asyncpg
from fastapi import APIRouter, Depends

from .. import domain
from ..auth import User, current_user, get_con

router = APIRouter(prefix="/reports", tags=["reports"])


def _by_currency(rows, weighted: bool) -> dict[str, Decimal]:
    out: dict[str, Decimal] = defaultdict(Decimal)
    for r in rows:
        v = r["estimated_value"] or Decimal(0)
        out[r["currency"]] += domain.weighted_value(v, r["stage"]) if weighted else v
    return dict(out)


@router.get("/pipeline")
async def pipeline(include_nurtured: bool = False, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch("SELECT stage, currency, estimated_value, on_nurture FROM opportunities")
    stages = []
    for name, prob in domain.STAGES:
        in_stage = [r for r in rows if r["stage"] == name and (include_nurtured or not r["on_nurture"])]
        stages.append({
            "stage": name, "probability": prob, "count": len(in_stage),
            "unweighted": _by_currency(in_stage, False), "weighted": _by_currency(in_stage, True),
        })
    active = [r for r in rows if r["stage"] not in domain.CLOSED_STAGES and not r["on_nurture"]]
    nurtured = [r for r in rows if r["on_nurture"]]
    return {
        "stages": stages,
        "active_forecast": {"count": len(active), "unweighted": _by_currency(active, False), "weighted": _by_currency(active, True)},
        "nurture": {"count": len(nurtured), "value": _by_currency(nurtured, False)},
    }


@router.get("/forecast")
async def forecast(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Active forecast by expected close month (open, non-nurtured)."""
    rows = await con.fetch(
        "SELECT stage, currency, estimated_value, to_char(expected_close, 'YYYY-MM') AS period "
        "FROM opportunities WHERE stage NOT IN ('Won','Lost') AND NOT on_nurture"
    )
    periods: dict[str, list] = defaultdict(list)
    for r in rows:
        periods[r["period"] or "no close date"].append(r)
    return [
        {"period": p, "count": len(rs), "unweighted": _by_currency(rs, False), "weighted": _by_currency(rs, True)}
        for p, rs in sorted(periods.items())
    ]
