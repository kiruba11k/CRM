"""Gmail auto-logging against a fake Gmail (metadata only)."""
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app import gmailsync
from tests.conftest import MANAGER, REP, REP2
from tests.test_calendar import FakeGoogle, connect

GMAIL = "https://www.googleapis.com/auth/gmail.metadata"


class FakeGmail(FakeGoogle):
    def __init__(self):
        super().__init__()
        self.grant_gmail: set[str] = set()
        self.boxes: dict[str, list[dict]] = {}   # email -> messages, newest last
        self.history: dict[str, list[tuple[int, str]]] = {}
        self.hid = 1000
        self.expired_history = False
        self.gets = 0

    def add(self, owner, frm, to, subject, days_ago=0, labels=("INBOX",), cc="", msgid=None):
        self.hid += 1
        mid = f"m{self.hid}"
        at = datetime.now(timezone.utc) - timedelta(days=days_ago)
        headers = [{"name": "From", "value": frm}, {"name": "To", "value": to}, {"name": "Subject", "value": subject}]
        if cc:
            headers.append({"name": "Cc", "value": cc})
        headers.append({"name": "Message-ID", "value": msgid or f"<{mid}@mail.example>"})
        msg = {"id": mid, "threadId": f"t{mid}", "labelIds": list(labels), "internalDate": str(int(at.timestamp() * 1000)),
               "payload": {"headers": headers}}
        self.boxes.setdefault(owner, []).append(msg)
        self.history.setdefault(owner, []).append((self.hid, mid))
        return msg

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host == "gmail.googleapis.com":
            return self._gmail(request)
        resp = super().handler(request)
        if url.path == "/token" and b"authorization_code" in request.content:
            body = resp.json()
            if self.codes[parse_qs(request.content.decode())["code"][0]] in self.grant_gmail:
                body["scope"] += " " + GMAIL
            return httpx.Response(resp.status_code, json=body)
        return resp

    def _gmail(self, request: httpx.Request) -> httpx.Response:
        owner = request.headers["Authorization"][len("Bearer at-rt-"):]
        box = self.boxes.get(owner, [])
        path = request.url.path.split("/gmail/v1/users/me/")[1]
        if path == "profile":
            return httpx.Response(200, json={"emailAddress": owner, "historyId": str(self.hid)})
        if path == "history":
            if self.expired_history:
                return httpx.Response(404, json={"error": {"message": "Requested entity was not found."}})
            start = int(request.url.params["startHistoryId"])
            added = [{"messagesAdded": [{"message": {"id": mid}}]} for h, mid in self.history.get(owner, []) if h > start]
            return httpx.Response(200, json={"history": added, "historyId": str(self.hid)})
        if path == "messages":
            assert "q" not in request.url.params  # the metadata scope can't search
            return httpx.Response(200, json={"messages": [{"id": m["id"]} for m in reversed(box)]})
        mid = path.split("/")[1]
        self.gets += 1
        assert request.url.params["format"] == "metadata"
        for m in box:
            if m["id"] == mid:
                return httpx.Response(200, json=m)
        return httpx.Response(404, json={"error": {"message": "Not Found"}})


@pytest.fixture()
def gmail(app, client):
    fake = FakeGmail()
    app.state.google_transport = httpx.MockTransport(fake.handler)
    app.state.google = None
    yield fake
    app.state.google_transport = None
    app.state.google = None


def turn_on(client, fake, email):
    fake.grant_gmail.add(email)
    url = client.post("/api/gmail/enable", {}, as_=email).json()["url"]
    q = parse_qs(urlsplit(url).query)
    assert GMAIL in q["scope"][0] and "calendar.events" in q["scope"][0]
    code = f"gmail-{email}-{len(fake.codes)}"
    fake.codes[code] = email
    r = client.c.get("/api/calendar/oauth/callback", params={"state": q["state"][0], "code": code}, follow_redirects=False)
    assert "calendar=connected" in r.headers["location"] and "Gmail" in r.headers["location"]


def wait_first_sync(client, email):
    for _ in range(100):
        s = client.get("/api/gmail/status", as_=email).json()
        if s["first_sync_done"]:
            return s
        time.sleep(0.05)
    raise AssertionError(s)


def setup_records(client):
    acc = client.post("/api/accounts", {"name": "Norvale Pharma", "country": "Sweden"}).json()
    elin = client.post("/api/prospects", {"full_name": "Elin Berg", "email": "Elin@Norvale.example", "account_id": acc["id"],
                                          "next_action_code": "05", "next_action_due": "2030-01-01"}).json()
    opp = client.post("/api/opportunities", {"name": "Norvale · LinkedIn", "account_id": acc["id"], "primary_contact_id": elin["id"],
                                             "next_action_code": "05", "next_action_due": "2030-01-01"}).json()
    return acc, elin, opp


def emails(client, path, as_=REP):
    return [a for a in client.get(path, as_=as_).json()["activities"] if a["kind"] == "email"]


