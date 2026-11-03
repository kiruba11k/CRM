"""Saved views: private by default, shareable, one default per page."""
from tests.conftest import ADMIN, MANAGER, REP, REP2


def test_saved_views(client):
    body = {"page": "prospects", "name": "UK engaged", "filters": {"scope": "all", "status": "Engaged", "country": "United Kingdom"}}
    r = client.post("/api/saved-views", body)
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["mine"] and not v["shared"] and v["filters"]["status"] == "Engaged" and v["is_default"] is False
    assert client.post("/api/saved-views", body).status_code == 409                       # same name
    assert client.post("/api/saved-views", {**body, "page": "nowhere"}).status_code == 422
    assert client.post("/api/saved-views", {**body, "name": "  "}).status_code == 422

    # Private until shared.
    assert client.get("/api/saved-views", params={"page": "prospects"}, as_=REP2).json() == []
    assert client.patch(f"/api/saved-views/{v['id']}", {"name": "x"}, as_=REP2).status_code == 404
    client.patch(f"/api/saved-views/{v['id']}", {"shared": True})
    seen = client.get("/api/saved-views", params={"page": "prospects"}, as_=REP2).json()
    assert [x["name"] for x in seen] == ["UK engaged"] and seen[0]["mine"] is False and seen[0]["owner_name"] == "rep"
    assert client.patch(f"/api/saved-views/{v['id']}", {"name": "Mine now"}, as_=REP2).status_code == 403

    # Defaults are per person and per page.
    assert client.put("/api/saved-views/default", {"page": "prospects", "view_id": v["id"]}, as_=REP2).status_code == 200
    assert client.get("/api/saved-views", params={"page": "prospects"}, as_=REP2).json()[0]["is_default"] is True
    assert client.get("/api/saved-views", params={"page": "prospects"}).json()[0]["is_default"] is False
    assert client.put("/api/saved-views/default", {"page": "accounts", "view_id": v["id"]}, as_=REP2).status_code == 422
    # Un-sharing removes it as other people's default.
    client.patch(f"/api/saved-views/{v['id']}", {"shared": False})
    assert client.get("/api/saved-views", params={"page": "prospects"}, as_=REP2).json() == []
    client.patch(f"/api/saved-views/{v['id']}", {"shared": True})
    assert client.get("/api/saved-views", params={"page": "prospects"}, as_=REP2).json()[0]["is_default"] is False

    # Update filters and rename; only the owner or an admin deletes.
    r = client.patch(f"/api/saved-views/{v['id']}", {"name": "UK engaged+", "filters": {"status": "Qualified"}}).json()
    assert r["name"] == "UK engaged+" and r["filters"] == {"status": "Qualified"}
    assert client.delete(f"/api/saved-views/{v['id']}", as_=MANAGER).status_code == 403
    assert client.delete(f"/api/saved-views/{v['id']}", as_=ADMIN).status_code == 200
    assert client.get("/api/saved-views", params={"page": "prospects"}).json() == []
