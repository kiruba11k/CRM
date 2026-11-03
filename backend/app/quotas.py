"""
backend/app/quotas.py - quarterly targets and attainment.

Per salesperson and currency (§2.3: currencies are never added together):
  target    the quarter's target
  won       contract value of deals won in the quarter (won_date)
  pipeline  open, non-nurtured deals expected to close in the quarter
            (for the current quarter, also those whose close date already
            passed: they can still close this quarter)
  weighted  the same deals at stage probability
"""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
from uuid import UUID

import asyncpg

from . import domain


def period_of(d: date) -> str:
    return f"{d.year}-Q{(d.month - 1) // 3 + 1}"


def bounds(period: str) -> tuple[date, date]:
    year, q = int(period[:4]), int(period[-1])
    start = date(year, 3 * (q - 1) + 1, 1)
    end = date(year + (q == 4), (3 * q) % 12 + 1, 1) - timedelta(days=1)
    return start, end


def shift(period: str, n: int) -> str:
    year, q = int(period[:4]), int(period[-1]) - 1 + n
    return f"{year + q // 4}-Q{q % 4 + 1}"


def _add(d: dict, cur: str, v) -> None:
    d[cur] = d.get(cur, Decimal(0)) + (v or Decimal(0))


async def attainment(con: asyncpg.Connection, period: str, today: Optional[date] = None,
                     user_id: Optional[UUID] = None) -> dict:
    today = today or date.today()
    start, end = bounds(period)
    current = start <= today <= end
    users = await con.fetch(
        "SELECT id, name, email, role, active FROM users WHERE ($1::uuid IS NULL OR id = $1) ORDER BY name", user_id)
    targets = await con.fetch("SELECT user_id, currency, amount FROM quotas WHERE period = $1", period)
    won = await con.fetch(
        "SELECT owner_id, currency, COALESCE(actual_value, estimated_value) AS v FROM opportunities "
        "WHERE stage = 'Won' AND won_date BETWEEN $1 AND $2", start, end)
    open_ = await con.fetch(
        "SELECT owner_id, currency, estimated_value AS v, stage FROM opportunities "
        "WHERE stage NOT IN ('Won', 'Lost') AND NOT on_nurture AND expected_close <= $2 "
        "AND ($3 OR expected_close >= $1)", start, end, current)

    rows: dict[UUID, dict] = {}
    for u in users:
        rows[u["id"]] = {"user_id": u["id"], "name": u["name"] or u["email"], "role": u["role"], "active": u["active"],
                         "target": {}, "won": {}, "won_count": 0, "pipeline": {}, "weighted": {}, "pipeline_count": 0}
    for t in targets:
        if t["user_id"] in rows:
            rows[t["user_id"]]["target"][t["currency"]] = t["amount"]
    for w in won:
        if w["owner_id"] in rows:
            _add(rows[w["owner_id"]]["won"], w["currency"], w["v"])
            rows[w["owner_id"]]["won_count"] += 1
    for o in open_:
        if o["owner_id"] in rows:
            r = rows[o["owner_id"]]
            _add(r["pipeline"], o["currency"], o["v"])
            _add(r["weighted"], o["currency"], domain.weighted_value(o["v"] or Decimal(0), o["stage"]))
            r["pipeline_count"] += 1

    team = {k: defaultdict(Decimal) for k in ("target", "won", "pipeline", "weighted")}
    out = []
    for r in rows.values():
        has_any = r["target"] or r["won"] or r["pipeline"]
        if not r["active"] and not has_any:
            continue
        if user_id is None and r["role"] != "salesperson" and not has_any:
            continue  # managers/admins without deals or targets add noise
        r["by_currency"] = _by_currency(r)
        for k in team:
            for cur, v in r[k].items():
                team[k][cur] += v
        out.append(r)
    team_row = {k: dict(v) for k, v in team.items()}
    team_row["by_currency"] = _by_currency(team_row)
    return {"period": period, "start": start, "end": end, "current": current,
            "days_total": (end - start).days + 1, "days_elapsed": max(0, min((today - start).days + 1, (end - start).days + 1)),
            "rows": out, "team": team_row}


def _by_currency(r: dict) -> list[dict]:
    """One line per currency with percentages (None when there's no target)."""
    curs = sorted(set(r["target"]) | set(r["won"]) | set(r["pipeline"]))
    lines = []
    for c in curs:
        t, w, wt = r["target"].get(c), r["won"].get(c, Decimal(0)), r["weighted"].get(c, Decimal(0))
        lines.append({
            "currency": c, "target": t, "won": w, "pipeline": r["pipeline"].get(c, Decimal(0)), "weighted": wt,
            "attainment": round(float(w / t * 100), 1) if t else None,
            "projected": round(float((w + wt) / t * 100), 1) if t else None,
            "gap": (t - w) if t and t > w else Decimal(0) if t else None,
        })
    return lines
