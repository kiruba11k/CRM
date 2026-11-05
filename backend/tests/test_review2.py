"""CRM review round 2: company size, company notes, lists, bulk properties,
forecast categories, contact duplicate check."""
from tests.conftest import ADMIN, MANAGER, REP, REP2
from tests.test_api import make_account, make_opp


def test_company_size_and_notes(client):
    acc = make_account(client)
    assert client.patch(f"/api/accounts/{acc['id']}", {"company_size": "lots"}).status_code == 422
    assert client.patch(f"/api/accounts/{acc['id']}", {"company_size": "51-200"}).json()["company_size"] == "51-200"
    assert "51-200" in client.get("/api/lists").json()["company_sizes"]
    assert client.post(f"/api/accounts/{acc['id']}/activities", {"kind": "call", "summary": "Called reception"}).status_code == 201
    o = make_opp(client, acc["id"], name="Deal X")
    client.post(f"/api/opportunities/{o['id']}/activities", {"kind": "note", "summary": "On the deal"})
    acts = client.get(f"/api/accounts/{acc['id']}").json()["activities"]
    names = {a["summary"]: a["record_name"] for a in acts}
    assert names["Called reception"] == acc["name"] and names["On the deal"] == "Deal X"


def test_lists(client):
    acc = make_account(client)
    other = make_account(client, name="Kestrel Analytics")
    r = client.post("/api/record-lists", {"entity": "accounts", "name": "Arab Health invites"})
    assert r.status_code == 201
    lid = r.json()["id"]
    assert client.post("/api/record-lists", {"entity": "accounts", "name": "arab health INVITES"}).status_code == 409
    r = client.post(f"/api/record-lists/{lid}/members", {"ids": [acc["id"], other["id"], acc["id"]]}, as_=REP2)
    assert r.json()["size"] == 2 and r.json()["added"] == 2
    assert sorted(client.get("/api/record-lists", params={"entity": "accounts"}).json()[0]["record_ids"]) == sorted([acc["id"], other["id"]])
    assert client.post(f"/api/record-lists/{lid}/remove", {"ids": [other["id"]]}).json()["size"] == 1
    assert client.delete(f"/api/record-lists/{lid}", as_=REP2).status_code == 403
    assert client.delete(f"/api/record-lists/{lid}", as_=ADMIN).status_code == 200 and MANAGER
    assert client.get("/api/record-lists", params={"entity": "accounts"}).json() == []


def test_bulk_properties(client):
    a1, a2 = make_account(client), make_account(client, name="Kestrel Analytics")
    r = client.post("/api/bulk/accounts", {"ids": [a1["id"], a2["id"]], "changes": {"industry": "Pharma", "company_size": "11-50"}}).json()
    assert r["updated"] == 2
    assert client.get(f"/api/accounts/{a1['id']}").json()["industry"] == "Pharma"
    o = make_opp(client, a1["id"])
    r = client.post("/api/bulk/opportunities", {"ids": [o["id"]], "changes": {"expected_close": "2030-06-30", "deal_source": "Referral"}}).json()
    assert r["updated"] == 1, r
    assert client.get(f"/api/opportunities/{o['id']}").json()["expected_close"] == "2030-06-30"


def test_forecast_category(client):
    from app import domain
    assert [domain.forecast_category(s) for s in ("Lead identified", "Solution design", "Negotiation", "Won")] == ["Pipeline", "Best case", "Commit", "Closed won"]
    assert domain.forecast_category("Negotiation", True) == "Omitted"
    acc = make_account(client)
    o = make_opp(client, acc["id"])
    assert client.get(f"/api/opportunities/{o['id']}").json()["forecast_category"] == "Pipeline"


def test_contact_duplicates(client):
    client.post("/api/prospects", {"full_name": "Elin Berg", "email": "Elin@x.se", "next_action_code": "01", "next_action_due": "2030-01-01"})
    assert [d["full_name"] for d in client.get("/api/prospects/duplicates", params={"email": "elin@X.se "}).json()] == ["Elin Berg"]
    assert len(client.get("/api/prospects/duplicates", params={"name": "elin  berg"}).json()) == 1
    assert client.get("/api/prospects/duplicates", params={"name": "eli"}).json() == []
    assert REP


def test_nurture_contacts_wait_in_nurture_queue(client):
    from datetime import date, timedelta
    later = (date.today() + timedelta(days=60)).isoformat()
    p = client.post("/api/prospects", {"full_name": "Paused Person", "email": "p@x.se", "status": "Nurture",
                                       "next_action_code": "16", "next_action_due": later}).json()
    a = client.get("/api/actions").json()
    assert [i["id"] for i in a["nurture"]] == [p["id"]] and a["nurture"][0]["paused"] and a["nurture"][0]["days_until"] == 60
    assert p["id"] not in [i["id"] for i in a["upcoming"]]
    # When the revisit date comes it is a normal action again.
    client.patch(f"/api/prospects/{p['id']}", {"next_action_due": date.today().isoformat()})
    a = client.get("/api/actions").json()
    assert p["id"] in [i["id"] for i in a["today"]] and a["nurture"] == []
