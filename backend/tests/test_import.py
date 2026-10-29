"""HubSpot import: pure mapping rules, then full runs against a fake HubSpot."""
import json
import time
from datetime import date

import httpx
import pytest

from app import importer
from app.hubspot import HubSpot
from tests.conftest import ADMIN, REP

TODAY = date(2026, 10, 29)


# ── Pure rules ────────────────────────────────────────────────────────

def test_lost_reason_mapping():
    assert importer.map_lost_reason(None) == ("Other", importer.LOST_NOT_RECORDED)
    assert importer.map_lost_reason("budget") == ("Budget", None)
    assert importer.map_lost_reason("Went with a competitor") == ("Chose a competitor", "Went with a competitor")
    assert importer.map_lost_reason("Procurement freeze") == ("Other", "Procurement freeze")


def test_task_becomes_next_action():
    call = {"properties": {"hs_task_type": "CALL", "hs_timestamp": "2030-01-10T09:00:00Z"}}
    assert importer.task_next_action(call, TODAY) == ("01", None, date(2030, 1, 10))
    todo = {"properties": {"hs_task_type": "TODO", "hs_task_subject": "x" * 80}}
    code, other, due = importer.task_next_action(todo, TODAY)
    assert code == "18" and len(other) == 50 and due == TODAY


def test_stage_suggestions():
    pipes = [{"stages": [
        {"id": "qualifiedtobuy", "metadata": {"probability": "0.2"}},
        {"id": "custom_won", "metadata": {"probability": "1.0", "isClosed": "true"}},
        {"id": "custom_lost", "metadata": {"probability": "0.0", "isClosed": "true"}},
        {"id": "custom_half", "metadata": {"probability": "0.5"}},
    ]}]
    assert importer.suggest_stage_map(pipes) == {
        "qualifiedtobuy": "Qualified", "custom_won": "Won", "custom_lost": "Lost", "custom_half": "Proposal submitted"}


def test_won_deal_without_amount_is_flagged_not_dropped():
    row, notes = importer.map_deal(
        {"id": "9", "properties": {"dealname": "Oriel", "dealstage": "closedwon", "closedate": "2026-06-01T00:00:00Z"}},
        stage="Won", account_id="acc", country="UAE", no_company=False, contact_id=None, owner_id=None,
        importer_id="me", default_currency="USD", task=None, today=TODAY)
    assert row["stage"] == "Won" and row["won_date"] == date(2026, 6, 1) and row["owner_id"] == "me"
    assert importer.NOTE["owner"] in notes and "Won needs the actual contract value." in notes


def test_html_is_stripped_and_capped():
    assert importer.strip_html("<p>Kickoff &amp; scope</p>") == "Kickoff & scope"
    assert len(importer.strip_html("a" * 2000)) == 1000


# ── Fake HubSpot ──────────────────────────────────────────────────────

def _assoc(**kinds):
    return {k: {"results": [{"id": i, "type": k} for i in ids]} for k, ids in kinds.items()}


