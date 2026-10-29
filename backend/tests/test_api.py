"""End-to-end API tests, one per §9 acceptance test where the API owns it."""
from tests.conftest import ADMIN, MANAGER, REP, REP2

SOON = "2026-11-02"


def errors(resp):
    return {e["field"] for e in resp.json()["detail"]["errors"]}


def make_account(api, name="Norvale Pharma", as_=REP):
    r = api.post("/api/accounts", {"name": name, "country": "Sweden"}, as_=as_)
    assert r.status_code == 201, r.text
    return r.json()


def make_opp(api, account_id, as_=REP, **kw):
    body = {"name": "Norvale · LinkedIn lead generation", "account_id": account_id, "next_action_code": "05", "next_action_due": SOON}
    body.update(kw)
    r = api.post("/api/opportunities", body, as_=as_)
    assert r.status_code == 201, r.text
    return r.json()


def test_auth_requires_workspace_account(client):
    assert client.c.get("/api/me").status_code == 401
    assert client.c.get("/api/me", headers={"X-Dev-User": "someone@gmail.com"}).status_code == 403
    me = client.get("/api/me", as_=ADMIN).json()
    assert me["role"] == "admin"


def test_record_relationships_and_duplicate_accounts(client):
    acc = make_account(client)
    for name in ("Sofia Lind", "Erik Holm"):
        r = client.post("/api/prospects", {"full_name": name, "account_id": acc["id"], "email": f"{name.split()[0].lower()}@norvale.example", "next_action_code": "02", "next_action_due": SOON})
        assert r.status_code == 201, r.text
    make_opp(client, acc["id"])
    make_opp(client, acc["id"], name="Norvale · Tradeshow pipeline")
    dup = client.post("/api/accounts", {"name": "Norvale Pharma Ltd.", "country": "Sweden"})
    assert dup.status_code == 409 and dup.json()["detail"]["existing_id"] == acc["id"]
    assert [d["id"] for d in client.get("/api/accounts/duplicates", params={"name": "norvale"}).json()] == [acc["id"]]
    detail = client.get(f"/api/accounts/{acc['id']}").json()
    assert len(detail["prospects"]) == 2 and len(detail["opportunities"]) == 2
    assert detail["opportunities"][0]["geography"] == "Sweden"  # defaulted from the account


def test_prospect_lifecycle_and_conversion_keeps_history(client):
    acc = make_account(client)
    p = client.post("/api/prospects", {"full_name": "Sofia Lind", "account_id": acc["id"], "email": "sofia@norvale.example", "next_action_code": "01", "next_action_due": SOON}).json()
    for status in ("Contacted", "Engaged"):
        assert client.patch(f"/api/prospects/{p['id']}", {"status": status}).status_code == 200
    missing = client.post(f"/api/prospects/{p['id']}/complete-action", {"next_action_code": "05"})
    assert missing.status_code == 422 and "next_action_due" in errors(missing)
    done = client.post(f"/api/prospects/{p['id']}/complete-action", {"note": "Good call", "next_action_code": "05", "next_action_due": SOON})
    assert done.status_code == 200 and done.json()["next_action_code"] == "05"
    bad = client.post(f"/api/prospects/{p['id']}/convert", {"name": "Norvale · programme", "next_action_code": "06", "next_action_due": SOON})
    assert bad.status_code == 422 and {"estimated_value", "risk_rating"} <= errors(bad)
    opp = client.post(f"/api/prospects/{p['id']}/convert", {
        "name": "Norvale · programme", "estimated_value": "42000", "risk_rating": "Medium", "next_action_code": "06", "next_action_due": SOON,
    })
    assert opp.status_code == 201, opp.text
    assert opp.json()["primary_contact_id"] == p["id"] and opp.json()["stage"] == "Qualified"
    after = client.get(f"/api/prospects/{p['id']}").json()
    assert after["status"] == "Qualified" and len(after["opportunities"]) == 1
    kinds = [a["kind"] for a in after["activities"]]
    assert "converted" in kinds and "action_completed" in kinds and kinds.count("status_change") >= 2


