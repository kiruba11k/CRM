"""
backend/app/dedupe.py - find likely duplicate accounts and prospects, and
merge two records into one.

Finding is rule-based and explains itself:
  accounts   same website domain, same LinkedIn page, or near-identical names
  prospects  same LinkedIn, same phone, same name (stronger at the same company)
Pairs someone marked "not duplicates" are left out.

Merging keeps one record, copies the values the person chose from the other,
moves everything linked to the removed record onto the kept one (prospects,
deals, activity, meetings, linked emails, history, tasks), logs the merge with
a snapshot of the removed record, then deletes it.
"""
import json
import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any, Optional
from uuid import UUID

import asyncpg

from . import domain

FIELDS = {
    "account": ["name", "country", "region", "industry", "owner_id", "status", "website", "linkedin_url", "notes"],
    "prospect": ["full_name", "account_id", "job_title", "email", "phone", "linkedin_url", "owner_id", "status", "source", "notes", "next_action"],
}
NEXT_ACTION_COLS = ["next_action_code", "next_action_other", "next_action_due", "next_action_time", "next_action_in_calendar", "next_action_time_zone"]
TABLE = {"account": "accounts", "prospect": "prospects"}
NAME = {"account": "name", "prospect": "full_name"}


def _plain(s: Optional[str]) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split())


