"""People & access: adding people, roles as permission sets, lock-out guards."""
from tests.conftest import ADMIN, MANAGER, REP, REP2


def test_me_carries_permissions(client):
    me = client.get("/api/me", as_=ADMIN).json()
    assert me["role"] == "admin" and "manage_users" in me["permissions"] and me["role_name"] == "Admin"
    assert client.get("/api/me", as_=REP).json()["permissions"] == []
    assert set(client.get("/api/me", as_=MANAGER).json()["permissions"]) == {"edit_all", "team_view", "import_data", "export_data", "set_targets"}


def test_add_and_edit_people(client):
    body = {"email": "Priya@leadstrategus.com", "name": "Priya Nair", "title": "Delivery lead", "role": "project_manager"}
    assert client.post("/api/users", body, as_=REP).status_code == 403
    assert client.post("/api/users", {**body, "email": "priya@gmail.com"}, as_=ADMIN).status_code == 422
    assert client.post("/api/users", {**body, "role": "wizard"}, as_=ADMIN).status_code == 422
    r = client.post("/api/users", body, as_=ADMIN)
    assert r.status_code == 201, r.text
    p = r.json()
    assert (p["email"], p["role_name"], p["title"], p["last_seen_at"]) == ("priya@leadstrategus.com", "Project manager", "Delivery lead", None)
    assert client.post("/api/users", body, as_=ADMIN).status_code == 409

    # Their first sign-in keeps what the admin set up.
    me = client.get("/api/me", as_="priya@leadstrategus.com").json()
    assert me["role"] == "project_manager" and me["name"] == "Priya Nair" and set(me["permissions"]) == {"team_view", "export_data"}
    listed = {u["email"]: u for u in client.get("/api/users").json()}
    assert listed["priya@leadstrategus.com"]["last_seen_at"] is not None

    r = client.patch(f"/api/users/{p['id']}", {"title": "Head of delivery", "role": "manager"}, as_=ADMIN)
    assert r.json()["title"] == "Head of delivery" and r.json()["role_name"] == "Sales manager"
    assert client.patch(f"/api/users/{p['id']}", {"active": False}, as_=ADMIN).json()["active"] is False
    assert client.get("/api/me", as_="priya@leadstrategus.com").status_code == 403

    # Nobody can lock themselves (or the team) out.
    admin_id = client.ids[ADMIN]
    assert client.patch(f"/api/users/{admin_id}", {"active": False}, as_=ADMIN).status_code == 409
    assert client.patch(f"/api/users/{admin_id}", {"role": "salesperson"}, as_=ADMIN).status_code == 409
    log = client.get("/api/settings/changes", as_=ADMIN).json()
    items = log if isinstance(log, list) else log.get("items", [])
    assert any("Added Priya Nair" in c["summary"] for c in items) and any("deactivated" in c["summary"] for c in items)


def test_roles_control_access(client):
    assert client.post("/api/roles", {"name": "Analyst"}, as_=MANAGER).status_code == 403
    assert client.post("/api/roles", {"name": "Analyst", "permissions": ["fly"]}, as_=ADMIN).status_code == 422
    r = client.post("/api/roles", {"name": "Analyst", "description": "Reporting only", "permissions": ["export_data", "team_view"]}, as_=ADMIN)
    assert r.status_code == 201
    analyst = next(x for x in r.json()["roles"] if x["name"] == "Analyst")
    assert analyst["key"] == "analyst" and analyst["permissions"] == ["team_view", "export_data"]  # catalog order
    assert client.post("/api/roles", {"name": "analyst"}, as_=ADMIN).status_code == 409

    rep2 = client.ids[REP2]
    client.patch(f"/api/users/{rep2}", {"role": "analyst"}, as_=ADMIN)
    assert client.get("/api/export/accounts.csv", as_=REP2).status_code == 200
    assert client.post("/api/import/csv/analyze", {"entity": "accounts", "text": "Name\nX\n"}, as_=REP2).status_code == 403
    client.patch("/api/roles/analyst", {"permissions": ["team_view"]}, as_=ADMIN)
    r = client.get("/api/export/accounts.csv", as_=REP2)
    assert r.status_code == 403 and "Export CSV" in r.json()["detail"]

    # A custom role can manage people too.
    client.post("/api/roles", {"name": "People ops", "permissions": ["manage_users"]}, as_=ADMIN)
    client.patch(f"/api/users/{client.ids[MANAGER]}", {"role": "people_ops"}, as_=ADMIN)
    assert client.post("/api/users", {"email": "new@leadstrategus.com", "name": "New Person"}, as_=MANAGER).status_code == 201

    assert client.patch("/api/roles/admin", {"permissions": ["edit_all"]}, as_=ADMIN).status_code == 409
    assert client.patch("/api/roles/admin", {"name": "Owner"}, as_=ADMIN).status_code == 200
    assert client.delete("/api/roles/salesperson", as_=ADMIN).status_code == 409
    assert client.delete("/api/roles/analyst", as_=ADMIN).status_code == 409   # someone still has it
    r = client.delete("/api/roles/analyst?reassign_to=salesperson", as_=ADMIN)
    assert r.status_code == 200 and "analyst" not in {x["key"] for x in r.json()["roles"]}
    assert client.get("/api/me", as_=REP2).json()["role"] == "salesperson"


def test_cannot_remove_the_last_people_manager(client):
    # Only ADMIN can manage people; taking it away from the only role that has
    # it (via a custom role) is refused.
    client.post("/api/roles", {"name": "Boss", "permissions": ["manage_users"]}, as_=ADMIN)
    client.patch(f"/api/users/{client.ids[MANAGER]}", {"role": "boss"}, as_=ADMIN)
    client.patch(f"/api/users/{client.ids[ADMIN]}", {"active": True}, as_=ADMIN)
    # Manager (Boss) deactivates the admin: allowed, because Boss can still manage people.
    assert client.patch(f"/api/users/{client.ids[ADMIN]}", {"active": False}, as_=MANAGER).status_code == 200
    # Now removing manage_users from Boss would lock everyone out.
    r = client.patch("/api/roles/boss", {"permissions": []}, as_=MANAGER)
    assert r.status_code == 409 and "nobody" in r.json()["detail"]
