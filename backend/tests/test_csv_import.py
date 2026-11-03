"""Bulk CSV import: analyze → plan → commit for accounts, prospects, deals."""
from app import csvimport
from tests.conftest import ADMIN, MANAGER, REP

ACCOUNTS = "Company Name,Country,Industry,Website,Account Owner\nNorvale Pharma,Sweden,Pharma,norvale.example,rep@leadstrategus.com\n" \
           "Halden Medical,Germany,Devices,,Nobody Known\nNorvale Pharma Ltd,Sweden,,,\n,Spain,,,\nCastell,,,,\n"
PROSPECTS = "First Name;Last Name;Email;Company;Lead Status;Next Step;Due Date\n" \
            "Elin;Berg;elin@norvale.example;Norvale Pharma;engaged;Call prospect;15/11/2026\n" \
            "Jonas;Weber;jonas@halden.example;Brand New Co;New;;\n" \
            "Elin;Duplicate;ELIN@norvale.example;Norvale Pharma;New;Call prospect;15/11/2026\n" \
            "Mia;Fox;mia@x.example;;Excited;;\n"
DEALS = "Deal Name,Company,Deal Stage,Amount,Currency,Close Date,Deal Owner,Contact,Risk\n" \
        "\"Norvale · LinkedIn\",Norvale Pharma,qualified,\"$24,000\",USD,2026-12-31,rep@leadstrategus.com,elin@norvale.example,Low\n" \
        "Norvale · LinkedIn,Norvale Pharma,Qualified,1000,USD,,,,\n" \
        "Halden expansion,Halden Medical,Closed won,18000,EUR,2026-09-30,,,\n" \
        "Mystery,Unknown Ltd,Lead identified,5000,USD,,,,\n" \
        "Bad stage,Norvale Pharma,Signed,1,USD,,,,\n"


def run(client, entity, text, mapping=None, as_=MANAGER, **options):
    a = client.post("/api/import/csv/analyze", {"entity": entity, "text": text}, as_=as_)
    assert a.status_code == 200, a.text
    body = {"entity": entity, "text": text, "mapping": mapping or a.json()["mapping"], "options": options, "file_name": f"{entity}.csv"}
    plan = client.post("/api/import/csv/plan", body, as_=as_)
    assert plan.status_code == 200, plan.text
    commit = client.post("/api/import/csv/commit", body, as_=as_)
    assert commit.status_code == 200, commit.text
    return a.json(), plan.json(), commit.json()


def test_parsers():
    assert str(csvimport.parse_date("15/11/2026", True)) == "2026-11-15"
    assert str(csvimport.parse_date("11/15/2026", False)) == "2026-11-15"
    assert str(csvimport.parse_money("€12.500,50")) == "12500.50"
    assert csvimport.match_choice("negotiation", csvimport.domain.STAGE_NAMES) == "Negotiation"
    headers, rows = csvimport.read_csv("﻿A;B\n1;2\n\n3;4\n")
    assert headers == ["A", "B"] and len(rows) == 2