class FakeHubSpot:
    PAGE = 2

    def __init__(self):
        self.status = 200
        self.throttle_once = True
        self.owners = [
            {"id": "o1", "email": "rep@leadstrategus.com", "firstName": "Rep", "lastName": "One"},
            {"id": "o2", "email": "newbie@leadstrategus.com", "firstName": "New", "lastName": "Person"},
            {"id": "o3", "email": "agency@other.example"},
        ]
        self.objects = {
            "companies": [
                {"id": "c1", "properties": {"name": "Norvale Pharma", "domain": "norvale.example", "country": "Sweden", "hubspot_owner_id": "o1", "industry": "PHARMACEUTICALS"}},
                {"id": "c2", "properties": {"name": "Norvale Pharma AB", "domain": "www.norvale.example", "country": "Sweden"}},
                {"id": "c3", "properties": {"name": "Oriel Packaging", "hubspot_owner_id": "o3", "lifecyclestage": "customer"}},
            ],
            "contacts": [
                {"id": "k1", "properties": {"firstname": "Sofia", "lastname": "Lind", "email": "Sofia@norvale.example", "hs_lead_status": "CONNECTED", "hubspot_owner_id": "o1"}, "associations": _assoc(companies=["c1"])},
                {"id": "k2", "properties": {"firstname": "Lone", "hs_lead_status": "UNQUALIFIED"}},
                {"id": "k3", "properties": {"firstname": "Ines", "lastname": "Duarte", "email": "ines@oriel.example", "hubspot_owner_id": "o2"}, "associations": _assoc(companies=["c3"])},
            ],
            "deals": [
                {"id": "d1", "properties": {"dealname": "Norvale · LinkedIn", "dealstage": "qualifiedtobuy", "amount": "12000", "deal_currency_code": "EUR", "hubspot_owner_id": "o1", "closedate": "2027-01-31T00:00:00Z"}, "associations": _assoc(companies=["c1"], contacts=["k1"])},
                {"id": "d2", "properties": {"dealname": "Oriel · Tradeshow", "dealstage": "closedwon", "closedate": "2026-06-01T00:00:00Z"}, "associations": _assoc(companies=["c3"])},
                {"id": "d3", "properties": {"dealname": "Lone · GTM", "dealstage": "closedlost", "closed_lost_reason": "Went with a competitor", "hubspot_owner_id": "o1", "closedate": "2026-05-01T00:00:00Z"}, "associations": _assoc(contacts=["k2"])},
                {"id": "d4", "properties": {"dealname": "Mystery deal", "dealstage": "custom_half", "hubspot_owner_id": "o3"}},
            ],
            "tasks": [
                {"id": "t1", "properties": {"hs_task_type": "CALL", "hs_task_status": "NOT_STARTED", "hs_task_subject": "Intro call", "hs_timestamp": "2030-01-10T09:00:00Z"}, "associations": _assoc(contacts=["k3"])},
                {"id": "t2", "properties": {"hs_task_type": "TODO", "hs_task_status": "NOT_STARTED", "hs_task_subject": "Send proposal deck", "hs_timestamp": "2030-02-01T09:00:00Z", "hubspot_owner_id": "o1"}, "associations": _assoc(deals=["d1"])},
                {"id": "t3", "properties": {"hs_task_type": "TODO", "hs_task_status": "COMPLETED", "hs_task_subject": "Old task"}, "associations": _assoc(deals=["d1"])},
            ],
            "notes": [
                {"id": "n1", "properties": {"hs_note_body": "<p>Kickoff &amp; scope</p>", "hs_timestamp": "2026-09-01T10:00:00Z", "hubspot_owner_id": "o1"}, "associations": _assoc(deals=["d1"])},
                {"id": "n2", "properties": {"hs_note_body": "Orphan"}},
            ],
            "calls": [], "meetings": [],
            "emails": [{"id": "e1", "properties": {"hs_email_subject": "Pricing", "hs_email_direction": "EMAIL", "hs_timestamp": "2026-09-02T10:00:00Z"}, "associations": _assoc(contacts=["k1"])}],
        }
        self.pipelines = [{"id": "default", "label": "Sales", "stages": [
            {"id": s, "label": s, "displayOrder": i, "metadata": {"probability": p, "isClosed": c}}
            for i, (s, p, c) in enumerate([("qualifiedtobuy", "0.2", "false"), ("custom_half", "0.5", "false"),
                                           ("closedwon", "1.0", "true"), ("closedlost", "0.0", "true")])]}]

    def _page(self, items, request):
        start = int(request.url.params.get("after") or 0)
        body = {"results": items[start:start + self.PAGE]}
        if start + self.PAGE < len(items):
            body["paging"] = {"next": {"after": str(start + self.PAGE)}}
        return body

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-token"
        if self.status != 200:
            return httpx.Response(self.status, json={"message": "Authentication credentials not found."})
        path = request.url.path
        if path.startswith("/crm/v3/objects/companies") and self.throttle_once:
            self.throttle_once = False
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"message": "slow down"})
        if path == "/account-info/v3/details":
            return httpx.Response(200, json={"portalId": 123, "uiDomain": "app.hubspot.com", "companyCurrency": "USD", "timeZone": "Europe/London"})
        if path == "/crm/v3/owners":
            return httpx.Response(200, json=self._page(self.owners, request))
        if path == "/crm/v3/pipelines/deals":
            return httpx.Response(200, json={"results": self.pipelines})
        obj = path.split("/")[4]
        if path.endswith("/search"):
            return httpx.Response(200, json={"total": len(self.objects[obj])})
        return httpx.Response(200, json=self._page(self.objects[obj], request))


