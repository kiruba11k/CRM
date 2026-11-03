"""Reading changes back from Google Tasks."""
from tests.conftest import REP
from tests.test_calendar import connect, make_opp
from tests.test_tasks import google, turn_on, wait_synced  # noqa: F401  (fixture)


def task(fake):
    (t,) = fake.only_list()["tasks"].values()
    return t


def pull(client):
    r = client.post("/api/tasks/pull?force=true", {})
    assert r.status_code == 200, r.text
    return r.json()


def test_two_way(client, google):
    opp = make_opp(client)
    connect(client, google, REP)
    turn_on(client, google, REP)
    wait_synced(client, REP, 1)
    path = f"/api/opportunities/{opp['id']}"

    # Nothing changed in Google: nothing happens (our own pushes aren't echoes).
    assert pull(client) == {"status": "ok", "done": 0, "rescheduled": 0, "removed": 0}
    assert client.post("/api/tasks/pull", {}).json()["status"] == "recent"          # throttled without force

    # Re-dated in Google -> the CRM's next action moves, with history.
    task(google)["due"] = "2030-01-20T00:00:00.000Z"
    assert pull(client)["rescheduled"] == 1
    rec = client.get(path).json()
    assert rec["next_action_due"] == "2030-01-20"
    assert any(h["field"] == "next_action_due" and h["new_value"] == "2030-01-20" for h in rec["history"])
    assert any("Rescheduled in Google Tasks" in a["summary"] for a in rec["activities"])
    assert pull(client)["rescheduled"] == 0                                       # no echo

    # Ticked off in Google -> flagged; the CRM asks for the next action.
    task(google)["status"] = "completed"
    assert pull(client)["done"] == 1
    acts = client.get("/api/actions", params={"as_of": "2030-01-01"}).json()
    assert [i["id"] for i in acts["done_in_google"]] == [opp["id"]] and acts["counts"]["upcoming"] == 0
    assert pull(client)["done"] == 0                                              # once
    # Completing it in the CRM with a new next action makes a fresh task.
    r = client.post(f"{path}/complete-action", {"next_action_code": "03", "next_action_due": "2030-02-01"})
    assert r.status_code == 200, r.text
    acts = client.get("/api/actions", params={"as_of": "2030-01-01"}).json()
    assert acts["done_in_google"] == [] and acts["counts"]["upcoming"] == 1
    tasks = google.only_list()["tasks"]
    open_ = [t for t in tasks.values() if t["status"] == "needsAction"]
    assert len(open_) == 1 and open_[0]["due"].startswith("2030-02-01")

    # Deleted in Google -> no longer synced; it comes back when the action changes.
    open_[0]["deleted"] = True
    assert pull(client)["removed"] == 1
    assert client.get(path).json()["task"] is None
    client.patch(path, {"next_action_due": "2030-02-05"})
    wait_synced(client, REP, 1)
    assert client.get(path).json()["task"]["due"] == "2030-02-05"


def test_unticked_in_google_clears_flag(client, google):
    make_opp(client)
    connect(client, google, REP)
    turn_on(client, google, REP)
    wait_synced(client, REP, 1)
    task(google)["status"] = "completed"
    pull(client)
    task(google)["status"] = "needsAction"
    pull(client)
    assert client.get("/api/actions", params={"as_of": "2030-01-01"}).json()["done_in_google"] == []
