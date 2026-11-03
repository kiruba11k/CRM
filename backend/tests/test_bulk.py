"""Bulk actions reuse single-record rules and report what they skipped."""
from tests.conftest import MANAGER, REP, REP2
from tests.test_api import make_account, make_opp


def prospect(client, name, as_=REP, **kw):
    r = client.post("/api/prospects", {"full_name": name, "next_action_code": "05", "next_action_due": "2030-01-01", **kw}, as_=as_)
    assert r.status_code == 201, r.text
    return r.json()


def test_bulk_prospects(client):
    a, b = prospect(client, "Ann One"), prospect(client, "Bo Two")
    other = prospect(client, "Cy Three", as_=REP2)
    rep2 = client.ids[REP2]

    # A salesperson can change their own records but not others', nor give them away.
    r = client.post("/api/bulk/prospects", {"ids": [a["id"], b["id"], other["id"]], "changes": {"status": "Contacted"}}).json()
    assert r["updated"] == 2 and [f["name"] for f in r["failed"]] == ["Cy Three"] and "own" in r["failed"][0]["message"]
    assert client.get(f"/api/prospects/{a['id']}").json()["status"] == "Contacted"
    hist = client.get(f"/api/prospects/{a['id']}").json()["history"]
    assert any(h["field"] == "status" and h["new_value"] == "Contacted" for h in hist)
    r = client.post("/api/bulk/prospects", {"ids": [a["id"]], "changes": {"owner_id": rep2}}).json()
    assert r["updated"] == 0 and "managers" in r["failed"][0]["message"].lower()

    # A manager reassigns and sets the next action for several at once.
    r = client.post("/api/bulk/prospects", {"ids": [a["id"], b["id"], other["id"]],
                                            "changes": {"owner_id": rep2, "next_action_code": "03", "next_action_due": "2030-02-01"}}, as_=MANAGER).json()
    assert r["updated"] == 3 and r["failed"] == []
    got = client.get(f"/api/prospects/{b['id']}", as_=MANAGER).json()
    assert (got["owner_id"], got["next_action_code"], got["next_action_due"]) == (rep2, "03", "2030-02-01")

    # Rules still apply: "Other" needs a description.
    r = client.post("/api/bulk/prospects", {"ids": [a["id"]], "changes": {"next_action_code": "18", "next_action_due": "2030-02-01"}}, as_=MANAGER).json()
    assert r["updated"] == 0 and r["failed"][0]["message"]


def test_bulk_validation_and_opportunities(client):
    acc = make_account(client)
    o1 = make_opp(client, acc["id"], name="Deal one", next_action_due="2030-01-01")
    o2 = make_opp(client, acc["id"], name="Deal two", next_action_due="2030-01-01", estimated_value=1000, risk_rating="Low", expected_close="2030-03-01")
    assert client.post("/api/bulk/opportunities", {"ids": [o1["id"]], "changes": {"name": "x"}}).status_code == 422
    assert client.post("/api/bulk/opportunities", {"ids": [], "changes": {"stage": "Qualified"}}).status_code == 422
    assert client.post("/api/bulk/opportunities", {"ids": [o1["id"]], "changes": {}}).status_code == 422
    r = client.post("/api/bulk/opportunities", {"ids": [o1["id"], o2["id"], "00000000-0000-0000-0000-000000000000"],
                                                "changes": {"stage": "Qualified"}}).json()
    # Qualified needs value + risk: only the deal that has them moves.
    assert r["updated"] == 1 and r["updated_ids"] == [o2["id"]]
    assert {f["name"] for f in r["failed"]} == {"Deal one", None}

    r = client.post("/api/bulk/accounts", {"ids": [acc["id"]], "changes": {"status": "Active customer"}}).json()
    assert r["updated"] == 1 and client.get(f"/api/accounts/{acc['id']}").json()["status"] == "Active customer"
    r = client.post("/api/bulk/accounts", {"ids": [acc["id"]], "changes": {"status": "Nope"}}).json()
    assert r["updated"] == 0 and r["failed"][0]["name"] == "Norvale Pharma"
