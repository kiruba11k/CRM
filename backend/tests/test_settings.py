"""Editable settings: controlled lists, stage probabilities, reminders,
the shared launch checklist and the audit log."""
import asyncio

import asyncpg

from tests.conftest import ADMIN, MANAGER, RAW_DB, REP

SOON = "2026-11-02"


def lists(client, as_=REP):
    return client.get("/api/lists", as_=as_).json()


def option(view, key, value):
    return next(o for o in view["lists"][key]["options"] if o["value"] == value)


def opp(client, **kw):
    acc = client.post("/api/accounts", {"name": kw.pop("account", "Norvale Pharma"), "country": "Sweden"}).json()
    body = {"name": "Norvale · deal", "account_id": acc["id"], "next_action_code": "05", "next_action_due": SOON, **kw}
    r = client.post("/api/opportunities", body)
    assert r.status_code == 201, r.text
    return r.json()


def test_add_rename_retire_and_protect_options(client):
    add = lambda key, value, as_=ADMIN: client.post(f"/api/settings/lists/{key}", {"value": value}, as_=as_)  # noqa: E731
    change = lambda key, body, as_=ADMIN: client.patch(f"/api/settings/lists/{key}", body, as_=as_)  # noqa: E731

    assert add("service_lines", "Account-based marketing", as_=REP).status_code == 403
    assert add("next_actions", "Dance").status_code == 404
    assert add("service_lines", "Account-based marketing").status_code == 201
    assert add("service_lines", "account-based MARKETING").status_code == 409
    assert "Account-based marketing" in lists(client)["service_lines"]
    o = opp(client, service_line="Account-based marketing")

    # Rename updates every record that uses the option.
    view = change("service_lines", {"value": "Account-based marketing", "rename_to": "ABM programmes"}).json()
    assert option(view, "service_lines", "ABM programmes")["in_use"] == 1
    assert client.get(f"/api/opportunities/{o['id']}").json()["service_line"] == "ABM programmes"

    # Retire: hidden from dropdowns, but records keep a valid value.
    change("service_lines", {"value": "ABM programmes", "active": False})
    current = lists(client)
    assert "ABM programmes" not in current["service_lines"] and current["retired"]["service_lines"] == ["ABM programmes"]
    assert client.patch(f"/api/opportunities/{o['id']}", {"name": "Still saves"}).status_code == 200
    assert change("service_lines", {"value": "ABM programmes", "active": True}).status_code == 200
    assert "ABM programmes" in lists(client)["service_lines"]

    # Values the CRM relies on stay put; every list keeps an active option.
    assert change("lost_reasons", {"value": "Other", "active": False}).status_code == 409
    assert change("lost_reasons", {"value": "Other", "rename_to": "Misc"}).status_code == 409
    assert add("currencies", "chf").json()["lists"]["currencies"]["options"][-1]["value"] == "CHF"
    assert add("currencies", "Swiss francs").status_code == 422
    assert change("currencies", {"value": "CHF", "rename_to": "CHE"}).status_code == 422
    for code in ("EUR", "GBP", "CHF"):
        assert change("currencies", {"value": code, "active": False}).status_code == 200
    assert change("currencies", {"value": "USD", "active": False}).status_code == 409

    order = ["Other", "Partner", "Inbound", "Event / tradeshow", "Referral", "Outbound"]
    assert client.c.put("/api/settings/lists/sources/order", json={"values": order[:-1]}, headers={"X-Dev-User": ADMIN}).status_code == 422
    assert client.c.put("/api/settings/lists/sources/order", json={"values": order}, headers={"X-Dev-User": ADMIN}).status_code == 200
    assert lists(client)["sources"] == order

    audit = [c["summary"] for c in client.get("/api/settings/changes").json()]
    assert "Renamed “Account-based marketing” to “ABM programmes” on 1 record(s)." in audit
    assert "Retired “ABM programmes” (1 record(s) keep it)." in audit


