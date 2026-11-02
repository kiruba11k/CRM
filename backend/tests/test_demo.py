"""Demo data: loads cleanly, passes every rule, removes only itself."""
from tests.conftest import ADMIN, REP

from app import domain


def test_demo_data_round_trip(client):
    real = client.post("/api/accounts", {"name": "Real Customer Ltd", "country": "France"}, as_=REP).json()
    assert client.post("/api/settings/demo", {"action": "load"}, as_=REP).status_code == 403
    r = client.post("/api/settings/demo", {"action": "load"}, as_=ADMIN)
    assert r.status_code == 200, r.text
    assert r.json()["counts"]["opportunities"] == 18
    assert client.post("/api/settings/demo", {"action": "load"}, as_=ADMIN).status_code == 409  # not twice

    opps = client.get("/api/opportunities", params={"include_nurtured": True}, as_=ADMIN).json()
    assert {o["stage"] for o in opps} == set(domain.STAGE_NAMES)
    assert {o["currency"] for o in opps} == {"USD", "EUR", "GBP"} and sum(o["on_nurture"] for o in opps) == 2
    for o in opps:
        assert domain.validate_opportunity(client.get(f"/api/opportunities/{o['id']}", as_=ADMIN).json())[0] == [], o["name"]
    prospects = client.get("/api/prospects", params={"scope": "all"}, as_=ADMIN).json()
    assert len(prospects) == 25 and sum(p["account_id"] is None for p in prospects) == 3
    actions = client.get("/api/actions", params={"scope": "team"}, as_=ADMIN).json()["counts"]
    assert actions["overdue"] > 0 and actions["today"] > 0 and actions["upcoming"] > 0 and actions["nurture"] == 2
    assert len(client.get("/api/import/cleanup", params={"scope": "all"}, as_=ADMIN).json()) == 2
    assert len(client.get("/api/booking-links", as_=ADMIN).json()) == 2
    users = {u["email"]: u for u in client.get("/api/users", as_=ADMIN).json()}
    assert users["demo.meera@leadstrategus.com"]["role"] == "manager"

    # A real prospect added to a demo account survives removal (unlinked).
    real_p = client.post("/api/prospects", {"full_name": "Real Person", "account_id": next(a["id"] for a in client.get("/api/accounts", as_=ADMIN).json() if a["name"] == "Kestrel Analytics"),
                                            "next_action_code": "02", "next_action_due": "2030-01-01"}, as_=REP).json()
    r = client.post("/api/settings/demo", {"action": "remove"}, as_=ADMIN).json()
    assert r == {"loaded": False, "removed": True, "kept": []}
    assert [a["name"] for a in client.get("/api/accounts", as_=ADMIN).json()] == [real["name"]]
    assert client.get(f"/api/prospects/{real_p['id']}", as_=REP).json()["account_id"] is None
    assert client.get("/api/opportunities", params={"include_nurtured": True}, as_=ADMIN).json() == []
    assert not [e for e in client.get("/api/users", as_=ADMIN).json() if e["email"].startswith("demo.")]
    # And it can be loaded again.
    assert client.post("/api/settings/demo", {"action": "load"}, as_=ADMIN).status_code == 200
