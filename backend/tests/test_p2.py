"""CRM review P2: custom properties, workflow automation, outcomes by action type."""
from datetime import date

from app.automations import add_business_days
from tests.conftest import ADMIN, MANAGER, REP
from tests.test_api import make_account, make_opp


def test_custom_fields(client):
    assert client.post("/api/custom-fields", {"entity": "accounts", "label": "Tier", "type": "select", "options": ["A", "B"]}).status_code == 403
    tier = client.post("/api/custom-fields", {"entity": "accounts", "label": "Tier", "type": "select", "options": ["A", "B", "A"]}, as_=ADMIN).json()
    assert tier["key"] == "tier" and tier["options"] == ["A", "B"]
    assert client.post("/api/custom-fields", {"entity": "accounts", "label": "Pick", "type": "select"}, as_=ADMIN).status_code == 422
    assert client.post("/api/custom-fields", {"entity": "accounts", "label": "tier", "type": "text"}, as_=ADMIN).status_code == 409
    beds = client.post("/api/custom-fields", {"entity": "accounts", "label": "Bed count", "type": "number"}, as_=ADMIN).json()
    client.post("/api/custom-fields", {"entity": "accounts", "label": "Signed NDA", "type": "checkbox"}, as_=ADMIN)
    client.post("/api/custom-fields", {"entity": "accounts", "label": "Renewal", "type": "date"}, as_=ADMIN)
    assert [f["key"] for f in client.get("/api/custom-fields", params={"entity": "accounts"}).json()] == ["tier", "bed_count", "signed_nda", "renewal"]
    acc = make_account(client)
    url = f"/api/custom-fields/values/accounts/{acc['id']}"
    r = client.put(url, {"tier": "C", "bed_count": "lots"})
    assert r.status_code == 422 and {e["field"] for e in r.json()["detail"]["errors"]} == {"custom.tier", "custom.bed_count"}
    assert client.put(url, {"tier": "B", "bed_count": "1,200", "signed_nda": True, "renewal": "2027-03-01"}).json() == \
        {"tier": "B", "bed_count": 1200, "signed_nda": True, "renewal": "2027-03-01"}
    assert client.put(url, {"signed_nda": False, "tier": ""}).json() == {"bed_count": 1200, "renewal": "2027-03-01"}
    assert client.put(url, {"tier": "A"}, as_="rep2@leadstrategus.com").status_code == 403
    assert client.get("/api/custom-fields/values/accounts").json()[acc["id"]]["bed_count"] == 1200
    # Switched off: hidden, values kept.
    client.patch(f"/api/custom-fields/{beds['id']}", {"active": False}, as_=ADMIN)
    assert "bed_count" not in client.get(url).json()
    client.patch(f"/api/custom-fields/{beds['id']}", {"active": True}, as_=ADMIN)
    assert client.get(url).json()["bed_count"] == 1200 and tier


def test_automation_next_action_on_stage(client):
    rule = {"name": "Proposal follow-up", "entity": "opportunity", "trigger": "stage_changed", "trigger_value": "Proposal submitted",
            "action": "set_next_action", "params": {"code": "08", "days": 5}}
    assert client.post("/api/automations", rule).status_code == 403
    assert client.post("/api/automations", {**rule, "trigger": "status_changed"}, as_=ADMIN).status_code == 422
    assert client.post("/api/automations", rule, as_=ADMIN).status_code == 201
    acc = make_account(client)
    o = make_opp(client, acc["id"], estimated_value=1000, risk_rating="Low", expected_close="2030-01-01")
    r = client.patch(f"/api/opportunities/{o['id']}", {"stage": "Proposal submitted", "proposal_due": "2030-01-01"})
    assert r.status_code == 200, r.text
    d = client.get(f"/api/opportunities/{o['id']}").json()
    assert d["next_action_code"] == "08" and d["next_action_due"] == add_business_days(date.today(), 5).isoformat()
    assert any(a["kind"] == "automation" and "Proposal follow-up" in a["summary"] for a in d["activities"])
    assert client.get("/api/automations").json()[0]["run_count"] == 1
    # A next action set in the same save wins over the rule.
    o2 = make_opp(client, acc["id"], name="Two", estimated_value=1000, risk_rating="Low", expected_close="2030-01-01")
    client.patch(f"/api/opportunities/{o2['id']}", {"stage": "Proposal submitted", "proposal_due": "2030-01-01",
                                                     "next_action_code": "12", "next_action_due": "2030-02-02"})
    assert client.get(f"/api/opportunities/{o2['id']}").json()["next_action_code"] == "12"


def test_automation_on_contact_create_and_pause(client):
    lst = client.post("/api/record-lists", {"entity": "prospects", "name": "New inbound"}).json()
    mgr = client.ids[MANAGER]
    for body in ({"name": "Inbound to Meera", "entity": "prospect", "trigger": "created", "action": "assign_owner", "params": {"user_id": mgr}},
                 {"name": "Inbound list", "entity": "prospect", "trigger": "created", "action": "add_to_list", "params": {"list_id": lst["id"]}}):
        assert client.post("/api/automations", body, as_=ADMIN).status_code == 201
    p = client.post("/api/prospects", {"full_name": "In Bound", "email": "ib@x.se", "next_action_code": "01", "next_action_due": "2030-01-01"}).json()
    assert p["owner_id"] == mgr
    assert p["id"] in client.get("/api/record-lists", params={"entity": "prospects"}).json()[0]["record_ids"]
    rules = client.get("/api/automations").json()
    for r in rules:
        client.patch(f"/api/automations/{r['id']}", {"active": False}, as_=ADMIN)
    p2 = client.post("/api/prospects", {"full_name": "Second One", "email": "s1@x.se", "next_action_code": "01", "next_action_due": "2030-01-01"}).json()
    assert p2["owner_id"] == client.ids[REP]
    assert client.delete(f"/api/automations/{rules[0]['id']}", as_=ADMIN).json()[0]["name"] == "Inbound list"


def test_outcomes_by_action_type(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"], next_action_code="01")
    client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "connected", "next_action_code": "02", "next_action_due": "2030-01-01"})
    client.post(f"/api/opportunities/{o['id']}/complete-action", {"outcome": "no_response", "next_action_code": "02", "next_action_due": "2030-01-02"})
    by = {r["code"]: r for r in client.get("/api/reports/outcomes", as_=MANAGER).json()["by_action"]}
    assert by["01"]["positive_rate"] == 100 and by["02"]["positive_rate"] == 0 and by["01"]["label"] == "Call prospect"


def test_merge_keeps_custom_values_and_lists(client):
    f = client.post("/api/custom-fields", {"entity": "accounts", "label": "Tier", "type": "text"}, as_=ADMIN).json()
    a, b = make_account(client, name="Acme Health"), make_account(client, name="Acmee Health")
    client.put(f"/api/custom-fields/values/accounts/{b['id']}", {"tier": "Gold"})
    lst = client.post("/api/record-lists", {"entity": "accounts", "name": "Events"}).json()
    client.post(f"/api/record-lists/{lst['id']}/members", {"ids": [b["id"]]})
    r = client.post("/api/duplicates/accounts/merge", {"keep_id": a["id"], "merge_id": b["id"], "choices": {}}, as_=ADMIN)
    assert r.status_code == 200, r.text
    assert client.get(f"/api/custom-fields/values/accounts/{a['id']}").json() == {"tier": "Gold"}
    assert client.get("/api/record-lists", params={"entity": "accounts"}).json()[0]["record_ids"] == [a["id"]] and f