def test_mandatory_follow_up(client):
    acc = make_account(client)
    r = client.post("/api/opportunities", {"name": "No action", "account_id": acc["id"]})
    assert r.status_code == 422 and {"next_action_code", "next_action_due"} <= errors(r)
    r = client.post("/api/prospects", {"full_name": "No action"})
    assert r.status_code == 422 and "next_action_code" in errors(r)
    # Missing required values come back as plain-language rule errors, not "Field required".
    r = client.post("/api/prospects", {})
    assert r.status_code == 422 and "full_name" in errors(r)
    r = client.post("/api/opportunities", {"next_action_code": "05", "next_action_due": SOON})
    assert r.status_code == 422 and {"name", "account_id", "geography"} <= errors(r)
    r = client.post("/api/accounts", {})
    assert r.status_code == 422 and {"name", "country"} <= errors(r)
    assert client.post("/api/prospects", {"full_name": "Closed one", "status": "Disqualified"}).status_code == 201


def test_other_validation(client):
    acc = make_account(client)
    r = client.post("/api/opportunities", {"name": "X", "account_id": acc["id"], "next_action_code": "18", "next_action_due": SOON})
    assert r.status_code == 422 and "next_action_other" in errors(r)
    r = client.post("/api/opportunities", {"name": "X", "account_id": acc["id"], "next_action_code": "18", "next_action_other": "y" * 51, "next_action_due": SOON})
    assert r.status_code == 422
    make_opp(client, acc["id"], name="Y", next_action_code="18", next_action_other="Send event recap deck")


