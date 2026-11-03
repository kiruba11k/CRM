"""Going-quiet alerts, quarterly targets and the daily digest email."""
import asyncio
from datetime import date, datetime, timezone

import asyncpg

from app import digest, domain, quotas
from tests.conftest import ADMIN, MANAGER, RAW_DB, REP, REP2
from tests.test_api import make_account, make_opp


def sql(query, *args):
    async def go():
        con = await asyncpg.connect(RAW_DB)
        try:
            return await con.execute(query, *args)
        finally:
            await con.close()
    return asyncio.run(go())


def age(opp_id, days):
    """Make every trace of an opportunity `days` old."""
    for q in ("UPDATE opportunities SET created_at = now() - make_interval(days => $2) WHERE id = $1",
              "UPDATE activities SET occurred_at = now() - make_interval(days => $2) WHERE entity_id = $1",
              "UPDATE record_history SET changed_at = now() - make_interval(days => $2) WHERE entity_id = $1"):
        sql(q, opp_id, days)


def test_period_helpers():
    assert quotas.period_of(date(2026, 11, 3)) == "2026-Q4"
    assert quotas.bounds("2026-Q4") == (date(2026, 10, 1), date(2026, 12, 31))
    assert quotas.bounds("2027-Q1") == (date(2027, 1, 1), date(2027, 3, 31))
    assert quotas.shift("2026-Q4", 1) == "2027-Q1" and quotas.shift("2027-Q1", -1) == "2026-Q4"


def test_stale_alerts(client):
    import uuid
    acc = make_account(client)
    quiet = make_opp(client, acc["id"], name="Quiet one", next_action_due="2026-12-20")
    late = make_opp(client, acc["id"], name="Late close", expected_close="2026-10-01", next_action_due="2026-12-20")
    slip = make_opp(client, acc["id"], name="Slipping", expected_close="2026-12-01", next_action_due="2026-12-20")
    for d in ("2026-12-15", "2027-01-10"):
        assert client.patch(f"/api/opportunities/{slip['id']}", {"expected_close": d}).status_code == 200
    fresh = make_opp(client, acc["id"], name="Fresh", next_action_due="2026-12-20")
    other = make_opp(client, acc["id"], as_=REP2, name="Rep2 quiet", next_action_due="2026-12-20")
    for o in (quiet, other):
        age(uuid.UUID(o["id"]), 30)

    mine = client.get("/api/alerts/stale").json()
    by = {i["name"]: {r["code"] for r in i["reasons"]} for i in mine["items"]}
    assert by == {"Quiet one": {"quiet"}, "Late close": {"overdue"}, "Slipping": {"slipping"}}
    assert "Fresh" not in by and mine["stale_days"] == 14
    assert next(i for i in mine["items"] if i["name"] == "Quiet one")["days_quiet"] >= 30
    team = client.get("/api/alerts/stale", params={"scope": "team"}, as_=MANAGER).json()
    assert "Rep2 quiet" in {i["name"] for i in team["items"]}

    # A higher threshold stops flagging it.
    client.put("/api/settings/reminders", {"stale_days": 45}, as_=ADMIN)
    assert "Quiet one" not in {i["name"] for i in client.get("/api/alerts/stale").json()["items"]}
    assert client.put("/api/settings/reminders", {"stale_days": 1}, as_=ADMIN).status_code == 422
    assert fresh["id"]


def test_quotas(client):
    acc = make_account(client)
    rep = client.ids[REP]
    body = {"period": "2026-Q4", "user_id": rep, "currency": "USD", "amount": 50000}
    assert client.put("/api/quotas", body, as_=REP).status_code == 403
    assert client.put("/api/quotas", {**body, "currency": "XYZ"}, as_=MANAGER).status_code == 422
    assert client.put("/api/quotas", {**body, "period": "2026-Q5"}, as_=MANAGER).status_code == 422
    r = client.put("/api/quotas", body, as_=MANAGER)
    assert r.status_code == 200, r.text

    won = make_opp(client, acc["id"], name="Won deal", stage="Negotiation", estimated_value=21000, risk_rating="Low", expected_close="2026-11-15")
    assert client.patch(f"/api/opportunities/{won['id']}", {"stage": "Won", "actual_value": 20000, "won_date": "2026-10-20"}).status_code == 200
    make_opp(client, acc["id"], name="Open deal", stage="Negotiation", estimated_value=10000, risk_rating="Low", expected_close="2026-12-10")
    make_opp(client, acc["id"], name="Next year", stage="Negotiation", estimated_value=99000, risk_rating="Low", expected_close="2027-02-10")
    make_opp(client, acc["id"], name="Euro", stage="Negotiation", estimated_value=5000, currency="EUR", risk_rating="Low", expected_close="2026-12-10")

    q = client.get("/api/quotas", params={"period": "2026-Q4"}).json()
    assert q["previous"] == "2026-Q3" and q["next"] == "2027-Q1" and q["can_edit"] is False
    row = next(r for r in q["rows"] if r["user_id"] == rep)
    usd = next(x for x in row["by_currency"] if x["currency"] == "USD")
    prob = domain.STAGE_PROBABILITY["Negotiation"]
    assert float(usd["target"]) == 50000 and float(usd["won"]) == 20000 and usd["attainment"] == 40.0
    assert float(usd["pipeline"]) == 10000 and float(usd["weighted"]) == 10000 * prob / 100
    assert usd["projected"] == round((20000 + 10000 * prob / 100) / 50000 * 100, 1) and float(usd["gap"]) == 30000
    eur = next(x for x in row["by_currency"] if x["currency"] == "EUR")
    assert eur["target"] is None and eur["attainment"] is None  # never mixed into USD
    assert float(q["team"]["target"]["USD"]) == 50000
    assert {r["name"] for r in q["rows"]} >= {"rep", "rep2"}  # salespeople show even without targets

    assert client.put("/api/quotas", {**body, "amount": None}, as_=MANAGER).status_code == 200
    row = next(r for r in client.get("/api/quotas", params={"period": "2026-Q4"}).json()["rows"] if r["user_id"] == rep)
    assert "USD" not in row["target"]
    log = client.get("/api/settings/changes", as_=ADMIN).json()
    assert any("target" in c["summary"] for c in (log if isinstance(log, list) else log.get("items", [])))