def test_stage_probabilities_drive_weighted_values(client):
    o = opp(client, stage="Qualified", estimated_value=10000, risk_rating="Low")
    assert client.get(f"/api/opportunities/{o['id']}").json()["probability"] == 15
    put = lambda body, as_=ADMIN: client.c.put("/api/settings/stages", json=body, headers={"X-Dev-User": as_})  # noqa: E731
    assert put({"probabilities": {"Qualified": 20}}, as_=MANAGER).status_code == 403
    assert put({"probabilities": {"Qualified": 30}}).status_code == 422  # must stay below Discovery (25)
    assert put({"probabilities": {"Won": 90}}).status_code == 422
    assert put({"probabilities": {"Qualified": 20}}).status_code == 200
    got = client.get(f"/api/opportunities/{o['id']}").json()
    assert got["probability"] == 20 and float(got["weighted_value"]) == 2000
    q = next(s for s in client.get("/api/reports/pipeline").json()["stages"] if s["stage"] == "Qualified")
    assert q["probability"] == 20 and float(q["weighted"]["USD"]) == 2000
    assert next(s for s in lists(client)["stages"] if s["name"] == "Qualified")["probability"] == 20


def test_reminder_settings(client):
    opp(client, name="Overdue 1bd", next_action_due="2026-10-28")
    opp(client, name="Due Friday", next_action_due="2026-10-30", account="Oriel Packaging")
    counts = lambda: client.get("/api/actions", params={"as_of": "2026-10-29"}).json()["counts"]  # noqa: E731
    assert counts()["escalated"] == 0 and counts()["due_next_business_day"] == 0
    put = lambda body: client.c.put("/api/settings/reminders", json=body, headers={"X-Dev-User": ADMIN})  # noqa: E731
    assert put({"escalation_days": 0}).status_code == 422
    assert put({"escalation_days": 1, "due_before": True}).status_code == 200
    assert counts()["escalated"] == 1 and counts()["due_next_business_day"] == 1
    put({"escalation": False})
    assert counts()["escalated"] == 0
    assert lists(client)["reminders"]["escalation"] is False

    # Meeting reminder defaults apply when a meeting doesn't say.
    put({"meeting_15": False, "meeting_day": True})
    m = client.post("/api/meetings", {"title": "Check-in", "starts_at": "2030-01-15T14:30:00+00:00"}).json()
    assert (m["reminder_15"], m["reminder_day"]) == (False, True)


def test_launch_checklist_is_shared(client):
    items = client.get("/api/settings/checklist").json()
    assert len(items) == 25 and not any(i["done"] for i in items)
    assert client.patch("/api/settings/checklist/t_other", {"done": True}).status_code == 403
    assert client.patch("/api/settings/checklist/nope", {"done": True}, as_=MANAGER).status_code == 404
    r = client.patch("/api/settings/checklist/t_other", {"done": True, "note": "Checked 29 Oct"}, as_=MANAGER).json()
    item = next(i for i in r if i["key"] == "t_other")
    assert item["done"] and item["note"] == "Checked 29 Oct" and item["updated_by"] == "manager"
    # Another user sees the same tick.
    assert next(i for i in client.get("/api/settings/checklist", as_=ADMIN).json() if i["key"] == "t_other")["done"]
    client.patch("/api/settings/checklist/t_other", {"note": "Re-checked"}, as_=MANAGER)
    item = next(i for i in client.get("/api/settings/checklist").json() if i["key"] == "t_other")
    assert item["done"] and item["note"] == "Re-checked"


def test_changes_from_another_instance_are_picked_up(client):
    async def other_instance():
        con = await asyncpg.connect(RAW_DB)
        try:
            await con.execute("INSERT INTO list_options(list_key, value, position) VALUES ('sources', 'Webinar', 99)")
        finally:
            await con.close()

    asyncio.run(other_instance())
    assert "Webinar" in lists(client)["sources"]
    assert opp(client, deal_source="Webinar")["deal_source"] == "Webinar"
