"""Files and links on deals."""
from tests.conftest import MANAGER, REP, REP2
from tests.test_api import make_account, make_opp


def upload(client, opp_id, name, data, as_=REP, **params):
    return client.c.post("/api/attachments/upload", params={"entity_type": "opportunity", "entity_id": opp_id, "filename": name, **params},
                         content=data, headers={"X-Dev-User": as_, "Content-Type": "application/octet-stream"})


def test_attachments(client):
    acc = make_account(client)
    opp = make_opp(client, acc["id"], next_action_due="2030-01-01")
    pdf = b"%PDF-1.4 proposal" * 100
    r = upload(client, opp["id"], "Proposal v2.pdf", pdf, kind="Proposal", note="Sent 3 Nov")
    assert r.status_code == 201, r.text
    a = r.json()
    assert (a["title"], a["kind"], a["size_bytes"], a["content_type"]) == ("Proposal v2.pdf", "Proposal", len(pdf), "application/pdf")

    d = client.get(f"/api/attachments/{a['id']}/download", as_=REP2)               # everyone can read
    assert d.status_code == 200 and d.content == pdf
    assert d.headers["content-disposition"].startswith('attachment; filename="Proposal v2.pdf"') and d.headers["x-content-type-options"] == "nosniff"

    assert upload(client, opp["id"], "evil.html", b"<script>").status_code == 415
    assert upload(client, opp["id"], "big.pdf", b"x" * (10 * 1024 * 1024 + 1)).status_code == 413
    assert upload(client, opp["id"], "empty.pdf", b"").status_code == 422
    assert upload(client, opp["id"], "x.pdf", pdf, kind="Weird").status_code == 422
    assert upload(client, opp["id"], "x.pdf", pdf, as_=REP2).status_code == 403          # not their deal

    r = client.post("/api/attachments/link", {"entity_type": "opportunity", "entity_id": opp["id"], "kind": "Contract",
                                              "url": "https://docs.google.com/document/d/abc/edit"})
    assert r.status_code == 201 and r.json()["title"] == "Google Doc"
    assert client.post("/api/attachments/link", {"entity_type": "opportunity", "entity_id": opp["id"], "url": "javascript:alert(1)"}).status_code == 422
    assert client.post("/api/attachments/link", {"entity_type": "opportunity", "entity_id": opp["id"], "url": "http://insecure.example/x"}).status_code == 422

    items = client.get("/api/attachments", params={"entity_type": "opportunity", "entity_id": opp["id"]}).json()["items"]
    assert [i["kind"] for i in items] == ["Contract", "Proposal"] and items[1]["uploaded_by_name"] == "rep"
    acts = [x["summary"] for x in client.get(f"/api/opportunities/{opp['id']}").json()["activities"]]
    assert "Attached proposal: Proposal v2.pdf" in acts and "Linked contract: Google Doc" in acts

    assert client.delete(f"/api/attachments/{a['id']}", as_=REP2).status_code == 403
    assert client.delete(f"/api/attachments/{a['id']}", as_=MANAGER).status_code == 200
    assert client.get(f"/api/attachments/{a['id']}/download").status_code == 404
    u = client.get("/api/attachments/usage/summary").json()
    assert u["files"] == 0 and u["links"] == 1 and u["db_bytes"] > 0