def domain_of(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    u = re.sub(r"^[a-z]+://", "", url.strip().lower())
    host = u.split("/")[0].split("?")[0]
    host = host[4:] if host.startswith("www.") else host
    return host if "." in host else None


def linkedin_of(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    m = re.search(r"linkedin\.com/(in|company)/([^/?#]+)", url.lower())
    return f"{m.group(1)}/{m.group(2)}" if m else None


def phone_of(p: Optional[str]) -> Optional[str]:
    digits = re.sub(r"\D", "", p or "")
    return digits[-9:] if len(digits) >= 7 else None


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _jsonable(v: Any) -> Any:
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, (UUID, Decimal)):
        return str(v)
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


# ── Finding ───────────────────────────────────────────────────────────

async def _dismissed(con: asyncpg.Connection, entity: str) -> set[tuple[UUID, UUID]]:
    return {(r["id_a"], r["id_b"]) for r in await con.fetch("SELECT id_a, id_b FROM duplicate_dismissals WHERE entity_type = $1", entity)}


def _pair(a: dict, b: dict) -> tuple[dict, dict]:
    return (a, b) if a["id"] < b["id"] else (b, a)


async def find_accounts(con: asyncpg.Connection) -> list[dict]:
    rows = [dict(r) for r in await con.fetch(
        "SELECT a.id, a.name, a.name_key, a.country, a.website, a.linkedin_url, a.status, a.industry, a.created_at, u.name AS owner_name, "
        "(SELECT count(*) FROM prospects p WHERE p.account_id = a.id) AS prospects, "
        "(SELECT count(*) FROM opportunities o WHERE o.account_id = a.id) AS deals "
        "FROM accounts a LEFT JOIN users u ON u.id = a.owner_id")]
    found: dict[tuple, dict] = {}

    def add(a: dict, b: dict, score: int, reason: str) -> None:
        a, b = _pair(a, b)
        k = (a["id"], b["id"])
        p = found.setdefault(k, {"a": a, "b": b, "score": 0, "reasons": []})
        p["score"] = max(p["score"], score)
        if reason not in p["reasons"]:
            p["reasons"].append(reason)

    for key_fn, score, label in ((lambda r: domain_of(r["website"]), 95, "Same website"),
                                 (lambda r: linkedin_of(r["linkedin_url"]), 95, "Same LinkedIn page")):
        groups: dict[str, list[dict]] = {}
        for r in rows:
            k = key_fn(r)
            if k:
                groups.setdefault(k, []).append(r)
        for g in groups.values():
            for i in range(len(g)):
                for j in range(i + 1, len(g)):
                    add(g[i], g[j], score, f"{label}: {key_fn(g[i])}")
    # Names: compare within a block (first 3 letters), so it stays fast.
    blocks: dict[str, list[dict]] = {}
    for r in rows:
        r["_k"] = r["name_key"].replace(" ", "")
        if len(r["_k"]) >= 3:
            blocks.setdefault(r["_k"][:3], []).append(r)
    for g in blocks.values():
        for i in range(len(g)):
            for j in range(i + 1, len(g)):
                x, y = g[i]["_k"], g[j]["_k"]
                short, long_ = sorted((x, y), key=len)
                if len(short) >= 5 and long_.startswith(short):
                    add(g[i], g[j], 85, "One name contains the other")
                else:
                    r = _ratio(x, y)
                    if r >= 0.88:
                        add(g[i], g[j], int(r * 90), "Very similar names")
    return await _finish(con, "account", found)


async def find_prospects(con: asyncpg.Connection) -> list[dict]:
    rows = [dict(r) for r in await con.fetch(
        "SELECT p.id, p.full_name, p.email, p.phone, p.linkedin_url, p.job_title, p.status, p.account_id, a.name AS account_name, "
        "p.created_at, u.name AS owner_name, (SELECT count(*) FROM opportunities o WHERE o.primary_contact_id = p.id) AS deals "
        "FROM prospects p LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN users u ON u.id = p.owner_id")]
    found: dict[tuple, dict] = {}

    def add(a: dict, b: dict, score: int, reason: str) -> None:
        a, b = _pair(a, b)
        p = found.setdefault((a["id"], b["id"]), {"a": a, "b": b, "score": 0, "reasons": []})
        p["score"] = max(p["score"], score)
        if reason not in p["reasons"]:
            p["reasons"].append(reason)

    for key_fn, score, label in ((lambda r: linkedin_of(r["linkedin_url"]), 98, "Same LinkedIn profile"),
                                 (lambda r: phone_of(r["phone"]), 90, "Same phone number")):
        groups: dict[str, list[dict]] = {}
        for r in rows:
            k = key_fn(r)
            if k:
                groups.setdefault(k, []).append(r)
        for g in groups.values():
            for i in range(len(g)):
                for j in range(i + 1, len(g)):
                    add(g[i], g[j], score, label)
    blocks: dict[str, list[dict]] = {}
    for r in rows:
        r["_n"] = _plain(r["full_name"])
        if len(r["_n"]) >= 3:
            blocks.setdefault(r["_n"].split(" ")[-1][:3], []).append(r)   # by surname
    for g in blocks.values():
        for i in range(len(g)):
            for j in range(i + 1, len(g)):
                a, b = g[i], g[j]
                same_co = a["account_id"] and a["account_id"] == b["account_id"]
                either_unlinked = not a["account_id"] or not b["account_id"]
                if a["_n"] == b["_n"]:
                    if same_co:
                        add(a, b, 92, "Same name at the same company")
                    elif either_unlinked:
                        add(a, b, 80, "Same name (one has no company)")
                    else:
                        add(a, b, 60, "Same name at different companies")
                elif (same_co or either_unlinked) and _ratio(a["_n"], b["_n"]) >= 0.9:
                    add(a, b, 75 if same_co else 65, "Very similar names" + (" at the same company" if same_co else ""))
    return await _finish(con, "prospect", found)


async def _finish(con: asyncpg.Connection, entity: str, found: dict) -> list[dict]:
    skip = await _dismissed(con, entity)
    out = []
    for (ia, ib), p in found.items():
        if (ia, ib) in skip:
            continue
        for side in ("a", "b"):
            for k in ("_k", "_n", "name_key"):
                p[side].pop(k, None)
        out.append(p)
    out.sort(key=lambda p: (-p["score"], str(p["a"].get("name") or p["a"].get("full_name"))))
    return out


async def dismiss(con: asyncpg.Connection, entity: str, a: UUID, b: UUID, user_id: UUID) -> None:
    a, b = sorted((a, b))
    await con.execute("INSERT INTO duplicate_dismissals(entity_type, id_a, id_b, dismissed_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                      entity, a, b, user_id)


# ── Merging ───────────────────────────────────────────────────────────

async def _move(con: asyncpg.Connection, entity: str, frm: UUID, to: UUID) -> dict[str, int]:
    """Re-point everything that hangs off `frm` (by entity_type/entity_id) to `to`."""
    n: dict[str, int] = {}

    async def run(key: str, sql: str) -> None:
        res = await con.execute(sql, entity, frm, to)
        n[key] = n.get(key, 0) + int(res.split()[-1])

    # Avoid unique clashes first: the same email thread / Gmail message logged on both.
    await con.execute("DELETE FROM email_threads e WHERE e.entity_type = $1 AND e.entity_id = $2 AND EXISTS "
                      "(SELECT 1 FROM email_threads k WHERE k.entity_type = $1 AND k.entity_id = $3 AND k.thread_ref = e.thread_ref)", entity, frm, to)
    await con.execute("DELETE FROM activities x WHERE x.entity_type = $1 AND x.entity_id = $2 AND x.gmail_message_id IS NOT NULL AND EXISTS "
                      "(SELECT 1 FROM activities k WHERE k.entity_type = $1 AND k.entity_id = $3 AND k.gmail_message_id = x.gmail_message_id)", entity, frm, to)
    await con.execute("UPDATE meetings SET follow_up_active = false WHERE entity_type = $1 AND entity_id = $2 AND follow_up_active", entity, frm)
    await con.execute("UPDATE task_links SET active = false WHERE entity_type = $1 AND entity_id = $2 AND active", entity, frm)
    await run("activities", "UPDATE activities SET entity_id = $3 WHERE entity_type = $1 AND entity_id = $2")
    await run("meetings", "UPDATE meetings SET entity_id = $3 WHERE entity_type = $1 AND entity_id = $2")
    await run("emails", "UPDATE email_threads SET entity_id = $3 WHERE entity_type = $1 AND entity_id = $2")
    await run("history", "UPDATE record_history SET entity_id = $3 WHERE entity_type = $1 AND entity_id = $2")
    await run("tasks", "UPDATE task_links SET entity_id = $3 WHERE entity_type = $1 AND entity_id = $2")
    return n


def _values(entity: str, keep: dict, other: dict, choices: dict[str, str]) -> dict[str, Any]:
    """Column updates for the kept record. Blank kept values are filled from
    the other record unless the person chose otherwise."""
    upd: dict[str, Any] = {}
    for f in FIELDS[entity]:
        choice = choices.get(f)
        if f == "next_action":
            if choice == "merge" or (choice is None and not keep.get("next_action_code") and other.get("next_action_code")):
                upd.update({c: other.get(c) for c in NEXT_ACTION_COLS if c in other})
            continue
        if f == "notes" and choice == "both":
            parts = [x for x in (keep.get("notes"), other.get("notes")) if x]
            upd["notes"] = "\n\n".join(parts) or None
        elif choice == "merge" or (choice is None and keep.get(f) in (None, "") and other.get(f) not in (None, "")):
            upd[f] = other.get(f)
    return {k: v for k, v in upd.items() if keep.get(k) != v}


def merged_preview(entity: str, keep: dict, other: dict, choices: dict[str, str]) -> dict:
    """The kept record as it will look after the merge (for validation)."""
    return {**keep, **_values(entity, keep, other, choices)}


async def merge(con: asyncpg.Connection, entity: str, keep_id: UUID, merge_id: UUID, choices: dict[str, str], user_id: UUID,
                other_extra: Optional[dict] = None) -> dict:
    table, name_col = TABLE[entity], NAME[entity]
    keep = await con.fetchrow(f"SELECT * FROM {table} WHERE id = $1 FOR UPDATE", keep_id)
    other = await con.fetchrow(f"SELECT * FROM {table} WHERE id = $1 FOR UPDATE", merge_id)
    if keep is None or other is None:
        raise LookupError("One of the records no longer exists.")
    keep, other = dict(keep), {**dict(other), **(other_extra or {})}
    upd = _values(entity, keep, other, choices)
    moved = await _move(con, entity, merge_id, keep_id)
    if entity == "account":
        moved["prospects"] = int((await con.execute("UPDATE prospects SET account_id = $2 WHERE account_id = $1", merge_id, keep_id)).split()[-1])
        moved["deals"] = int((await con.execute("UPDATE opportunities SET account_id = $2 WHERE account_id = $1", merge_id, keep_id)).split()[-1])
    else:
        moved["deals"] = int((await con.execute("UPDATE opportunities SET primary_contact_id = $2 WHERE primary_contact_id = $1", merge_id, keep_id)).split()[-1])
        last = max([d for d in (keep.get("last_activity_at"), other.get("last_activity_at")) if d], default=None)
        if last and last != keep.get("last_activity_at"):
            upd["last_activity_at"] = last
    await con.execute(
        "INSERT INTO merge_log(entity_type, kept_id, kept_name, merged_id, merged_name, snapshot, moved, merged_by) "
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)",
        entity, keep_id, upd.get(name_col, keep[name_col]), merge_id, other[name_col],
        json.dumps({k: _jsonable(v) for k, v in other.items()}), json.dumps(moved), user_id)
    hubspot = other.get("hubspot_id") if not keep.get("hubspot_id") else None
    await con.execute(f"DELETE FROM {table} WHERE id = $1", merge_id)
    if hubspot:
        upd["hubspot_id"] = hubspot
    if entity == "account" and "name" in upd:
        upd["name_key"] = domain.account_name_key(upd["name"])
        clash = await con.fetchval("SELECT name FROM accounts WHERE name_key = $1 AND id <> $2", upd["name_key"], keep_id)
        if clash:
            raise ValueError(f"Another account is already called “{clash}”.")
    if upd:
        cols = list(upd)
        sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(cols, start=2))
        await con.execute(f"UPDATE {table} SET {sets}, updated_at = now() WHERE id = $1", keep_id, *[upd[c] for c in cols])
        for c in cols:
            if c in ("name_key", "hubspot_id", "last_activity_at", "notes"):
                continue
            await con.execute(
                "INSERT INTO record_history(entity_type, entity_id, field, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5, $6)",
                entity, keep_id, c, None if keep.get(c) is None else str(_jsonable(keep.get(c))), None if upd[c] is None else str(_jsonable(upd[c])), user_id)
    bits = [f"{v} {k}" for k, v in moved.items() if v and k in ("prospects", "deals", "activities", "meetings", "emails")]
    await con.execute(
        "INSERT INTO activities(entity_type, entity_id, kind, summary, created_by) VALUES ($1, $2, 'merge', $3, $4)",
        entity, keep_id, f"Merged “{other[name_col]}” into this record" + (f" ({', '.join(bits)} moved)." if bits else "."), user_id)
    return {"kept_id": keep_id, "merged_name": other[name_col], "moved": moved, "updated_fields": [c for c in upd if c not in ("name_key",)]}
