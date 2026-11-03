"""Find and merge duplicate accounts and prospects."""
from app import dedupe
from tests.conftest import MANAGER, REP, REP2


def acc(client, name, as_=REP, **kw):
    r = client.post("/api/accounts", {"name": name, "country": "Sweden", **kw}, as_=as_)
    assert r.status_code == 201, r.text
    return r.json()


def pro(client, name, as_=REP, **kw):
    r = client.post("/api/prospects", {"full_name": name, "next_action_code": "05", "next_action_due": "2030-01-01", **kw}, as_=as_)
    assert r.status_code == 201, r.text
    return r.json()


def test_helpers():
    assert dedupe.domain_of("https://www.Norvale.com/about") == "norvale.com"
    assert dedupe.linkedin_of("https://www.linkedin.com/in/elin-berg/?x=1") == "in/elin-berg"
    assert dedupe.phone_of("+46 (0)70-123 45 67") == dedupe.phone_of("070 123 45 67")


def test_find_and_merge_accounts(client):
    a = acc(client, "Norvale Pharma", website="norvale.com", industry="Pharma")
    b = acc(client, "Norvale Pharmaceuticals AB", website="https://www.norvale.com", as_=REP2, region="Stockholm")
    acc(client, "Halden Medical")
    p = pro(client, "Elin Berg", account_id=b["id"], as_=REP2)
    o = client.post("/api/opportunities", {"name": "Norvale deal", "account_id": b["id"], "next_action_code": "05", "next_action_due": "2030-01-01"}, as_=REP2).json()
    client.post(f"/api/opportunities/{o['id']}/activities", {"kind": "note", "summary": "Call went well"}, as_=REP2)

    found = client.get("/api/duplicates/accounts").json()
    assert found["count"] == 1 and found["can_merge"] is False
    pair = found["pairs"][0]
    assert {pair["a"]["name"], pair["b"]["name"]} == {"Norvale Pharma", "Norvale Pharmaceuticals AB"}
    assert any("Same website" in r for r in pair["reasons"]) and pair["score"] >= 95

    body = {"keep_id": a["id"], "merge_id": b["id"], "choices": {"owner_id": "keep", "notes": "both"}}
    assert client.post("/api/duplicates/accounts/merge", body).status_code == 403          # needs edit_all
    r = client.post("/api/duplicates/accounts/merge", body, as_=MANAGER)
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["prospects"] == 1 and r.json()["moved"]["deals"] == 1
    kept = client.get(f"/api/accounts/{a['id']}").json()
    assert kept["region"] == "Stockholm" and kept["industry"] == "Pharma"           # blank filled, existing kept
    assert client.get(f"/api/accounts/{b['id']}").status_code == 404
    assert client.get(f"/api/prospects/{p['id']}").json()["account_id"] == a["id"]
    assert client.get(f"/api/opportunities/{o['id']}").json()["account_id"] == a["id"]
    assert any("Merged “Norvale Pharmaceuticals AB”" in x["summary"] for x in kept["activities"])
    assert client.get("/api/duplicates/accounts").json()["count"] == 0
    log = client.get("/api/duplicates/merges").json()
    assert log[0]["merged_name"] == "Norvale Pharmaceuticals AB" and log[0]["merged_by"] == "manager"


def test_merge_prospects_and_dismiss(client):
    co = acc(client, "Kestrel Analytics")
    keep = pro(client, "Elin Berg", account_id=co["id"], email="elin@kestrel.example", phone="070 123 45 67")
    dup = pro(client, "Elin  Berg", account_id=co["id"], email="e.berg@kestrel.example", job_title="CMO",
              linkedin_url="https://linkedin.com/in/elinberg", next_action_code="03", next_action_due="2030-02-01")
    other = pro(client, "Elin Berg", email="elin@else.example")          # no company
    deal = client.post("/api/opportunities", {"name": "Kestrel deal", "account_id": co["id"], "primary_contact_id": dup["id"],
                                              "next_action_code": "05", "next_action_due": "2030-01-01"}).json()
    pairs = client.get("/api/duplicates/prospects").json()["pairs"]
    top = pairs[0]
    assert {top["a"]["id"], top["b"]["id"]} == {keep["id"], dup["id"]} and "Same name at the same company" in top["reasons"]
    assert len(pairs) == 3

    cmp = client.get("/api/duplicates/prospects/compare", params={"a": keep["id"], "b": dup["id"]}).json()
    assert cmp["b"]["deals"] == 1 and "next_action" in cmp["fields"]

    # Take the duplicate's email and next action; the unique email rule is respected.
    r = client.post("/api/duplicates/prospects/merge", {"keep_id": keep["id"], "merge_id": dup["id"],
                                                        "choices": {"email": "merge", "next_action": "merge"}}, as_=MANAGER)
    assert r.status_code == 200, r.text
    got = client.get(f"/api/prospects/{keep['id']}").json()
    assert (got["email"], got["job_title"], got["next_action_code"], got["next_action_due"]) == ("e.berg@kestrel.example", "CMO", "03", "2030-02-01")
    assert got["linkedin_url"] == "https://linkedin.com/in/elinberg"
    assert client.get(f"/api/opportunities/{deal['id']}").json()["primary_contact_id"] == keep["id"]
    assert any(h["field"] == "email" for h in got["history"])

    left = client.get("/api/duplicates/prospects").json()["pairs"]
    assert len(left) == 1
    assert client.post("/api/duplicates/prospects/dismiss", {"a": left[0]["a"]["id"], "b": left[0]["b"]["id"]}, as_=MANAGER).status_code == 200
    assert client.get("/api/duplicates/prospects").json()["count"] == 0
    assert other["id"]


def test_merge_validation(client):
    a = pro(client, "Mia Fox")
    b = pro(client, "Mia Fox")
    assert client.post("/api/duplicates/prospects/merge", {"keep_id": a["id"], "merge_id": a["id"]}, as_=MANAGER).status_code == 422
    assert client.post("/api/duplicates/prospects/merge", {"keep_id": a["id"], "merge_id": b["id"], "choices": {"notes": "sideways"}}, as_=MANAGER).status_code == 422
    assert client.post("/api/duplicates/prospects/merge", {"keep_id": a["id"], "merge_id": b["id"], "choices": {"email": "both"}}, as_=MANAGER).status_code == 422
    assert client.post("/api/duplicates/prospects/merge", {"keep_id": a["id"], "merge_id": "00000000-0000-0000-0000-000000000000"}, as_=MANAGER).status_code == 404
