"""
backend/app/home.py - the Home dashboard (business overview) and stage-to-
stage conversion. My Actions stays the personal execution page; Home is the
overview the review asked for:

  open deals and pipeline value · weighted forecast · deals expected to close
  this month · new leads this week / month · win rate · stage-to-stage
  conversion · at-risk deals and deals with no next action · team by owner.

All money stays per currency (§2.3).
"""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

import asyncpg

from . import alerts, domain

OPEN_STAGE_NAMES = [s for s, _ in domain.STAGES if s not in domain.CLOSED_STAGES]


def _add(d: dict, cur: str, v) -> None:
    d[cur] = d.get(cur, Decimal(0)) + (v or Decimal(0))


async def conversion(con: asyncpg.Connection, months: int = 12, today: Optional[date] = None) -> list[dict]:
    """For each open stage: how many deals reached it, and how many of those
    went on to a later stage (or Won). Deals created in the window."""
    today = today or date.today()
    since = datetime.combine(today - timedelta(days=30 * months), datetime.min.time(), tzinfo=timezone.utc)
    order = {s: i for i, (s, _) in enumerate(domain.STAGES)}
    furthest: dict = {}
    for r in await con.fetch("SELECT id, stage FROM opportunities WHERE created_at >= $1", since):
        furthest[r["id"]] = order.get(r["stage"], 0) if r["stage"] != domain.LOST else -1
    for h in await con.fetch("SELECT entity_id, new_value FROM record_history WHERE entity_type = 'opportunity' AND field = 'stage' "
                             "AND entity_id = ANY($1::uuid[])", list(furthest)):
        if h["new_value"] in order and h["new_value"] != domain.LOST:
            furthest[h["entity_id"]] = max(furthest[h["entity_id"]], order[h["new_value"]])
    out = []
    names = [s for s, _ in domain.STAGES if s != domain.LOST]
    for i, s in enumerate(names[:-1]):
        reached = sum(1 for f in furthest.values() if f >= order[s])
        went_on = sum(1 for f in furthest.values() if f >= order[names[i + 1]])
        out.append({"stage": s, "next": names[i + 1], "reached": reached, "went_on": went_on,
                    "rate": round(100 * went_on / reached) if reached else None})
    return out


