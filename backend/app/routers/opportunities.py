"""Opportunities (§2.3), stages (§3.2), risk & nurture (§4), closure."""
from datetime import date
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from .. import domain
from ..auth import User, current_user, ensure_can_assign, ensure_can_edit, get_con
from ..records import activities, get_or_404, history, insert, log_activity, raise_if_errors, record_changes, update
from ..schemas import CompleteActionIn, NoteIn, OpportunityIn, OpportunityPatch, RevisitIn

router = APIRouter(prefix="/opportunities", tags=["opportunities"])

_TEAMS = {"database_build_team": "database_build", "proposal_team": "proposal"}


async def _set_teams(con: asyncpg.Connection, opp_id: UUID, teams: dict) -> None:
    for field, team in _TEAMS.items():
        if teams.get(field) is None:
            continue
        await con.execute("DELETE FROM opportunity_team WHERE opportunity_id = $1 AND team = $2", opp_id, team)
        await con.executemany(
            "INSERT INTO opportunity_team(opportunity_id, user_id, team) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [(opp_id, uid, team) for uid in teams[field]],
        )


async def _teams(con: asyncpg.Connection, opp_id: UUID) -> dict:
    rows = await con.fetch(
        "SELECT t.team, u.id, u.name FROM opportunity_team t JOIN users u ON u.id = t.user_id WHERE t.opportunity_id = $1 ORDER BY u.name",
        opp_id,
    )
    out = {"database_build_team": [], "proposal_team": []}
    for r in rows:
        key = "database_build_team" if r["team"] == "database_build" else "proposal_team"
        out[key].append({"id": r["id"], "name": r["name"]})
    return out


def _with_derived(row: dict) -> dict:
    return {
        **row,
        "probability": domain.STAGE_PROBABILITY[row["stage"]],
        "weighted_value": domain.weighted_value(row["estimated_value"], row["stage"]) if row.get("estimated_value") is not None else None,
        "next_action_label": domain.next_action_label(row.get("next_action_code"), row.get("next_action_other")),
    }


async def create_opportunity_record(con: asyncpg.Connection, data: dict, user: User) -> dict:
    """Shared by POST /opportunities and prospect conversion. Caller owns the transaction."""
    teams = {k: data.pop(k, None) for k in _TEAMS}
    data["owner_id"] = data.get("owner_id") or UUID(user.id)
    ensure_can_assign(user, data["owner_id"])
    account = await con.fetchrow("SELECT id, country FROM accounts WHERE id = $1", data["account_id"]) if data.get("account_id") else None
    if data.get("account_id") and account is None:
        raise HTTPException(422, {"message": "Fix the highlighted fields before saving.", "errors": [{"field": "account_id", "message": "Account not found."}]})
    data["geography"] = data.get("geography") or (account["country"] if account else None)
    if data.get("on_nurture") and not data.get("nurture_owner_id"):
        data["nurture_owner_id"] = data["owner_id"]
    data = domain.normalise_closed_opportunity(data)
    errors, warnings = domain.validate_opportunity(data)
    raise_if_errors(errors)
    row = await insert(con, "opportunities", data)
    await _set_teams(con, row["id"], teams)
    await record_changes(con, "opportunity", row["id"], None, row, user.id)
    return {**_with_derived(row), "warnings": warnings}


_LIST_SQL = """
SELECT o.*, a.name AS account_name, u.name AS owner_name
FROM opportunities o
JOIN accounts a ON a.id = o.account_id
LEFT JOIN users u ON u.id = o.owner_id
WHERE ($1::text IS NULL OR o.stage = $1)
  AND ($2::uuid IS NULL OR o.owner_id = $2)
  AND ($3::boolean OR NOT o.on_nurture)
  AND ($4::text IS NULL OR o.risk_rating = $4)
  AND ($5::text IS NULL OR o.service_line = $5)
  AND (NOT $6::boolean OR o.stage NOT IN ('Won', 'Lost'))
  AND ($7::boolean IS NULL OR o.on_nurture = $7)
ORDER BY o.expected_close NULLS LAST, o.created_at DESC
"""


@router.get("")
async def list_opportunities(
    stage: Optional[str] = None, owner_id: Optional[UUID] = None, include_nurtured: bool = False,
    risk_rating: Optional[str] = None, service_line: Optional[str] = None, open_only: bool = False,
    nurtured_only: bool = False,
    con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
):
    rows = await con.fetch(
        _LIST_SQL, stage, owner_id, include_nurtured or nurtured_only, risk_rating, service_line, open_only,
        True if nurtured_only else None,
    )
    return [_with_derived(dict(r)) for r in rows]


