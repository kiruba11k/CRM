"""§6.3 one-way CRM → Google Tasks, against a fake Google."""
import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app import tasksync
from tests.conftest import MANAGER, REP, REP2
from tests.test_calendar import FakeGoogle, connect, make_opp

TASKS = "https://www.googleapis.com/auth/tasks"


class FakeGoogleTasks(FakeGoogle):
    def __init__(self):
        super().__init__()
        self.grant_tasks: set[str] = set()
        self.lists: dict[str, dict] = {}
        self.task_calls: list[tuple[str, str]] = []
        self.lose_task_reply = 0
        self._n = 0

    def _id(self, prefix):
        self._n += 1
        return f"{prefix}{self._n}"

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.host == "tasks.googleapis.com":
            return self._tasks(request)
        resp = super().handler(request)
        if url.path == "/token" and b"authorization_code" in request.content:
            body = resp.json()
            if self.codes[parse_qs(request.content.decode())["code"][0]] in self.grant_tasks:
                body["scope"] += " " + TASKS
            return httpx.Response(resp.status_code, json=body)
        return resp

    def _tasks(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.split("/")  # '', tasks, v1, ...
        self.task_calls.append((request.method, request.url.path))
        body = json.loads(request.content) if request.content else {}
        if parts[3:5] == ["users", "@me"]:
            if request.method == "POST":
                lid = self._id("L")
                self.lists[lid] = {"title": body["title"], "tasks": {}}
                return httpx.Response(200, json={"id": lid, "title": body["title"]})
            self.lists.pop(parts[6], None)
            return httpx.Response(204)
        lid = parts[4]
        if lid not in self.lists:
            return httpx.Response(404, json={"error": {"message": "Task list not found"}})
        tasks = self.lists[lid]["tasks"]
        tid = parts[6] if len(parts) > 6 else None
        if request.method == "GET":
            return httpx.Response(200, json={"items": list(tasks.values())})
        if request.method == "POST":
            tid = self._id("T")
            tasks[tid] = {"id": tid, "status": "needsAction", **body}
            if self.lose_task_reply:
                self.lose_task_reply -= 1
                return httpx.Response(503, json={"error": {"message": "Backend Error"}})
            return httpx.Response(200, json=tasks[tid])
        if tid not in tasks:
            return httpx.Response(404, json={"error": {"message": "Not Found"}})
        if request.method == "PATCH":
            tasks[tid].update(body)
            return httpx.Response(200, json=tasks[tid])
        del tasks[tid]
        return httpx.Response(204)

    def only_list(self) -> dict:
        assert len(self.lists) == 1
        return next(iter(self.lists.values()))


@pytest.fixture()
def google(app, client):
    fake = FakeGoogleTasks()
    app.state.google_transport = httpx.MockTransport(fake.handler)
    app.state.google = None
    yield fake
    app.state.google_transport = None
    app.state.google = None


def turn_on(client, fake, email):
    """Calendar connected without Tasks → enable asks Google for Tasks too."""
    fake.grant_tasks.add(email)
    url = client.post("/api/tasks/enable", {}, as_=email).json()["url"]
    q = parse_qs(urlsplit(url).query)
    assert TASKS in q["scope"][0] and "calendar.events" in q["scope"][0]
    code = f"tasks-{email}"
    fake.codes[code] = email
    r = client.c.get("/api/calendar/oauth/callback", params={"state": q["state"][0], "code": code}, follow_redirects=False)
    assert "calendar=connected" in r.headers["location"]


def wait_synced(client, email, n):
    for _ in range(100):
        if client.get("/api/tasks/status", as_=email).json()["counts"].get("synced", 0) >= n:
            return
        time.sleep(0.05)
    raise AssertionError(client.get("/api/tasks/status", as_=email).json())


def task_of(client, path, as_=REP):
    return client.get(path, as_=as_).json()["task"]


def test_turning_on_mirrors_open_actions_one_way(client, google):
    opp = make_opp(client)
    connect(client, google, REP)
    assert client.get("/api/tasks/status", as_=REP).json()["enabled"] is False and not google.task_calls
    turn_on(client, google, REP)
    wait_synced(client, REP, 1)
    lst = google.only_list()
    assert lst["title"] == "LeadStrategus CRM"
    (task,) = lst["tasks"].values()
    assert task["title"] == "Norvale Pharma — Schedule meeting" and task["due"] == "2030-01-01T00:00:00.000Z"
    assert tasksync.FOOTER in task["notes"] and f"/opportunities/{opp['id']}" in task["notes"] and "[crm-task:" in task["notes"]
    assert task_of(client, f"/api/opportunities/{opp['id']}")["sync_status"] == "synced"
    # Already granted: enabling again needs no consent screen.
    assert client.post("/api/tasks/enable", {}, as_=REP).json() == {"enabled": True}


def test_task_follows_the_record(client, google):
    connect(client, google, REP)
    turn_on(client, google, REP)
    opp = make_opp(client)
    path = f"/api/opportunities/{opp['id']}"
    lst = google.only_list()
    (tid,) = lst["tasks"]
    client.patch(path, {"next_action_due": "2030-01-03"}, as_=REP)
    assert list(lst["tasks"]) == [tid] and lst["tasks"][tid]["due"] == "2030-01-03T00:00:00.000Z"

    client.post(f"{path}/complete-action", {"next_action_code": "07", "next_action_due": "2030-01-05"}, as_=REP)
    assert lst["tasks"][tid]["status"] == "completed"
    new = [t for t in lst["tasks"].values() if t["status"] == "needsAction"]
    assert [t["title"] for t in new] == ["Norvale Pharma — Prepare / send proposal"]

    client.patch(path, {"on_nurture": True, "nurture_reason": "Timing delayed", "nurture_until": "2030-03-01",
                        "nurture_next_action_code": "17"}, as_=REP)
    open_tasks = [t for t in lst["tasks"].values() if t["status"] == "needsAction"]
    assert [(t["title"], t["due"]) for t in open_tasks] == [("Norvale Pharma — Review nurtured opportunity", "2030-03-01T00:00:00.000Z")]

    client.post(f"{path}/revisit", {"outcome": "lost", "lost_reason": "Budget"}, as_=REP)
    assert all(t["status"] == "completed" for t in lst["tasks"].values())
    assert task_of(client, path) is None
    # One-way: the CRM never read tasks back.
    assert not [c for c in google.task_calls if c[0] == "GET"]


def test_retry_after_lost_reply_never_duplicates(client, google):
    connect(client, google, REP)
    turn_on(client, google, REP)
    google.lose_task_reply = 1
    opp = make_opp(client)
    t = task_of(client, f"/api/opportunities/{opp['id']}")
    assert t["sync_status"] == "failed" and "503" in t["sync_error"]
    r = client.post(f"/api/tasks/links/{t['id']}/retry", {}, as_=REP).json()
    assert r["sync_status"] == "synced" and len(google.only_list()["tasks"]) == 1


def test_owner_change_and_users_without_tasks(client, google):
    connect(client, google, REP)
    turn_on(client, google, REP)
    opp = make_opp(client)
    lst = google.only_list()
    client.patch(f"/api/opportunities/{opp['id']}", {"owner_id": client.ids[REP2]}, as_=MANAGER)
    assert lst["tasks"] == {} and task_of(client, f"/api/opportunities/{opp['id']}") is None  # REP2 hasn't turned Tasks on
    p = client.post("/api/prospects", {"full_name": "Sofia Lind", "next_action_code": "01", "next_action_due": "2030-01-02"}, as_=REP2).json()
    assert task_of(client, f"/api/prospects/{p['id']}", as_=REP2) is None


def test_turning_off_removes_the_list(client, google):
    connect(client, google, REP)
    turn_on(client, google, REP)
    opp = make_opp(client)
    assert client.post("/api/tasks/disable", {}, as_=REP).json() == {"enabled": False}
    assert google.lists == {} and task_of(client, f"/api/opportunities/{opp['id']}") is None
    assert client.get("/api/tasks/status", as_=REP).json()["enabled"] is False
    client.patch(f"/api/opportunities/{opp['id']}", {"next_action_due": "2030-02-02"}, as_=REP)
    assert google.lists == {}
