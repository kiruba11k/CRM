"""§6.2 Gmail thread links: explicit, minimal, permissioned."""
from app.routers.email_threads import gmail_thread_ref
from tests.conftest import MANAGER, REP, REP2

THREAD = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB"


def test_thread_ref_parsing():
    assert gmail_thread_ref(THREAD) == "FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB"
    assert gmail_thread_ref("https://mail.google.com/mail/u/1/#all/18c2f3a9b7d41e05") == "18c2f3a9b7d41e05"
    assert gmail_thread_ref("https://mail.google.com/mail/u/0/#label/Clients%2FNorvale/FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB") == "FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB"
    assert gmail_thread_ref("https://mail.google.com/mail/u/0/?ik=abc&view=pt&permthid=thread-f:1781234567890123456") == "1781234567890123456"
    for bad in ("https://mail.google.com/mail/u/0/#inbox", "https://example.com/#inbox/FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB",
                "http://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB", "", "FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB"):
        assert gmail_thread_ref(bad) is None, bad


def test_link_list_and_unlink_threads(client):
    acc = client.post("/api/accounts", {"name": "Norvale Pharma", "country": "Sweden", "owner_id": client.ids[REP]}, as_=REP).json()
    body = {"entity_type": "account", "entity_id": acc["id"], "url": THREAD, "label": "Re: Q1 pilot scope"}
    assert client.post("/api/email-threads", {**body, "url": "https://example.com/x"}, as_=REP).status_code == 422
    assert client.post("/api/email-threads", {**body, "label": ""}, as_=REP).status_code == 422
    assert client.post("/api/email-threads", body, as_=REP2).status_code == 403  # not their record
    t = client.post("/api/email-threads", body, as_=REP).json()
    assert t["thread_ref"] == "FMfcgzQXJWDsKbwhBvTFGsXrMkrtnQgB" and t["linked_by_name"] == "rep"
    assert client.post("/api/email-threads", body, as_=REP).status_code == 409
    listed = client.get("/api/email-threads", params={"entity_type": "account", "entity_id": acc["id"]}, as_=REP2).json()
    assert [x["label"] for x in listed] == ["Re: Q1 pilot scope"] and set(listed[0]) >= {"url", "linked_at"}
    assert "body" not in listed[0] and "snippet" not in listed[0]
    detail = client.get(f"/api/accounts/{acc['id']}", as_=REP).json()
    assert any(a["summary"] == "Gmail thread linked: Re: Q1 pilot scope" for a in detail["activities"])
    assert client.c.delete(f"/api/email-threads/{t['id']}", headers={"X-Dev-User": REP2}).status_code == 403
    assert client.c.delete(f"/api/email-threads/{t['id']}", headers={"X-Dev-User": MANAGER}).json() == {"ok": True}
    assert client.get("/api/email-threads", params={"entity_type": "account", "entity_id": acc["id"]}, as_=REP).json() == []