def test_risk_validation_and_stage_history(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"])
    r = client.patch(f"/api/opportunities/{o['id']}", {"stage": "Qualified", "estimated_value": 24000})
    assert r.status_code == 422 and "risk_rating" in errors(r)
    r = client.patch(f"/api/opportunities/{o['id']}", {"stage": "Qualified", "estimated_value": 24000, "risk_rating": "High"})
    assert r.status_code == 422 and {"high_risk_reason", "risk_mitigation"} <= errors(r)
    r = client.patch(f"/api/opportunities/{o['id']}", {"stage": "Qualified", "estimated_value": 24000, "risk_rating": "High",
                                                       "high_risk_reason": "Budget not confirmed", "risk_mitigation": "Intro to CFO"})
    assert r.status_code == 200, r.text
    assert r.json()["weighted_value"] == "3600.00" or float(r.json()["weighted_value"]) == 3600
    hist = client.get(f"/api/opportunities/{o['id']}").json()["history"]
    assert any(h["field"] == "stage" and h["old_value"] == "Lead identified" and h["new_value"] == "Qualified" for h in hist)


def test_nurture_validation_reminders_and_forecast(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"], stage="Proposal submitted", estimated_value=16000, risk_rating="Low",
                 expected_close="2027-02-28", proposal_due="2026-10-18")
    r = client.patch(f"/api/opportunities/{o['id']}", {"on_nurture": True})
    assert r.status_code == 422 and {"nurture_reason", "nurture_until", "nurture_next_action_code"} <= errors(r)
    r = client.patch(f"/api/opportunities/{o['id']}", {"on_nurture": True, "nurture_reason": "Timing delayed",
                                                       "nurture_until": "2027-01-15", "nurture_next_action_code": "17"})
    assert r.status_code == 200 and r.json()["stage"] == "Proposal submitted"  # stage kept
    pipe = client.get("/api/reports/pipeline").json()
    assert pipe["active_forecast"]["count"] == 0 and pipe["nurture"]["count"] == 1
    actions = client.get("/api/actions", params={"as_of": "2026-10-29"}).json()
    assert actions["counts"]["nurture"] == 1 and actions["counts"]["upcoming"] == 0  # no routine reminder
    back = client.post(f"/api/opportunities/{o['id']}/revisit", {"outcome": "reactivate", "next_action_code": "08", "next_action_due": SOON})
    assert back.status_code == 200 and back.json()["on_nurture"] is False
    assert client.get("/api/reports/pipeline").json()["active_forecast"]["count"] == 1


def test_closure_requires_fields_and_stops_reminders(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"], stage="Negotiation", estimated_value=27000, risk_rating="Low", expected_close="2026-11-15")
    r = client.patch(f"/api/opportunities/{o['id']}", {"stage": "Won"})
    assert r.status_code == 422 and {"actual_value", "won_date"} <= errors(r)
    r = client.patch(f"/api/opportunities/{o['id']}", {"stage": "Won", "actual_value": 26500, "won_date": "2026-10-29"})
    assert r.status_code == 200 and r.json()["next_action_code"] is None
    assert client.get("/api/actions", params={"as_of": "2026-10-29"}).json()["counts"]["upcoming"] == 0
    o2 = make_opp(client, acc["id"], name="Lost one")
    r = client.patch(f"/api/opportunities/{o2['id']}", {"stage": "Lost"})
    assert r.status_code == 422 and {"lost_reason", "lost_date"} <= errors(r)
    nurture_closed = client.patch(f"/api/opportunities/{o['id']}", {"on_nurture": True, "nurture_reason": "Timing delayed", "nurture_until": "2027-01-01", "nurture_next_action_code": "17"})
    assert nurture_closed.status_code == 422 and "on_nurture" in errors(nurture_closed)


def test_my_actions_grouping_and_escalation(client):
    acc = make_account(client)
    make_opp(client, acc["id"], name="Overdue 4bd", next_action_due="2026-10-23")
    make_opp(client, acc["id"], name="Overdue 1bd", next_action_due="2026-10-28")
    make_opp(client, acc["id"], name="Today", next_action_due="2026-10-29")
    make_opp(client, acc["id"], name="Later", next_action_due="2026-11-20")
    make_opp(client, acc["id"], as_=REP2, name="Someone else's", next_action_due="2026-10-29")
    mine = client.get("/api/actions", params={"as_of": "2026-10-29"}).json()
    assert mine["counts"] == {"overdue": 2, "today": 1, "upcoming": 1, "nurture": 0, "next_7_days": 0, "escalated": 1}
    team = client.get("/api/actions", params={"as_of": "2026-10-29", "scope": "team"}, as_=MANAGER).json()
    assert team["counts"]["today"] == 2


def test_permissions(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"], as_=REP2)
    assert client.patch(f"/api/opportunities/{o['id']}", {"name": "Hijack"}, as_=REP).status_code == 403
    assert client.patch(f"/api/opportunities/{o['id']}", {"name": "Manager edit"}, as_=MANAGER).status_code == 200
    r = client.post("/api/opportunities", {"name": "Assign", "account_id": acc["id"], "owner_id": client.ids[REP2], "next_action_code": "05", "next_action_due": SOON}, as_=REP)
    assert r.status_code == 403
    assert client.patch(f"/api/users/{client.ids[REP]}", {"role": "admin"}, as_=MANAGER).status_code == 403
    assert len(client.get("/api/opportunities", as_=REP).json()) == 1  # shared visibility


def test_currency_never_summed(client):
    acc = make_account(client)
    make_opp(client, acc["id"], name="USD", stage="Qualified", estimated_value=24000, risk_rating="Low")
    make_opp(client, acc["id"], name="GBP", stage="Qualified", estimated_value=18000, risk_rating="Low", currency="GBP")
    q = next(s for s in client.get("/api/reports/pipeline").json()["stages"] if s["stage"] == "Qualified")
    assert set(q["unweighted"]) == {"USD", "GBP"}


def test_teams_and_export(client):
    acc = make_account(client)
    o = make_opp(client, acc["id"], proposal_team=[client.ids[REP], client.ids[REP2]], database_build_team=[client.ids[REP2]])
    detail = client.get(f"/api/opportunities/{o['id']}").json()
    assert len(detail["proposal_team"]) == 2 and len(detail["database_build_team"]) == 1
    assert client.get("/api/export/opportunities.csv", as_=REP).status_code == 403
    csv = client.get("/api/export/opportunities.csv", as_=ADMIN)
    assert csv.status_code == 200 and csv.text.splitlines()[0].startswith("id,") and len(csv.text.splitlines()) == 2


def test_lists_endpoint(client):
    lists = client.get("/api/lists").json()
    assert len(lists["next_actions"]) == 18 and lists["other_max_length"] == 50
    assert [s["probability"] for s in lists["stages"]] == [5, 15, 25, 40, 55, 75, 90, 100, 0]
