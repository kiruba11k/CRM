"""Action outcomes, extra deal contacts and deal health levels (CRM review)."""
from app import alerts

from tests.conftest import MANAGER, REP
from tests.test_api import make_account, make_opp

NEXT = {"next_action_code": "08", "next_action_due": "2030-01-10"}


def test_outcomes_on_deals(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"])
    r = client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "meeting_booked", **NEXT})
    assert r.status_code == 200, r.text
    act = client.get(f"/api/opportunities/{o['id']}").json()["activities"]
    done = next(a for a in act if a["kind"] == "action_completed")
    assert done["outcome"] == "meeting_booked" and "Meeting booked" in done["summary"]

    # Unknown outcome; outcome other than "not interested" still needs a next action.
    assert client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "maybe", **NEXT}).status_code == 422
    assert client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "connected"}).status_code == 422

    # Moved to nurture needs a reason and date, then the deal is on nurture with no open next action.
    assert client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "moved_to_nurture"}).status_code == 422
    r = client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "moved_to_nurture", "nurture_reason": "Timing delayed",
                    "nurture_until": "2030-03-01", "nurture_next_action_code": "17"})
    assert r.status_code == 200, r.text
    assert r.json()["on_nurture"] and r.json()["next_action_code"] is None

    # Not interested closes the deal as Lost (needs a lost reason).
    o2 = make_opp(client, acc["id"], name="Second")
    assert client.post(f"/api/opportunities/{o2['id']}/complete-action", {"outcome": "not_interested"}).status_code == 422
    r = client.post(f"/api/opportunities/{o2['id']}/complete-action", {"outcome": "not_interested", "lost_reason": "Not a fit"})
    assert r.status_code == 200, r.text
    assert r.json()["stage"] == "Lost" and r.json()["lost_reason"] == "Not a fit"

    rep = client.get("/api/reports/outcomes", as_=MANAGER).json()
    counts = {x["code"]: x["count"] for x in rep["outcomes"]}
    assert counts["meeting_booked"] == 1 and counts["moved_to_nurture"] == 1 and counts["not_interested"] == 1 and rep["total"] == 3
    assert rep["by_owner"][0]["name"] == "rep" and rep["by_owner"][0]["total"] == 3


def test_outcomes_on_prospects(client):
    p = client.post("/api/prospects", {"full_name": "Elin Berg", "email": "elin@x.se", "next_action_code": "01", "next_action_due": "2030-01-01"}).json()
    r = client.post(f"/api/prospects/{p['id']}/complete-action", {"outcome": "connected", **NEXT})
    assert r.status_code == 200 and r.json()["status"] == "Engaged"
    # "No response" never moves the status backwards.
    r = client.post(f"/api/prospects/{p['id']}/complete-action", {"outcome": "no_response", **NEXT})
    assert r.json()["status"] == "Engaged"
    r = client.post(f"/api/prospects/{p['id']}/complete-action", {"outcome": "moved_to_nurture", **NEXT})
    assert r.json()["status"] == "Nurture"
    r = client.post(f"/api/prospects/{p['id']}/complete-action", {"outcome": "not_interested", "note": "Has a supplier"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Disqualified" and r.json()["next_action_code"] is None and r.json()["disqualified_reason"] == "Has a supplier"


def test_deal_contacts(client):
    acc = make_account(client)
    primary = client.post("/api/prospects", {"full_name": "Primary P", "email": "p@x.se", "account_id": acc["id"], "next_action_code": "01", "next_action_due": "2030-01-01"}).json()
    other = client.post("/api/prospects", {"full_name": "Second S", "email": "s@x.se", "account_id": acc["id"], "next_action_code": "01", "next_action_due": "2030-01-01"}).json()
    o = make_opp(client, acc["id"], primary_contact_id=primary["id"])
    assert client.post(f"/api/opportunities/{o['id']}/contacts", {"prospect_id": primary["id"]}).status_code == 409
    r = client.post(f"/api/opportunities/{o['id']}/contacts", {"prospect_id": other["id"], "role": "Champion"})
    assert r.status_code == 201, r.text
    assert [(c["full_name"], c["role"], c["is_primary"]) for c in r.json()] == [("Primary P", "Primary contact", True), ("Second S", "Champion", False)]
    assert len(client.get(f"/api/opportunities/{o['id']}").json()["contacts"]) == 2
    deals = client.get(f"/api/prospects/{other['id']}").json()["opportunities"]
    assert deals[0]["id"] == o["id"] and deals[0]["role"] == "Champion"
    assert client.get(f"/api/prospects/{other['id']}").json()["lifecycle"] == "Opportunity"
    # Contact merge keeps the link.
    assert client.delete(f"/api/opportunities/{o['id']}/contacts/{other['id']}").json()[-1]["full_name"] == "Primary P"
    assert client.delete(f"/api/opportunities/{o['id']}/contacts/{other['id']}").status_code == 404


def test_health_levels(client):
    assert [alerts.level_of(n) for n in (0, 1, 2, 3, 4, 5, 9)] == [None, None, "Low", "Medium", "Medium", "High", "High"]
    acc = make_account(client)
    bad = make_opp(client, acc["id"], name="Bad", expected_close="2026-01-01", risk_rating="High",
                   high_risk_reason="Budget", risk_mitigation="Call CFO")
    ok = make_opp(client, acc["id"], name="Ok", next_action_due="2030-01-01")
    items = {i["name"]: i for i in client.get("/api/alerts/stale", params={"scope": "team"}, as_=MANAGER).json()["items"]}
    assert "Ok" not in items and ok
    b = items["Bad"]
    assert {r["code"] for r in b["reasons"]} >= {"overdue", "high_risk"} and b["score"] == sum(r["points"] for r in b["reasons"])
    assert b["level"] == alerts.level_of(b["score"]) and REP