@pytest.fixture()
def hubspot(app, client, monkeypatch):
    fake = FakeHubSpot()
    monkeypatch.setattr(HubSpot, "retry_delays", (0, 0, 0, 0, 0))
    app.state.hubspot_transport = httpx.MockTransport(fake.handler)
    yield fake
    app.state.hubspot_transport = None


def run_import(client, body=None):
    r = client.post("/api/import/hubspot/runs", body or {}, as_=ADMIN)
    assert r.status_code == 202, r.text
    run_id = r.json()["id"]
    for _ in range(200):
        run = client.get(f"/api/import/hubspot/runs/{run_id}", as_=ADMIN).json()
        if run["status"] != "running":
            return run
        time.sleep(0.05)
    raise AssertionError("import did not finish")


def test_import_is_admin_only_and_needs_token(client, hubspot, app):
    assert client.post("/api/import/hubspot/runs", {}, as_=REP).status_code == 403
    from app.config import Settings, get_settings

    app.dependency_overrides[get_settings] = lambda: Settings(hubspot_token="", dev_auth=True, admin_emails=ADMIN)
    try:
        r = client.post("/api/import/hubspot/test", {}, as_=ADMIN)
        assert r.status_code == 503 and "CRM_HUBSPOT_TOKEN" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_connection_summary_and_preview(client, hubspot):
    t = client.post("/api/import/hubspot/test", {}, as_=ADMIN).json()
    assert t["portal_id"] == 123 and t["owners"] == 3
    s = client.get("/api/import/hubspot/summary", as_=ADMIN).json()
    assert s["totals"]["deals"] == 4 and s["suggested_stage_map"]["custom_half"] == "Proposal submitted"
    issues = {i["key"]: i["count"] for i in client.post("/api/import/hubspot/preview", {}, as_=ADMIN).json()["issues"]}
    assert issues["won_no_amount"] == 1 and issues["duplicate_companies"] == 2 and issues["no_next_step"] == 1
    assert issues["no_company"] == 1 and issues["no_country"] == 1