def test_full_flow(client):
    assert client.post("/api/import/csv/analyze", {"entity": "accounts", "text": ACCOUNTS}, as_=REP).status_code == 403

    a, plan, res = run(client, "accounts", ACCOUNTS)
    assert a["mapping"]["name"] == "Company Name" and a["mapping"]["owner"] == "Account Owner" and a["row_count"] == 5
    statuses = [r["status"] for r in plan["rows"]]
    assert statuses == ["ready", "ready", "duplicate", "error", "error"]  # same name key, no name, no country
    assert any("“Nobody Known” isn’t a CRM user" in m for m in plan["rows"][1]["messages"])
    assert res["created"] == 2
    accounts = {x["name"]: x for x in client.get("/api/accounts", as_=MANAGER).json()}
    assert accounts["Norvale Pharma"]["owner_name"] == "rep" and accounts["Norvale Pharma"]["status"] == "Target"

    a, plan, res = run(client, "prospects", PROSPECTS, default_country="United Kingdom")
    assert a["mapping"]["first_name"] == "First Name" and a["mapping"]["account"] == "Company"
    rows = plan["rows"]
    assert [r["status"] for r in rows] == ["ready", "cleanup", "duplicate", "error"]
    assert any("New account “Brand New Co”" in m for m in rows[1]["messages"]), rows
    assert plan["summary"]["new_accounts"] == 1 and res["created"] == 2 and res["accounts_created"] == 1
    prospects = {p["full_name"]: p for p in client.get("/api/prospects", params={"scope": "all"}, as_=MANAGER).json()}
    elin = prospects["Elin Berg"]
    assert (elin["status"], elin["next_action_code"], elin["next_action_due"]) == ("Engaged", "01", "2026-11-15")
    assert prospects["Jonas Weber"]["next_action_other"] == csvimport.REVIEW_OTHER
    cleanup = {c["name"] for c in client.get("/api/import/cleanup", params={"scope": "all"}, as_=MANAGER).json()}
    assert "Jonas Weber" in cleanup

    a, plan, res = run(client, "opportunities", DEALS, create_missing_accounts=False)
    # Won still needs a risk rating (CRM rule from Qualified on): imported, flagged for cleanup.
    assert [r["status"] for r in plan["rows"]] == ["cleanup", "duplicate", "cleanup", "error", "error"]
    assert "Signed" in plan["rows"][4]["messages"][0]
    assert res["created"] == 2
    opps = {o["name"]: o for o in client.get("/api/opportunities", params={"include_nurtured": True}, as_=MANAGER).json()}
    li = opps["Norvale · LinkedIn"]
    assert (li["stage"], float(li["estimated_value"]), li["risk_rating"], li["primary_contact_id"]) == ("Qualified", 24000.0, "Low", elin["id"])
    won = opps["Halden expansion"]
    assert (won["stage"], won["currency"], float(won["actual_value"]), won["won_date"]) == ("Won", "EUR", 18000.0, "2026-09-30")

    # The import is on record, apart from HubSpot runs.
    assert client.get("/api/import/hubspot/status", as_=ADMIN).json()["last_run"] is None


def test_mapping_checks(client):
    body = {"entity": "opportunities", "text": DEALS, "mapping": {"name": "Deal Name"}}
    r = client.post("/api/import/csv/plan", body, as_=MANAGER)
    assert r.status_code == 422 and "Account" in r.text
    body["mapping"] = {"name": "Nope", "account": "Company"}
    assert "aren’t in the file" in client.post("/api/import/csv/plan", body, as_=MANAGER).text


def test_stage_names_from_other_crms_and_user_choices(client):
    client.post("/api/accounts", {"name": "Kestrel Analytics", "country": "United States"}, as_=MANAGER)
    text = "Deal Name,Company,Deal Stage,Deal Owner\nA,Kestrel Analytics,Contract sent,rep\nB,Kestrel Analytics,Signed off,\nC,Kestrel Analytics,Signed off,\n"
    a = client.post("/api/import/csv/analyze", {"entity": "opportunities", "text": text}, as_=MANAGER).json()
    body = {"entity": "opportunities", "text": text, "mapping": a["mapping"]}
    plan = client.post("/api/import/csv/plan", body, as_=MANAGER).json()
    assert plan["rows"][0]["status"] != "error"  # HubSpot's "Contract sent" → Verbal commitment
    assert plan["unknown_stages"] == [{"value": "Signed off", "rows": 2}]
    body["options"] = {"stage_map": {"Signed off": "Negotiation"}}
    res = client.post("/api/import/csv/commit", body, as_=MANAGER).json()
    assert res["created"] == 3 and res["message"].startswith("Imported 3 deals")
    stages = {o["name"]: (o["stage"], o["owner_name"]) for o in client.get("/api/opportunities", as_=MANAGER).json()}
    assert stages["A"] == ("Verbal commitment", "rep") and stages["B"][0] == "Negotiation"