class FakeMailer:
    configured = True

    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    async def send(self, to, subject, html, text):
        if self.fail:
            from app.mailer import MailError
            raise MailError("SMTP said no")
        self.sent.append({"to": to, "subject": subject, "html": html, "text": text})


def run_digest(mailer, now, force=False):
    async def go():
        con = await asyncpg.connect(RAW_DB)
        try:
            return await digest.run(con, mailer, "https://crm.example", now=now, force=force)
        finally:
            await con.close()
    return asyncio.run(go())


def test_digest(client):
    acc = make_account(client)
    make_opp(client, acc["id"], name="Overdue thing", next_action_due="2026-10-01")
    make_opp(client, acc["id"], as_=REP2, name="Later thing", next_action_due="2027-06-01")
    app = client.c.app

    # Preview works without email being set up; sending a test needs it.
    app.state.mailer = None
    from app.config import get_settings
    get_settings().smtp_host = ""
    p = client.get("/api/digest/preview").json()
    assert p["worth_sending"] and "Overdue thing" in p["html"] and "1 overdue" in p["subject"]
    assert client.post("/api/digest/test", {}).status_code == 422
    assert client.get("/api/digest/me").json()["configured"] is False

    client.put("/api/settings/reminders", {"digest_hour": 8, "digest_time_zone": "Europe/London", "digest_weekdays_only": True}, as_=ADMIN)
    assert client.put("/api/settings/reminders", {"digest_time_zone": "Mars/Base"}, as_=ADMIN).status_code == 422
    fake = FakeMailer()
    tue_early = datetime(2026, 11, 3, 7, 30, tzinfo=timezone.utc)
    tue = datetime(2026, 11, 3, 9, 0, tzinfo=timezone.utc)
    sat = datetime(2026, 11, 7, 9, 0, tzinfo=timezone.utc)
    assert run_digest(fake, tue_early)["status"] == "too_early"
    assert run_digest(fake, sat)["status"] == "weekend"
    assert client.patch("/api/digest/me", {"enabled": False}, as_=ADMIN).json()["enabled"] is False

    res = run_digest(fake, tue)
    to = {m["to"] for m in fake.sent}
    assert REP in to and MANAGER in to and ADMIN not in to and REP2 not in to  # rep2 has nothing due today
    assert res["sent"] == 2 and res["skipped"] == 1
    rep_mail = next(m for m in fake.sent if m["to"] == REP)
    assert "Overdue thing" in rep_mail["text"] and "https://crm.example/opportunities/" in rep_mail["html"]
    mgr = next(m for m in fake.sent if m["to"] == MANAGER)
    assert "TEAM" in mgr["text"] and "rep: 1 overdue" in mgr["text"]
    again = run_digest(fake, tue)
    assert again["sent"] == 0 and again["already"] == 3  # once a day

    # A failed send is retried on the next run, at most 3 attempts.
    wed = datetime(2026, 11, 4, 9, 0, tzinfo=timezone.utc)
    bad = FakeMailer(fail=True)
    assert run_digest(bad, wed)["failed"] == 2
    assert run_digest(bad, wed)["failed"] == 2
    assert run_digest(bad, wed)["failed"] == 2
    assert run_digest(bad, wed)["failed"] == 0
    assert client.get("/api/digest/me").json()["last"]["status"] == "failed"

    # Admin "send now" and the cron secret.
    assert client.post("/api/digest/run", {}, as_=REP).status_code == 403
    assert client.post("/api/digest/cron", {}).status_code == 403
    get_settings().cron_secret = "s3cret"
    try:
        r = client.c.post("/api/digest/cron", headers={"X-Cron-Secret": "wrong"})
        assert r.status_code == 403
        app.state.mailer = FakeMailer()
        r = client.c.post("/api/digest/cron", headers={"X-Cron-Secret": "s3cret"})
        assert r.status_code == 200 and r.json()["status"] in {"done", "too_early", "weekend"}
    finally:
        get_settings().cron_secret = ""
        app.state.mailer = None
