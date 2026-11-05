"""Home dashboard, stage conversion and the Activities list."""
from datetime import date

from tests.conftest import MANAGER, REP
from tests.test_api import make_account, make_opp


def test_home_and_conversion(client):
    acc = make_account(client)
    today = date.today()
    o1 = make_opp(client, acc["id"], name="A", stage="Qualified", estimated_value=10000, risk_rating="Low", next_action_due="2030-01-01",
                  expected_close=today.replace(day=28 if today.day <= 28 else today.day).isoformat())
    o2 = make_opp(client, acc["id"], name="B", stage="Negotiation", estimated_value=20000, risk_rating="Low", expected_close="2030-01-01", next_action_due="2030-01-01")
    client.patch(f"/api/opportunities/{o2['id']}", {"stage": "Won", "actual_value": 19000, "won_date": today.isoformat()})
    client.post("/api/prospects", {"full_name": "New Lead", "next_action_code": "01", "next_action_due": "2030-01-01"})
    h = client.get("/api/reports/home", as_=MANAGER).json()
    assert h["open_deals"] == 1 and float(h["pipeline"]["USD"]) == 10000 and float(h["weighted"]["USD"]) == 1500
    assert h["closing_this_month"]["count"] == 1 and h["new_leads"]["week"] >= 1
    assert h["win_rate"] == {"won": 1, "lost": 0, "rate": 100}
    rep = next(t for t in h["team"] if t["name"] == "rep")
    assert rep["open"] == 1 and float(rep["won_quarter"]["USD"]) == 19000
    st = {s["stage"]: s for s in h["stages"]}
    assert st["Qualified"]["open"] == 1 and st["Qualified"]["avg_days"] == 0 and st["Qualified"]["stalled"] == 0 and h["stalled_days"] == 45
    conv = {c["stage"]: c for c in h["conversion"]}
    assert conv["Qualified"]["reached"] == 2 and conv["Negotiation"]["reached"] == 1 and conv["Negotiation"]["went_on"] == 1


def test_activities_list(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"], next_action_due="2030-01-01")
    client.post(f"/api/opportunities/{o['id']}/activities", {"kind": "call", "summary": "Spoke to Elin"})
    r = client.get("/api/activities", params={"kind": "call"}).json()
    assert r["items"][0]["summary"] == "Spoke to Elin" and r["items"][0]["record_name"] == o["name"] and r["items"][0]["account_name"] == acc["name"]
    assert "call" in r["kinds"]
    assert client.get("/api/activities", params={"kind": "call", "owner": client.ids[MANAGER]}).json()["items"] == []
    assert REP
