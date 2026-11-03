"""
backend/app/insights.py - pipeline trend, stage speed and win/loss analysis.

Trend: one snapshot of the open, non-nurtured pipeline per day (taken by the
hourly job, or lazily when Reports loads). Weeks from before snapshots began
are rebuilt from the change history (stage, value, currency and nurture are
tracked fields), and marked as rebuilt.

Stage speed: how long deals stayed in each stage before moving on, from the
stage changes in the history. Win/loss: deals closed in the window.
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from statistics import median
from typing import Any, Optional

import asyncpg

from . import domain

EMPTY = "-"   # stage marker for a day with no open deals


async def take_snapshot(con: asyncpg.Connection, day: Optional[date] = None) -> bool:
    """Record today's pipeline once. Returns True if a snapshot was taken."""
    day = day or date.today()
    if await con.fetchval("SELECT 1 FROM pipeline_snapshots WHERE snap_date = $1 LIMIT 1", day):
        return False
    rows = await con.fetch("SELECT stage, currency, estimated_value FROM opportunities WHERE stage NOT IN ('Won', 'Lost') AND NOT on_nurture")
    agg: dict[tuple[str, str], list] = defaultdict(lambda: [0, Decimal(0), Decimal(0)])
    for r in rows:
        a = agg[(r["stage"], r["currency"])]
        v = r["estimated_value"] or Decimal(0)
        a[0] += 1
        a[1] += v
        a[2] += domain.weighted_value(v, r["stage"]) if r["stage"] in domain.STAGE_PROBABILITY else Decimal(0)
    if not agg:
        agg[(EMPTY, EMPTY)] = [0, Decimal(0), Decimal(0)]
    await con.executemany(
        "INSERT INTO pipeline_snapshots(snap_date, stage, currency, deals, unweighted, weighted) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
        [(day, s, c, n, u, w) for (s, c), (n, u, w) in agg.items()])
    return True


def _value_at(current: Any, changes: list[tuple[datetime, Optional[str], Optional[str]]], at: datetime) -> Any:
    """A tracked field's value at `at`: the last change before it, else the
    old value of the first change after it, else today's value."""
    before = [c for c in changes if c[0] <= at]
    if before:
        return before[-1][2]
    if changes:
        return changes[0][1]
    return current


