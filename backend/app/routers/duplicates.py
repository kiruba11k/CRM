"""Find and merge duplicate accounts and prospects (Cleanup → Duplicates)."""
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import dedupe, domain, integrations
from ..auth import User, current_user, get_con
from ..records import raise_if_errors

router = APIRouter(prefix="/duplicates", tags=["duplicates"])
Entity = Literal["accounts", "prospects"]
ONE = {"accounts": "account", "prospects": "prospect"}


def _merger(user: User) -> None:
    if not user.can_edit_all:
        raise HTTPException(403, "Merging changes other people’s records, so it needs the “Edit and reassign anyone’s records” permission.")


@router.get("/merges")
async def recent_merges(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(
        "SELECT m.id, m.entity_type, m.kept_id, m.kept_name, m.merged_name, m.moved, m.merged_at, u.name AS merged_by "
        "FROM merge_log m LEFT JOIN users u ON u.id = m.merged_by ORDER BY m.merged_at DESC LIMIT 20")
    import json
    return [{**dict(r), "moved": json.loads(r["moved"]) if isinstance(r["moved"], str) else r["moved"]} for r in rows]


@router.get("/{entity}")
async def find(entity: Entity, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    pairs = await (dedupe.find_accounts(con) if entity == "accounts" else dedupe.find_prospects(con))
    return {"entity": entity, "count": len(pairs), "pairs": pairs[:200], "can_merge": user.can_edit_all}


async def _record(con: asyncpg.Connection, entity: str, id_: UUID) -> dict:
    if entity == "account":
        r = await con.fetchrow(
            "SELECT a.*, u.name AS owner_name, (SELECT count(*) FROM prospects p WHERE p.account_id = a.id) AS prospects, "
            "(SELECT count(*) FROM opportunities o WHERE o.account_id = a.id) AS deals, "
            "(SELECT count(*) FROM activities x WHERE x.entity_type = 'account' AND x.entity_id = a.id) AS activity "
            "FROM accounts a LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = $1", id_)
    else:
        r = await con.fetchrow(
            "SELECT p.*, u.name AS owner_name, ac.name AS account_name, "
            "(SELECT count(*) FROM opportunities o WHERE o.primary_contact_id = p.id) AS deals, "
            "(SELECT count(*) FROM activities x WHERE x.entity_type = 'prospect' AND x.entity_id = p.id) AS activity "
            "FROM prospects p LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN accounts ac ON ac.id = p.account_id WHERE p.id = $1", id_)
    if r is None:
        raise HTTPException(404, "That record no longer exists (it may already have been merged).")
    d = dict(r)
    if entity == "prospect":
        d["next_action_label"] = domain.next_action_label(d.get("next_action_code"), d.get("next_action_other")) if d.get("next_action_code") else None
    return d


@router.get("/{entity}/compare")
async def compare(entity: Entity, a: UUID, b: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    e = ONE[entity]
    return {"fields": dedupe.FIELDS[e], "a": await _record(con, e, a), "b": await _record(con, e, b)}


class MergeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keep_id: UUID
    merge_id: UUID
    choices: dict[str, Literal["keep", "merge", "both"]] = Field(default_factory=dict)


@router.post("/{entity}/merge")
async def merge(entity: Entity, body: MergeIn, request: Request, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    _merger(user)
    e = ONE[entity]
    if body.keep_id == body.merge_id:
        raise HTTPException(422, "Pick two different records.")
    bad = {k for k, v in body.choices.items() if k not in dedupe.FIELDS[e] or (v == "both" and k != "notes")}
    if bad:
        raise HTTPException(422, f"Unknown choice for: {', '.join(sorted(bad))}.")
    keep = await _record(con, e, body.keep_id)
    other = await _record(con, e, body.merge_id)
    merged = dedupe.merged_preview(e, keep, other, body.choices)
    errors, _ = (domain.validate_account if e == "account" else domain.validate_prospect)(merged)
    raise_if_errors(errors)

    extra = None
    if e == "prospect" and other.get("next_action_code"):
        # Take the removed prospect's Google follow-up/task down cleanly first;
        # its next action is still offered to the kept record.
        extra = {c: other.get(c) for c in dedupe.NEXT_ACTION_COLS}
        await con.execute("UPDATE prospects SET next_action_code = NULL, next_action_other = NULL, next_action_due = NULL, "
                          "next_action_time = NULL, next_action_in_calendar = false WHERE id = $1", body.merge_id)
        await integrations.after_save(request, con, "prospect", body.merge_id)
    try:
        async with con.transaction():
            result = await dedupe.merge(con, e, body.keep_id, body.merge_id, body.choices, UUID(user.id), other_extra=extra)
    except LookupError as ex:
        raise HTTPException(404, str(ex)) from ex
    except ValueError as ex:
        raise HTTPException(409, str(ex)) from ex
    except asyncpg.UniqueViolationError as ex:
        raise HTTPException(409, "Those values clash with another record (e.g. the same email). Pick the other value.") from ex
    if e == "prospect":
        await integrations.after_save(request, con, "prospect", body.keep_id)
    return result


class DismissIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a: UUID
    b: UUID


@router.post("/{entity}/dismiss")
async def dismiss(entity: Entity, body: DismissIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    _merger(user)
    await dedupe.dismiss(con, ONE[entity], body.a, body.b, UUID(user.id))
    return {"dismissed": True}