def test_parse():
    msg = {"id": "1", "threadId": "t", "labelIds": ["SENT"], "internalDate": "1700000000000", "payload": {"headers": [
        {"name": "From", "value": "Rep <rep@leadstrategus.com>"}, {"name": "To", "value": "Elin <ELIN@norvale.example>, boss@leadstrategus.com"},
        {"name": "Subject", "value": "  Proposal\n next steps "}, {"name": "Message-ID", "value": "<abc@x>"}]}}
    p = gmailsync.parse(msg, "rep@leadstrategus.com", "leadstrategus.com")
    assert p["direction"] == "out" and p["external"] == ["elin@norvale.example"] and p["subject"] == "Proposal next steps" and p["key"] == "<abc@x>"
    assert gmailsync.parse({**msg, "labelIds": ["DRAFT"]}, "rep@leadstrategus.com", "leadstrategus.com") is None


def test_auto_logging_flow(client, gmail):
    acc, elin, opp = setup_records(client)
    g = gmail
    g.add(REP, "Rep <rep@leadstrategus.com>", "Elin Berg <elin@norvale.example>", "Intro call", days_ago=3, labels=("SENT",))
    g.add(REP, "Elin Berg <elin@norvale.example>", "rep@leadstrategus.com", "Re: Intro call", days_ago=2)
    g.add(REP, "Newsletter <news@other.example>", "rep@leadstrategus.com", "Weekly news", days_ago=1)
    g.add(REP, "manager@leadstrategus.com", "rep@leadstrategus.com", "Internal only", days_ago=1)
    g.add(REP, "Elin Berg <elin@norvale.example>", "rep@leadstrategus.com", "Too old", days_ago=45)
    g.add(REP, "rep@leadstrategus.com", "elin@norvale.example", "Draft", labels=("DRAFT",))

    assert client.get("/api/gmail/status").json()["enabled"] is False
    connect(client, g, REP)                     # calendar only
    assert client.post("/api/gmail/sync", {}).status_code == 409
    turn_on(client, g, REP)
    s = wait_first_sync(client, REP)
    assert s["enabled"] and s["granted"] and s["error"] is None

    p = emails(client, f"/api/prospects/{elin['id']}")
    assert [a["summary"] for a in p] == ["Email from Elin Berg: Re: Intro call", "Email sent to Elin Berg: Intro call"]
    assert p[0]["email_direction"] == "in" and p[0]["gmail_thread_id"] and p[0]["created_by"] == "rep"
    assert len(emails(client, f"/api/opportunities/{opp['id']}")) == 2
    pr = client.get(f"/api/prospects/{elin['id']}").json()
    assert pr["last_activity_at"][:10] == (datetime.now(timezone.utc) - timedelta(days=2)).date().isoformat()

    # Incremental: only new mail is fetched; a re-sync logs nothing twice.
    before = g.gets
    assert client.post("/api/gmail/sync", {}).json() == {"status": "ok", "checked": 0, "logged": 0}
    assert g.gets == before
    g.add(REP, "rep@leadstrategus.com", "elin@norvale.example", "Proposal attached", labels=("SENT",))
    r = client.post("/api/gmail/sync", {}).json()
    assert r["checked"] == 1 and r["logged"] == 2  # prospect + open deal

    # A colleague cc'd on the same email doesn't log it again.
    connect(client, g, MANAGER)
    g.add(MANAGER, "rep@leadstrategus.com", "elin@norvale.example", "Proposal attached", labels=("INBOX",),
          cc="manager@leadstrategus.com", msgid=g.boxes[REP][-1]["payload"]["headers"][-1]["value"])
    turn_on(client, g, MANAGER)
    wait_first_sync(client, MANAGER)
    assert len(emails(client, f"/api/prospects/{elin['id']}")) == 3

    # Removing an auto-logged email takes it off every record, for good.
    target = emails(client, f"/api/prospects/{elin['id']}")[0]
    assert client.delete(f"/api/gmail/logged/{target['id']}", as_=REP2).status_code == 403
    assert client.delete(f"/api/gmail/logged/{target['id']}").json() == {"removed": 2}
    client.post("/api/gmail/disable", {})
    client.post("/api/gmail/enable", {})   # already granted: no consent screen, re-backfills
    wait_first_sync(client, REP)
    assert [a["summary"] for a in emails(client, f"/api/prospects/{elin['id']}")] == ["Email from Elin Berg: Re: Intro call", "Email sent to Elin Berg: Intro call"]

    # Expired Gmail history: catch up on the last week instead of failing.
    g.expired_history = True
    assert client.post("/api/gmail/sync", {}).json()["status"] == "ok"
    assert client.get("/api/gmail/status").json()["logged_30_days"] == 2


def test_cron_runs_gmail_sync(client, gmail):
    _, elin, _ = setup_records(client)
    connect(client, gmail, REP)
    turn_on(client, gmail, REP)
    wait_first_sync(client, REP)
    gmail.add(REP, "elin@norvale.example", "rep@leadstrategus.com", "Quick question")
    from app.config import get_settings
    get_settings().cron_secret = "s"
    try:
        r = client.c.post("/api/digest/cron", headers={"X-Cron-Secret": "s"})
        assert r.status_code == 200 and r.json()["gmail"] == {"users": 1, "logged": 2, "errors": 0}  # prospect + open deal
    finally:
        get_settings().cron_secret = ""
    assert emails(client, f"/api/prospects/{elin['id']}")[0]["summary"] == "Email from Elin Berg: Quick question"
