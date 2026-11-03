"""Slack notifications via incoming webhooks (fake Slack)."""
import json
import time
from datetime import date

import httpx
import pytest

from tests.conftest import ADMIN, MANAGER, REP
from tests.test_api import make_account, make_opp

HOOK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX"


class FakeSlack:
    def __init__(self):
        self.posts: list[dict] = []
        self.fail = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == HOOK
        if self.fail:
            return httpx.Response(404, text="no_service")
        self.posts.append(json.loads(request.content))
        return httpx.Response(200, text="ok")


@pytest.fixture()
def slack(app, client):
    fake = FakeSlack()
    app.state.slack_transport = httpx.MockTransport(fake.handler)
    yield fake
    app.state.slack_transport = None


def wait_posts(fake, n):
    for _ in range(100):
        if len(fake.posts) >= n:
            return fake.posts
        time.sleep(0.03)
    raise AssertionError(fake.posts)


def test_channels_and_deal_events(client, slack):
    body = {"name": "#sales-wins", "webhook_url": HOOK}
    assert client.post("/api/slack", body, as_=MANAGER).status_code == 403
    assert client.post("/api/slack", {**body, "webhook_url": "https://evil.example/hook"}, as_=ADMIN).status_code == 422
    v = client.post("/api/slack", body, as_=ADMIN).json()
    ch = v["channels"][0]
    assert ch["events"] == ["deal_won", "deal_lost", "daily_summary"] and ch["webhook_hint"] == "…XXXXXX"
    assert "webhook" not in json.dumps(v["channels"]).replace("webhook_hint", "")          # never sent back
    assert client.post(f"/api/slack/{ch['id']}/test", {}, as_=ADMIN).status_code == 200
    assert "Test from LeadStrategus CRM" in slack.posts[0]["text"]

    acc = make_account(client)
    opp = make_opp(client, acc["id"], stage="Negotiation", estimated_value=27000, risk_rating="Low", expected_close="2030-01-01")
    time.sleep(0.2)
    assert len(slack.posts) == 1                     # deal_created is off by default
    client.patch(f"/api/opportunities/{opp['id']}", {"stage": "Won", "actual_value": 26500, "won_date": "2026-10-29"})
    won = wait_posts(slack, 2)[-1]["text"]
    assert ":tada:" in won and "$26,500" in won and "/opportunities/" in won and "Norvale" in won

    # Turn on new deals and stage moves.
    client.patch(f"/api/slack/{ch['id']}", {"events": ["deal_created", "stage_changed", "deal_lost"]}, as_=ADMIN)
    o2 = make_opp(client, acc["id"], name="Second deal")
    assert "New deal" in wait_posts(slack, 3)[-1]["text"]
    client.patch(f"/api/opportunities/{o2['id']}", {"next_action_due": "2030-02-01"})          # not a stage change
    time.sleep(0.2)
    assert len(slack.posts) == 3

    # Failures are logged, never break the save.
    slack.fail = True
    r = client.patch(f"/api/opportunities/{o2['id']}", {"stage": "Lost", "lost_reason": "Budget", "lost_date": "2026-10-30"})
    assert r.status_code == 200
    for _ in range(100):
        log = client.get("/api/slack", as_=ADMIN).json()
        if log["channels"][0]["last_error"]:
            break
        time.sleep(0.03)
    assert "404" in log["channels"][0]["last_error"] and log["log"][0]["ok"] is False
    assert client.post(f"/api/slack/{ch['id']}/test", {}, as_=ADMIN).status_code == 502


def test_daily_summary(client, slack):
    v = client.post("/api/slack", {"name": "#sales", "webhook_url": HOOK, "events": ["daily_summary"]}, as_=ADMIN).json()
    acc = make_account(client)
    make_opp(client, acc["id"], name="Late one", next_action_due="2020-01-01")
    r = client.post("/api/slack/summary-now", {}, as_=ADMIN).json()
    assert r["sent"] == 1
    text = slack.posts[-1]["text"]
    assert "CRM summary" in text and "1 overdue next action" in text and "rep 1" in text
    # Once a day per channel from the scheduled job.
    import asyncio
    import asyncpg
    from app import slack as slack_mod
    from tests.conftest import RAW_DB

    async def go():
        pool = await asyncpg.create_pool(RAW_DB)
        try:
            async with pool.acquire() as con:
                await con.execute("UPDATE slack_channels SET last_daily_date = NULL")
                a = await slack_mod.daily_summary(con, pool, "test-token-key", "https://crm.example", date(2026, 11, 3), transport=httpx.MockTransport(slack.handler))
                b = await slack_mod.daily_summary(con, pool, "test-token-key", "https://crm.example", date(2026, 11, 3), transport=httpx.MockTransport(slack.handler))
                return a, b
        finally:
            await pool.close()
    assert asyncio.run(go()) == (1, 0)
    assert v["channels"][0]["name"] == "#sales"
