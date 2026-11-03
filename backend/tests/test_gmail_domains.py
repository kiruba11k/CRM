"""Gmail auto-logging by company domain."""
from app import emaildomains
from tests.conftest import REP
from tests.test_calendar import connect
from tests.test_gmail_autolog import emails, gmail, setup_records, turn_on, wait_first_sync  # noqa: F401  (fixture)


def test_domain_helpers():
    assert emaildomains.clean_list("@Norvale.se, norvale-group.com ;gmail.com, bad, https://www.x-y.io/path") == "norvale.se, norvale-group.com, x-y.io"
    amap = {"norvale.com": "A"}
    assert emaildomains.match("anna@norvale.com", amap) == "A"
    assert emaildomains.match("anna@eu.mail.norvale.com", amap) == "A"
    assert emaildomains.match("anna@norvale.com.evil.io", amap) is None
    assert emaildomains.match("anna@gmail.com", {"gmail.com": "X"}) is None


def test_logs_on_account_by_domain(client, gmail):
    acc, elin, opp = setup_records(client)                      # Norvale Pharma, prospect elin@norvale.example
    assert client.patch(f"/api/accounts/{acc['id']}", {"website": "https://www.norvale.example", "email_domains": "@Norvale-Group.COM, gmail.com"}).status_code == 200
    assert client.get(f"/api/accounts/{acc['id']}").json()["email_domains"] == "norvale-group.com"
    other = client.post("/api/accounts", {"name": "Other Co", "country": "Sweden", "website": "other.example"}).json()
    g = gmail
    g.add(REP, "rep@leadstrategus.com", "Anna Holm <anna@norvale.example>", "Pricing", labels=("SENT",))
    g.add(REP, "Bo <bo@mail.norvale-group.com>", "rep@leadstrategus.com", "Re: Pricing")
    g.add(REP, "rep@leadstrategus.com", "elin@norvale.example, anna@norvale.example", "Both", labels=("SENT",))   # Elin is a prospect
    g.add(REP, "someone@gmail.com", "rep@leadstrategus.com", "Free mail")
    g.add(REP, "x@other.example", "rep@leadstrategus.com", "Other company")

    connect(client, g, REP)
    turn_on(client, g, REP)
    wait_first_sync(client, REP)

    acc_mail = [a["summary"] for a in client.get(f"/api/accounts/{acc['id']}").json()["activities"] if a["kind"] == "email"]
    # Account timeline also shows Elin's (prospect) emails; domain-only ones are logged on the account itself.
    assert "Email sent to anna@norvale.example: Pricing" in acc_mail
    assert "Email from bo@mail.norvale-group.com: Re: Pricing" in acc_mail
    assert "Email sent to Elin Berg: Both" in acc_mail and not any(s.startswith("Email sent to anna@norvale.example: Both") for s in acc_mail)
    assert not any("Free mail" in s for s in acc_mail)
    assert [a["summary"] for a in emails(client, f"/api/accounts/{other['id']}")] == ["Email from x@other.example: Other company"]

    sugg = client.get(f"/api/accounts/{acc['id']}/email-contacts").json()
    assert {s["email"] for s in sugg} == {"anna@norvale.example", "bo@mail.norvale-group.com"}
    # Once Anna is a prospect she stops being suggested.
    client.post("/api/prospects", {"full_name": "Anna Holm", "email": "anna@norvale.example", "account_id": acc["id"],
                                   "next_action_code": "05", "next_action_due": "2030-01-01"})
    assert {s["email"] for s in client.get(f"/api/accounts/{acc['id']}/email-contacts").json()} == {"bo@mail.norvale-group.com"}

    # Company-level email counts as activity for the company's open deals.
    stale = client.get("/api/alerts/stale", params={"scope": "team"}).json()["items"]
    assert opp["id"] not in {d["id"] for d in stale}