@router.post("", status_code=201)
async def create_opportunity(body: OpportunityIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    async with con.transaction():
        return await create_opportunity_record(con, body.model_dump(), user)


@router.get("/{opp_id}")
async def get_opportunity(opp_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    row = await get_or_404(con, "opportunities", opp_id, "Opportunity")
    _, warnings = domain.validate_opportunity(row)
    return {
        **_with_derived(row),
        **(await _teams(con, opp_id)),
        "warnings": warnings,
        "activities": await activities(con, [("opportunity", opp_id)]),
        "history": await history(con, "opportunity", opp_id),
    }


async def _apply_update(con: asyncpg.Connection, opp_id: UUID, before: dict, patch: dict, user: User) -> dict:
    teams = {k: patch.pop(k, None) for k in _TEAMS}
    merged = {**before, **patch}
    if merged.get("on_nurture") and not merged.get("nurture_owner_id"):
        patch["nurture_owner_id"] = merged["nurture_owner_id"] = merged["owner_id"]
    normalised = domain.normalise_closed_opportunity(merged)
    for f in ("next_action_code", "next_action_other", "next_action_due"):
        if normalised[f] != merged[f]:
            patch[f] = normalised[f]
    errors, warnings = domain.validate_opportunity(normalised)
    raise_if_errors(errors)
    row = await update(con, "opportunities", opp_id, patch)
    await _set_teams(con, opp_id, teams)
    await record_changes(con, "opportunity", opp_id, before, row, user.id)
    if before["stage"] != row["stage"]:
        await log_activity(con, "opportunity", opp_id, "stage_change", f"Stage: {before['stage']} → {row['stage']}", user.id)
    if before["on_nurture"] != row["on_nurture"]:
        summary = f"Put on nurture until {row['nurture_until']} ({row['nurture_reason']})" if row["on_nurture"] else "Taken off nurture"
        await log_activity(con, "opportunity", opp_id, "nurture", summary, user.id)
    return {**_with_derived(row), "warnings": warnings}


@router.patch("/{opp_id}")
async def update_opportunity(
    opp_id: UUID, body: OpportunityPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    before = await get_or_404(con, "opportunities", opp_id, "Opportunity")
    ensure_can_edit(user, before["owner_id"])
    patch = body.model_dump(exclude_unset=True)
    if "owner_id" in patch:
        ensure_can_assign(user, patch["owner_id"])
    if "account_id" in patch and patch["account_id"] is not None:
        if not await con.fetchval("SELECT 1 FROM accounts WHERE id = $1", patch["account_id"]):
            raise HTTPException(422, {"message": "Fix the highlighted fields before saving.", "errors": [{"field": "account_id", "message": "Account not found."}]})
    async with con.transaction():
        return await _apply_update(con, opp_id, before, patch, user)


@router.post("/{opp_id}/complete-action")
async def complete_action(
    opp_id: UUID, body: CompleteActionIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    before = await get_or_404(con, "opportunities", opp_id, "Opportunity")
    ensure_can_edit(user, before["owner_id"])
    if before["stage"] in domain.CLOSED_STAGES:
        raise HTTPException(409, "This opportunity is closed.")
    if before["on_nurture"]:
        raise HTTPException(409, "This opportunity is on nurture. Use the revisit outcome instead.")
    done = domain.next_action_label(before["next_action_code"], before["next_action_other"]) or "Action"
    async with con.transaction():
        await log_activity(con, "opportunity", opp_id, "action_completed", f"Completed: {done}" + (f". {body.note}" if body.note else ""), user.id)
        return await _apply_update(con, opp_id, before, {
            "next_action_code": body.next_action_code, "next_action_other": body.next_action_other, "next_action_due": body.next_action_due,
        }, user)


@router.post("/{opp_id}/revisit")
async def revisit_nurture(
    opp_id: UUID, body: RevisitIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    """§4.2: at revisit, reactivate, extend nurture, or mark Lost."""
    before = await get_or_404(con, "opportunities", opp_id, "Opportunity")
    ensure_can_edit(user, before["owner_id"])
    if not before["on_nurture"]:
        raise HTTPException(409, "This opportunity is not on nurture.")
    if body.outcome == "reactivate":
        patch = {"on_nurture": False, "next_action_code": body.next_action_code, "next_action_other": body.next_action_other, "next_action_due": body.next_action_due}
    elif body.outcome == "extend":
        patch = {"nurture_until": body.nurture_until}
        if body.next_action_code:
            patch.update(nurture_next_action_code=body.next_action_code, nurture_next_action_other=body.next_action_other)
    else:
        patch = {"on_nurture": False, "stage": domain.LOST, "lost_reason": body.lost_reason, "lost_notes": body.lost_notes, "lost_date": body.lost_date or date.today()}
    async with con.transaction():
        return await _apply_update(con, opp_id, before, patch, user)


@router.post("/{opp_id}/activities", status_code=201)
async def add_note(opp_id: UUID, body: NoteIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    await get_or_404(con, "opportunities", opp_id, "Opportunity")
    await log_activity(con, "opportunity", opp_id, body.kind, body.summary, user.id)
    return {"ok": True}