async def overview(con: asyncpg.Connection, today: Optional[date] = None) -> dict:
    today = today or date.today()
    month_start, week_start = today.replace(day=1), today - timedelta(days=today.weekday())
    next_month = (month_start + timedelta(days=32)).replace(day=1)
    opps = await con.fetch(
        "SELECT o.id, o.stage, o.currency, o.estimated_value, o.expected_close, o.on_nurture, o.next_action_code, o.owner_id, "
        "o.won_date, o.lost_date, o.actual_value, u.name AS owner_name FROM opportunities o LEFT JOIN users u ON u.id = o.owner_id")
    open_ = [o for o in opps if o["stage"] not in domain.CLOSED_STAGES and not o["on_nurture"]]
    pipeline, weighted, closing = {}, {}, {}
    closing_n = 0
    for o in open_:
        _add(pipeline, o["currency"], o["estimated_value"])
        _add(weighted, o["currency"], domain.weighted_value(o["estimated_value"] or 0, o["stage"]))
        if o["expected_close"] and month_start <= o["expected_close"] < next_month:
            _add(closing, o["currency"], o["estimated_value"]); closing_n += 1
    since90 = today - timedelta(days=90)
    won90 = [o for o in opps if o["stage"] == domain.WON and o["won_date"] and o["won_date"] >= since90]
    lost90 = [o for o in opps if o["stage"] == domain.LOST and o["lost_date"] and o["lost_date"] >= since90]
    leads_week = await con.fetchval("SELECT count(*) FROM prospects WHERE created_at::date >= $1", week_start)
    leads_month = await con.fetchval("SELECT count(*) FROM prospects WHERE created_at::date >= $1", month_start)
    at_risk = await alerts.stale_deals(con, None, today)
    no_action = [o for o in open_ if not o["next_action_code"]]

    # Team by owner
    team: dict = defaultdict(lambda: {"open": 0, "pipeline": {}, "overdue": 0, "no_action": 0, "at_risk": 0, "activities_7d": 0, "won_quarter": {}})
    q_start = date(today.year, 3 * ((today.month - 1) // 3) + 1, 1)
    for o in open_:
        t = team[o["owner_name"] or "Unassigned"]
        t["open"] += 1; _add(t["pipeline"], o["currency"], o["estimated_value"])
        if not o["next_action_code"]:
            t["no_action"] += 1
    for o in opps:
        if o["stage"] == domain.WON and o["won_date"] and o["won_date"] >= q_start:
            _add(team[o["owner_name"] or "Unassigned"]["won_quarter"], o["currency"], o["actual_value"])
    for d in at_risk:
        team[d["owner_name"] or "Unassigned"]["at_risk"] += 1
    for r in await con.fetch(
            "SELECT u.name, count(*) AS n FROM ( "
            "  SELECT owner_id FROM prospects WHERE status <> 'Disqualified' AND next_action_due < $1 "
            "  UNION ALL SELECT owner_id FROM opportunities WHERE stage NOT IN ('Won','Lost') AND NOT on_nurture AND next_action_due < $1 "
            ") x LEFT JOIN users u ON u.id = x.owner_id GROUP BY u.name", today):
        team[r["name"] or "Unassigned"]["overdue"] += r["n"]
    for r in await con.fetch("SELECT u.name, count(*) AS n FROM activities a JOIN users u ON u.id = a.created_by "
                             "WHERE a.occurred_at >= now() - interval '7 days' GROUP BY u.name"):
        team[r["name"]]["activities_7d"] += r["n"]
    for u in await con.fetch("SELECT u.name FROM users u JOIN roles r ON r.key = u.role WHERE u.active AND NOT ('team_view' = ANY(r.permissions))"):
        team[u["name"]]  # salespeople show even with nothing yet

    # Where open deals sit: per stage, how many, average days in the stage, how many past the stalled limit.
    stalled_days = int(domain.REMINDERS.get("stalled_days") or 45)
    stuck = {s: {"stage": s, "open": 0, "days": 0, "stalled": 0} for s in OPEN_STAGE_NAMES}
    for r in await con.fetch(
            "SELECT o.stage, (now()::date - coalesce((SELECT max(h.changed_at) FROM record_history h WHERE h.entity_type = 'opportunity' "
            "AND h.entity_id = o.id AND h.field = 'stage'), o.created_at)::date) AS days "
            "FROM opportunities o WHERE o.stage NOT IN ('Won','Lost') AND NOT o.on_nurture"):
        if r["stage"] in stuck:
            row = stuck[r["stage"]]
            row["open"] += 1; row["days"] += r["days"]; row["stalled"] += r["days"] >= stalled_days
    stages = [{**v, "avg_days": round(v["days"] / v["open"]) if v["open"] else None} for v in stuck.values()]

    return {
        "as_of": today,
        "stages": stages, "stalled_days": stalled_days,
        "open_deals": len(open_), "pipeline": pipeline, "weighted": weighted,
        "closing_this_month": {"count": closing_n, "value": closing},
        "new_leads": {"week": leads_week, "month": leads_month},
        "win_rate": {"won": len(won90), "lost": len(lost90), "rate": round(100 * len(won90) / (len(won90) + len(lost90))) if (won90 or lost90) else None},
        "at_risk": len(at_risk), "no_next_action": len(no_action),
        "team": sorted(({"name": k, **v} for k, v in team.items()), key=lambda x: (-x["open"], x["name"])),
        "conversion": await conversion(con, 12, today),
    }


async def outcomes(con: asyncpg.Connection, days: int = 90) -> dict:
    """What completed actions led to, overall and by who logged them."""
    rows = await con.fetch(
        "SELECT a.outcome, coalesce(u.name, 'Unknown') AS owner, count(*) AS n FROM activities a LEFT JOIN users u ON u.id = a.created_by "
        "WHERE a.kind = 'action_completed' AND a.outcome IS NOT NULL AND a.occurred_at >= now() - make_interval(days => $1) "
        "GROUP BY 1, 2", days)
    total: dict[str, int] = {k: 0 for k in domain.OUTCOMES}
    by_owner: dict = defaultdict(lambda: {k: 0 for k in domain.OUTCOMES})
    for r in rows:
        total[r["outcome"]] = total.get(r["outcome"], 0) + r["n"]
        by_owner[r["owner"]][r["outcome"]] += r["n"]
    # Follow-up effectiveness: per action type, how often it led somewhere.
    positive = ("connected", "meeting_booked", "proposal_requested")
    by_action = []
    for r in await con.fetch(
            "SELECT a.action_code, a.outcome, count(*) AS n FROM activities a WHERE a.kind = 'action_completed' AND a.outcome IS NOT NULL "
            "AND a.action_code IS NOT NULL AND a.occurred_at >= now() - make_interval(days => $1) GROUP BY 1, 2", days):
        row = next((x for x in by_action if x["code"] == r["action_code"]), None)
        if row is None:
            row = {"code": r["action_code"], "label": domain.NEXT_ACTIONS.get(r["action_code"], r["action_code"]), "counts": {k: 0 for k in domain.OUTCOMES}, "total": 0}
            by_action.append(row)
        row["counts"][r["outcome"]] += r["n"]
        row["total"] += r["n"]
    for row in by_action:
        row["positive_rate"] = round(100 * sum(row["counts"][k] for k in positive) / row["total"])
    by_action.sort(key=lambda x: (-x["total"], x["code"]))
    return {
        "days": days, "by_action": by_action,
        "outcomes": [{"code": k, "label": v, "count": total[k]} for k, v in domain.OUTCOMES.items()],
        "total": sum(total.values()),
        "by_owner": sorted(({"name": k, "counts": v, "total": sum(v.values())} for k, v in by_owner.items()), key=lambda x: -x["total"]),
    }
