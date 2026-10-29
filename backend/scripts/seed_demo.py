"""
Load sample data into a LOCAL dev CRM through the API (needs CRM_DEV_AUTH=true).

    python scripts/seed_demo.py http://localhost:8100

Goes through the normal endpoints, so every record passes the same
validation as the UI. Do not run against production.
"""
import sys
from datetime import date, timedelta

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8100").rstrip("/") + "/api"
YOU, MEERA, ARJUN = "you@leadstrategus.com", "meera@leadstrategus.com", "arjun@leadstrategus.com"
T = date.today()


def d(days: int) -> str:
    return (T + timedelta(days=days)).isoformat()


def call(method, path, as_=YOU, **body):
    r = httpx.request(method, BASE + path, json=body or None, headers={"X-Dev-User": as_}, timeout=30)
    if r.status_code >= 400:
        raise SystemExit(f"{method} {path} failed {r.status_code}: {r.text}")
    return r.json()


def main():
    ids = {e: call("GET", "/me", as_=e)["id"] for e in (YOU, MEERA, ARJUN)}
    call("PATCH", f"/users/{ids[MEERA]}", role="manager")
    acc = {}
    for name, country, industry, owner, status in [
        ("Norvale Pharma", "Sweden", "Pharma", YOU, "Active customer"),
        ("Atlas Fleet Systems", "United States", "Logistics", MEERA, "Active customer"),
        ("Vantor Energy", "UAE", "Energy", ARJUN, "Target"),
        ("Halden Medical Devices", "United Kingdom", "Medtech", YOU, "Target"),
        ("Oriel Packaging", "Italy", "Packaging", MEERA, "Active customer"),
        ("Kestrel Analytics", "Germany", "Software", YOU, "Target"),
        ("Brightline Foods", "UAE", "Food & beverage", YOU, "Target"),
    ]:
        acc[name] = call("POST", "/accounts", as_=owner, name=name, country=country, industry=industry, status=status, owner_id=ids[owner])["id"]

    def prospect(name, account, owner, status, code, due, **kw):
        return call("POST", "/prospects", as_=owner, full_name=name, account_id=acc.get(account), owner_id=ids[owner],
                    status=status, next_action_code=code, next_action_due=due, **kw)["id"]

    sofia = prospect("Sofia Lind", "Norvale Pharma", YOU, "Engaged", "06", d(1), email="sofia.lind@norvale.example", job_title="Head of Marketing", source="Referral")
    prospect("Priya Raman", "Halden Medical Devices", YOU, "Engaged", "02", d(0), email="priya@halden.example", job_title="VP Sales", source="Inbound")
    prospect("Aisha Rahman", None, YOU, "New", "14", d(-2), email="aisha@gulfmed.example", source="Event / tradeshow")
    prospect("Jae Park", "Vantor Energy", ARJUN, "Contacted", "04", d(-1), email="jae@vantor.example", source="Outbound")
    prospect("Ines Duarte", "Oriel Packaging", MEERA, "Contacted", "18", d(-6), next_action_other="Send interpack recap deck", email="ines@oriel.example")

    norvale = call("POST", f"/prospects/{sofia}/convert", name="Norvale · LinkedIn lead generation programme",
                   estimated_value=42000, risk_rating="Medium", next_action_code="08", next_action_due=d(1))["id"]
    call("PATCH", f"/opportunities/{norvale}", stage="Proposal submitted", expected_close=d(16), proposal_due=d(-11), service_line="LinkedIn lead generation")

    def opp(name, account, owner, **kw):
        return call("POST", "/opportunities", as_=owner, name=name, account_id=acc[account], owner_id=ids[owner], **kw)["id"]

    opp("Halden · LinkedIn lead generation", "Halden Medical Devices", YOU, currency="GBP", estimated_value=18000, next_action_code="05", next_action_due=d(0))
    opp("Vantor · GTM intelligence, GCC utilities", "Vantor Energy", ARJUN, stage="Qualified", estimated_value=24000, risk_rating="High",
        high_risk_reason="Budget not confirmed; new procurement head", risk_mitigation="Ask champion for intro to CFO",
        next_action_code="15", next_action_due=d(-2), service_line="GTM intelligence")
    opp("Oriel · Tradeshow pipeline (interpack)", "Oriel Packaging", MEERA, stage="Discovery / scoping", currency="EUR", estimated_value=15000,
        risk_rating="Low", next_action_code="06", next_action_due=d(1), service_line="Tradeshow pipeline")
    opp("Atlas · Tradeshow pipeline renewal", "Atlas Fleet Systems", MEERA, stage="Negotiation", estimated_value=27000, risk_rating="Low",
        expected_close=d(17), next_action_code="10", next_action_due=d(4), service_line="Tradeshow pipeline")
    opp("Kestrel · Thought leadership series", "Kestrel Analytics", YOU, stage="Verbal commitment", estimated_value=12000, risk_rating="Low",
        expected_close=d(9), next_action_code="11", next_action_due=d(5), service_line="Thought leadership")
    opp("Brightline · Tradeshow pipeline (Gulfood)", "Brightline Foods", YOU, stage="Proposal submitted", estimated_value=16000, risk_rating="Low",
        expected_close=d(120), proposal_due=d(-30), on_nurture=True, nurture_reason="Timing delayed", nurture_until=d(78), nurture_next_action_code="17")
    won = opp("Norvale · Nordics outbound", "Norvale Pharma", YOU, stage="Negotiation", estimated_value=14000, risk_rating="Low", expected_close=d(-5),
              next_action_code="10", next_action_due=d(1), service_line="GTM intelligence")
    call("PATCH", f"/opportunities/{won}", stage="Won", actual_value=14500, won_date=d(-3))
    print(f"Seeded {len(acc)} accounts, 5 prospects, 8 opportunities. Sign in as {YOU} (admin if in CRM_ADMIN_EMAILS).")


if __name__ == "__main__":
    main()