async def _rebuild(con: asyncpg.Connection, days: list[date]) -> dict[date, dict]:
    """Pipeline on past days, from the change history."""
    if not days:
        return {}
    opps = await con.fetch("SELECT id, stage, currency, estimated_value, on_nurture, created_at FROM opportunities")
    hist: dict[Any, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for h in await con.fetch(
            "SELECT entity_id, field, old_value, new_value, changed_at FROM record_history WHERE entity_type = 'opportunity' "
            "AND field IN ('stage', 'currency', 'estimated_value', 'on_nurture') ORDER BY changed_at, id"):
        hist[h["entity_id"]][h["field"]].append((h["changed_at"], h["old_value"], h["new_value"]))
    out: dict[date, dict] = {}
    for d in days:
        at = datetime.combine(d, time(23, 59, 59), tzinfo=timezone.utc)
        by_cur: dict[str, dict] = defaultdict(lambda: {"deals": 0, "unweighted": Decimal(0), "weighted": Decimal(0)})
        total = 0
        for o in opps:
            if o["created_at"] > at:
                continue
            h = hist.get(o["id"], {})
            stage = _value_at(o["stage"], h.get("stage", []), at)
            nurture = _value_at(o["on_nurture"], h.get("on_nurture", []), at)
            if stage in domain.CLOSED_STAGES or nurture in (True, "True", "true") or stage not in domain.STAGE_PROBABILITY:
                continue
            cur = _value_at(o["currency"], h.get("currency", []), at) or o["currency"]
            raw = _value_at(o["estimated_value"], h.get("estimated_value", []), at)
            v = domain.to_decimal(raw) or Decimal(0)
            c = by_cur[cur]
            c["deals"] += 1
            c["unweighted"] += v
            c["weighted"] += domain.weighted_value(v, stage)
            total += 1
        out[d] = {"deals": total, "by_currency": dict(by_cur)}
    return out


async def trend(con: asyncpg.Connection, weeks: int = 12, today: Optional[date] = None) -> list[dict]:
    today = today or date.today()
    # Week-end points (Sundays) going back, plus today.
    last_sunday = today - timedelta(days=(today.weekday() + 1) % 7)
    days = sorted({last_sunday - timedelta(weeks=i) for i in range(weeks)} | {today})
    snaps: dict[date, dict] = {}
    for r in await con.fetch("SELECT * FROM pipeline_snapshots WHERE snap_date = ANY($1::date[])", days):
        s = snaps.setdefault(r["snap_date"], {"deals": 0, "by_currency": {}})
        if r["stage"] == EMPTY:
            continue
        c = s["by_currency"].setdefault(r["currency"], {"deals": 0, "unweighted": Decimal(0), "weighted": Decimal(0)})
        c["deals"] += r["deals"]; c["unweighted"] += r["unweighted"]; c["weighted"] += r["weighted"]
        s["deals"] += r["deals"]
    rebuilt = await _rebuild(con, [d for d in days if d not in snaps])
    return [{"date": d, "source": "snapshot" if d in snaps else "history", **(snaps.get(d) or rebuilt[d])} for d in days]


async def stage_speed(con: asyncpg.Connection, months: int = 12, today: Optional[date] = None) -> list[dict]:
    """Days spent in each stage, for stints that ended within the window."""
    today = today or date.today()
    since = datetime.combine(today - timedelta(days=30 * months), time(0), tzinfo=timezone.utc)
    opps = {r["id"]: r for r in await con.fetch("SELECT id, stage, created_at FROM opportunities")}
    changes: dict[Any, list] = defaultdict(list)
    for h in await con.fetch("SELECT entity_id, old_value, new_value, changed_at FROM record_history "
                             "WHERE entity_type = 'opportunity' AND field = 'stage' ORDER BY changed_at, id"):
        changes[h["entity_id"]].append(h)
    stints: dict[str, list[float]] = defaultdict(list)
    for oid, chs in changes.items():
        o = opps.get(oid)
        if o is None:
            continue
        entered = o["created_at"]
        for c in chs:
            if c["old_value"] is None:       # creation entry
                entered = c["changed_at"]
                continue
            if c["changed_at"] >= since and c["old_value"] in domain.STAGE_PROBABILITY:
                stints[c["old_value"]].append(max(0.0, (c["changed_at"] - entered).total_seconds() / 86400))
            entered = c["changed_at"]
    out = []
    for name, _ in domain.STAGES:
        if name in domain.CLOSED_STAGES:
            continue
        xs = stints.get(name, [])
        out.append({"stage": name, "moves": len(xs), "avg_days": round(sum(xs) / len(xs), 1) if xs else None,
                    "median_days": round(median(xs), 1) if xs else None})
    return out


async def win_loss(con: asyncpg.Connection, months: int = 12, today: Optional[date] = None) -> dict:
    today = today or date.today()
    since = today - timedelta(days=30 * months)
    rows = await con.fetch(
        "SELECT o.stage, o.currency, o.actual_value, o.lost_reason, o.service_line, o.deal_source, o.created_at, "
        "COALESCE(o.won_date, o.lost_date) AS closed, u.name AS owner FROM opportunities o LEFT JOIN users u ON u.id = o.owner_id "
        "WHERE (o.stage = 'Won' AND o.won_date >= $1) OR (o.stage = 'Lost' AND o.lost_date >= $1)", since)

    def summarise(rs: list) -> dict:
        won = [r for r in rs if r["stage"] == "Won"]
        # Imported deals can be "created" after they were won: leave those out.
        cycles = [c for c in ((r["closed"] - r["created_at"].date()).days for r in won if r["closed"]) if c >= 0]
        value: dict[str, Decimal] = defaultdict(Decimal)
        for r in won:
            value[r["currency"]] += r["actual_value"] or Decimal(0)
        return {"won": len(won), "lost": len(rs) - len(won), "win_rate": round(100 * len(won) / len(rs)) if rs else None,
                "avg_cycle_days": round(sum(cycles) / len(cycles)) if cycles else None, "won_value": dict(value)}

    def by(key: str) -> list[dict]:
        groups: dict[str, list] = defaultdict(list)
        for r in rows:
            groups[r[key] or "Not set"].append(r)
        return sorted(({"name": k, **summarise(v)} for k, v in groups.items()), key=lambda x: (-(x["won"] + x["lost"]), x["name"]))

    reasons: dict[str, int] = defaultdict(int)
    for r in rows:
        if r["stage"] == "Lost":
            reasons[r["lost_reason"] or "Not given"] += 1
    return {"since": since, "overall": summarise(list(rows)), "by_owner": by("owner"), "by_service": by("service_line"),
            "by_source": by("deal_source"), "loss_reasons": sorted(({"reason": k, "count": v} for k, v in reasons.items()), key=lambda x: -x["count"])}
