"""Pipeline trend (snapshots + rebuilt history), stage speed, win/loss."""
import asyncio
from datetime import date, timedelta

import asyncpg

from app import insights
from tests.conftest import RAW_DB, REP
from tests.test_api import make_account, make_opp


def sql(q, *a):
    async def go():
        con = await asyncpg.connect(RAW_DB)
        try:
            return await con.execute(q, *a)
        finally:
            await con.close()
    return asyncio.run(go())


def test_pipeline_insights(client):
    acc = make_account(client)
    o1 = make_opp(client, acc["id"], name="Old deal", estimated_value=10000, next_action_due="2030-01-01")
    o2 = make_opp(client, acc["id"], name="Euro deal", estimated_value=5000, currency="EUR", next_action_due="2030-01-01")
    o3 = make_opp(client, acc["id"], name="Won deal", stage="Negotiation", estimated_value=20000, risk_rating="Low",
                  expected_close="2030-01-01", next_action_due="2030-01-01")
    o4 = make_opp(client, acc["id"], name="Lost deal", next_action_due="2030-01-01")
    # Pretend o1 and o3 were created 6 weeks ago; o3's stage history too.
    for o in (o1, o3):
        sql("UPDATE opportunities SET created_at = now() - interval '42 days' WHERE id = $1::uuid", o["id"])
        sql("UPDATE record_history SET changed_at = now() - interval '42 days' WHERE entity_id = $1::uuid", o["id"])
    assert client.patch(f"/api/opportunities/{o1['id']}", {"stage": "Qualified", "risk_rating": "Low"}).status_code == 200
    sql("UPDATE record_history SET changed_at = now() - interval '14 days' WHERE entity_id = $1::uuid AND field IN ('stage','risk_rating') AND old_value IS NOT NULL", o1["id"])
    assert client.patch(f"/api/opportunities/{o3['id']}", {"stage": "Won", "actual_value": 19000, "won_date": date.today().isoformat()}).status_code == 200
    assert client.patch(f"/api/opportunities/{o4['id']}", {"stage": "Lost", "lost_reason": "Budget", "lost_date": date.today().isoformat()}).status_code == 200

    r = client.get("/api/reports/insights", params={"weeks": 8}).json()
    t = r["trend"]
    assert t[-1]["source"] == "snapshot" and t[-1]["date"] == date.today().isoformat()
    now = t[-1]["by_currency"]
    assert now["USD"]["deals"] == 1 and float(now["USD"]["unweighted"]) == 10000 and now["EUR"]["deals"] == 1   # never summed
    # Four weeks ago only the two backdated deals existed, both still open, o1 still in its first stage.
    past = next(p for p in t if p["source"] == "history" and (date.today() - date.fromisoformat(p["date"])).days in range(21, 35))
    assert past["deals"] == 2 and float(past["by_currency"]["USD"]["unweighted"]) == 30000
    assert all(p["deals"] == 0 for p in t if (date.today() - date.fromisoformat(p["date"])).days > 42)

    speed = {s["stage"]: s for s in r["stage_speed"]}
    # o1 left Lead identified after 28 days, the lost deal after 0: average 14.
    assert speed["Lead identified"]["moves"] == 2 and 13 <= speed["Lead identified"]["avg_days"] <= 15
    assert speed["Negotiation"]["moves"] == 1 and 41 <= speed["Negotiation"]["avg_days"] <= 43
    wl = r["win_loss"]
    assert wl["overall"]["won"] == 1 and wl["overall"]["lost"] == 1 and wl["overall"]["win_rate"] == 50
    assert 41 <= wl["overall"]["avg_cycle_days"] <= 43 and float(wl["overall"]["won_value"]["USD"]) == 19000
    assert wl["loss_reasons"] == [{"reason": "Budget", "count": 1}] and wl["by_owner"][0]["name"] == "rep"

    # One snapshot per day, however often Reports loads.
    client.get("/api/reports/insights")
    assert sql("SELECT 1 FROM pipeline_snapshots").split()[-1] == str(2)   # USD + EUR rows for today


def test_empty_day_is_recorded():
    async def go():
        con = await asyncpg.connect(RAW_DB)
        try:
            await con.execute("DELETE FROM pipeline_snapshots")
            assert await insights.take_snapshot(con, date.today() - timedelta(days=400)) is True
            assert await insights.take_snapshot(con, date.today() - timedelta(days=400)) is False
            return await con.fetchval("SELECT count(*) FROM pipeline_snapshots")
        finally:
            await con.close()
    assert asyncio.run(go()) >= 1