def test_full_import_then_rerun(client, hubspot):
    run = run_import(client)
    assert run["status"] == "succeeded", run
    c = run["counts"]
    assert c["accounts"]["created"] == 2 and c["accounts"]["merged"] == 1
    assert c["prospects"]["created"] == 3 and c["opportunities"]["created"] == 4
    assert c["activities"]["created"] == 5 and c["activities"]["failed"] == 1
    assert c["users"]["created"] == 1
    assert any("agency@other.example" in e["message"] for e in run["errors"])

    users = {u["email"] for u in client.get("/api/users", as_=ADMIN).json()}
    assert "newbie@leadstrategus.com" in users and "agency@other.example" not in users

    accounts = {a["name"]: a for a in client.get("/api/accounts", as_=ADMIN).json()}
    assert set(accounts) == {"Norvale Pharma", "Oriel Packaging", importer.UNASSIGNED_ACCOUNT}
    assert accounts["Oriel Packaging"]["country"] == "Unknown" and accounts["Oriel Packaging"]["status"] == "Active customer"

    opps = {o["name"]: o for o in client.get("/api/opportunities", params={"include_nurtured": True}, as_=ADMIN).json()}
    d1 = opps["Norvale · LinkedIn"]
    assert (d1["stage"], d1["currency"], d1["next_action_code"], d1["next_action_other"], d1["next_action_due"]) == \
        ("Qualified", "EUR", "18", "Send proposal deck", "2030-02-01")
    assert opps["Mystery deal"]["stage"] == "Proposal submitted" and opps["Mystery deal"]["account_name"] == importer.UNASSIGNED_ACCOUNT
    lost = opps["Lone · GTM"]
    assert (lost["lost_reason"], lost["lost_notes"]) == ("Chose a competitor", "Went with a competitor")

    prospects = {p["full_name"]: p for p in client.get("/api/prospects", params={"scope": "all"}, as_=ADMIN).json()}
    assert prospects["Sofia Lind"]["email"] == "sofia@norvale.example" and prospects["Sofia Lind"]["status"] == "Engaged"
    assert prospects["Ines Duarte"]["next_action_code"] == "01" and prospects["Ines Duarte"]["next_action_due"] == "2030-01-10"
    assert prospects["Lone"]["status"] == "Disqualified" and prospects["Lone"]["next_action_code"] is None

    detail = client.get(f"/api/opportunities/{d1['id']}", as_=ADMIN).json()
    assert any(a["summary"] == "[HubSpot] Kickoff & scope" for a in detail["activities"])

    cleanup = client.get("/api/import/cleanup", params={"scope": "all"}, as_=ADMIN).json()
    reasons = {(c["entity"], c["name"]): c["reasons"] for c in cleanup}
    assert "Risk rating must be Low, Medium or High from Qualified." in reasons[("opportunity", "Norvale · LinkedIn")]
    assert "Won needs the actual contract value." in reasons[("opportunity", "Oriel · Tradeshow")]
    assert importer.NOTE["duplicate"] in reasons[("account", "Norvale Pharma")]
    assert importer.NOTE["no_country"] in reasons[("account", "Oriel Packaging")]
    # The rep sees their own cleanup items.
    mine = client.get("/api/import/cleanup", as_=REP).json()
    assert {c["name"] for c in mine} >= {"Norvale · LinkedIn", "Sofia Lind"}

    # Fix one deal in the CRM: it leaves the cleanup list...
    r = client.patch(f"/api/opportunities/{d1['id']}", {"risk_rating": "Low"}, as_=REP)
    assert r.status_code == 200, r.text
    names = {c["name"] for c in client.get("/api/import/cleanup", params={"scope": "all"}, as_=ADMIN).json()}
    assert "Norvale · LinkedIn" not in names

    # ...and a re-run neither duplicates anything nor overwrites the edit.
    hubspot.objects["deals"][1]["properties"]["amount"] = "9000"
    run2 = run_import(client)
    assert run2["status"] == "succeeded", run2
    assert run2["counts"]["opportunities"] == {"created": 0, "updated": 3, "kept": 1, "merged": 0, "failed": 0}
    assert run2["counts"]["activities"]["created"] == 0
    opps2 = {o["name"]: o for o in client.get("/api/opportunities", params={"include_nurtured": True}, as_=ADMIN).json()}
    assert len(opps2) == 4 and opps2["Norvale · LinkedIn"]["risk_rating"] == "Low"
    assert float(opps2["Oriel · Tradeshow"]["actual_value"]) == 9000


def test_existing_crm_records_are_linked_not_overwritten(client, hubspot):
    acc = client.post("/api/accounts", {"name": "Norvale Pharma", "country": "Norway"}, as_=REP).json()
    run = run_import(client)
    assert run["status"] == "succeeded", run
    # c1 links to the CRM account by name; c2 shares c1's domain, so it merges too.
    assert run["counts"]["accounts"]["merged"] == 2
    accounts = {a["name"]: a for a in client.get("/api/accounts", as_=ADMIN).json()}
    assert "Norvale Pharma AB" not in accounts and accounts["Norvale Pharma"]["country"] == "Norway"
    opps = {o["name"]: o for o in client.get("/api/opportunities", as_=ADMIN).json()}
    assert opps["Norvale · LinkedIn"]["account_id"] == acc["id"]
    # A second run still leaves the CRM-owned account alone.
    run_import(client)
    assert client.get(f"/api/accounts/{acc['id']}", as_=ADMIN).json()["country"] == "Norway"


def test_bad_token_gives_a_clear_message(client, hubspot):
    r = client.post("/api/import/hubspot/test", {}, as_=ADMIN)
    assert r.status_code == 200
    hubspot.status = 401
    r = client.post("/api/import/hubspot/test", {}, as_=ADMIN)
    assert r.status_code == 502 and "CRM_HUBSPOT_TOKEN" in r.json()["detail"]


def test_one_run_at_a_time(client, hubspot, app):
    async def insert_running():
        async with app.state.pool.acquire() as con:
            await con.execute("INSERT INTO import_runs(status, options) VALUES ('running', $1::jsonb)", json.dumps({}))

    client.c.portal.call(insert_running)
    r = client.post("/api/import/hubspot/runs", {}, as_=ADMIN)
    assert r.status_code == 409
