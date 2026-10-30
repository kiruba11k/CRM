"""Prospects / contacts (§2.2, §3.1) and converting one into an opportunity."""
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import domain, followups
from ..auth import User, current_user, ensure_can_assign, ensure_can_edit, get_con
from ..records import activities, get_or_404, history, insert, log_activity, raise_if_errors, record_changes, update
from ..schemas import CompleteActionIn, ConvertProspectIn, NoteIn, ProspectIn, ProspectPatch
from .opportunities import create_opportunity_record

router = APIRouter(prefix="/prospects", tags=["prospects"])

_LIST_SQL = """
SELECT p.*, a.name AS account_name, a.country AS geography, u.name AS owner_name
FROM prospects p
LEFT JOIN accounts a ON a.id = p.account_id
LEFT JOIN users u ON u.id = p.owner_id
WHERE ($1::uuid IS NULL OR p.owner_id = $1)
  AND (NOT $2::boolean OR p.account_id IS NULL)
  AND ($3::text IS NULL OR p.status = $3)
  AND ($4::text IS NULL OR a.country = $4)
  AND ($5::text IS NULL OR p.source = $5)
  AND ($6::text IS NULL OR p.next_action_code = $6)
  AND ($7::text IS NULL OR p.full_name ILIKE '%' || $7 || '%' OR p.email ILIKE '%' || $7 || '%' OR a.name ILIKE '%' || $7 || '%')
ORDER BY p.next_action_due NULLS LAST, p.full_name
"""


@router.get("")
async def list_prospects(
    scope: Literal["mine", "all", "unlinked"] = "mine",
    status: Optional[str] = None, country: Optional[str] = None, source: Optional[str] = None,
    next_action: Optional[str] = None, q: Optional[str] = None,
    con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user),
):
    owner = UUID(user.id) if scope == "mine" else None
    rows = await con.fetch(_LIST_SQL, owner, scope == "unlinked", status, country, source, next_action, q)
    return [dict(r) for r in rows]


async def _save_or_conflict(coro):
    try:
        return await coro
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, {"message": "A prospect with this email already exists."}) from e


@router.post("", status_code=201)
async def create_prospect(body: ProspectIn, request: Request, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    data = body.model_dump()
    if data["status"] not in domain.CLOSED_PROSPECT_STATUSES:
        data["owner_id"] = data["owner_id"] or UUID(user.id)
    ensure_can_assign(user, data["owner_id"])
    errors, warnings = domain.validate_prospect(data)
    raise_if_errors(errors)
    async with con.transaction():
        row = await _save_or_conflict(insert(con, "prospects", data))
        await record_changes(con, "prospect", row["id"], None, row, user.id)
    await followups.reconcile(request, con, "prospect", row["id"])
    return {**row, "warnings": warnings}


@router.get("/{prospect_id}")
async def get_prospect(prospect_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    p = await get_or_404(con, "prospects", prospect_id, "Prospect")
    opps = [dict(r) for r in await con.fetch(
        "SELECT id, name, stage, estimated_value, currency, on_nurture FROM opportunities WHERE primary_contact_id = $1 ORDER BY created_at DESC",
        prospect_id,
    )]
    return {
        **p,
        "follow_up": await followups.current(con, "prospect", prospect_id),
        "opportunities": opps,
        "activities": await activities(con, [("prospect", prospect_id)]),
        "history": await history(con, "prospect", prospect_id),
    }


@router.patch("/{prospect_id}")
async def update_prospect(
    prospect_id: UUID, body: ProspectPatch, request: Request, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    before = await get_or_404(con, "prospects", prospect_id, "Prospect")
    ensure_can_edit(user, before["owner_id"])
    patch = body.model_dump(exclude_unset=True)
    if "owner_id" in patch:
        ensure_can_assign(user, patch["owner_id"])
    merged = {**before, **patch}
    if merged.get("status") in domain.CLOSED_PROSPECT_STATUSES:
        # Disqualified prospects get no open-record reminders (§5.3).
        for f in domain.NEXT_ACTION_FIELDS:
            patch[f] = merged[f] = None
        patch["next_action_in_calendar"] = merged["next_action_in_calendar"] = False
    errors, warnings = domain.validate_prospect(merged)
    raise_if_errors(errors)
    async with con.transaction():
        row = await _save_or_conflict(update(con, "prospects", prospect_id, patch))
        await record_changes(con, "prospect", prospect_id, before, row, user.id)
        if before["status"] != row["status"]:
            await log_activity(con, "prospect", prospect_id, "status_change", f"Status: {before['status']} → {row['status']}", user.id)
    await followups.reconcile(request, con, "prospect", prospect_id)
    return {**row, "warnings": warnings}


@router.post("/{prospect_id}/complete-action")
async def complete_action(
    prospect_id: UUID, body: CompleteActionIn, request: Request, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    before = await get_or_404(con, "prospects", prospect_id, "Prospect")
    ensure_can_edit(user, before["owner_id"])
    if before["status"] in domain.CLOSED_PROSPECT_STATUSES:
        raise HTTPException(409, "This prospect is closed. Reopen it before adding a next action.")
    patch = body.model_dump(exclude={"note"})
    merged = {**before, **patch}
    errors, _ = domain.validate_prospect(merged)
    raise_if_errors(errors)
    done = domain.next_action_label(before["next_action_code"], before["next_action_other"]) or "Action"
    summary = f"Completed: {done}" + (f". {body.note}" if body.note else "")
    async with con.transaction():
        await log_activity(con, "prospect", prospect_id, "action_completed", summary, user.id)
        patch["last_activity_at"] = await con.fetchval("SELECT now()")
        row = await update(con, "prospects", prospect_id, patch)
        await record_changes(con, "prospect", prospect_id, before, row, user.id)
    await followups.reconcile(request, con, "prospect", prospect_id)
    return row


@router.post("/{prospect_id}/activities", status_code=201)
async def add_note(prospect_id: UUID, body: NoteIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    await get_or_404(con, "prospects", prospect_id, "Prospect")
    async with con.transaction():
        await log_activity(con, "prospect", prospect_id, body.kind, body.summary, user.id)
        await con.execute("UPDATE prospects SET last_activity_at = now() WHERE id = $1", prospect_id)
    return {"ok": True}


@router.post("/{prospect_id}/convert", status_code=201)
async def convert_to_opportunity(
    prospect_id: UUID, body: ConvertProspectIn, request: Request, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)
):
    """§2.4 / §9 prospect lifecycle: a qualified pursuit becomes an
    opportunity without losing contact history. The prospect stays as the
    opportunity's primary contact."""
    p = await get_or_404(con, "prospects", prospect_id, "Prospect")
    ensure_can_edit(user, p["owner_id"])
    if p["status"] in domain.CLOSED_PROSPECT_STATUSES:
        raise HTTPException(409, "A disqualified prospect can't be converted.")
    account_id = body.account_id or p["account_id"]
    if account_id is None:
        raise HTTPException(422, {"message": "Fix the highlighted fields before saving.", "errors": [{"field": "account_id", "message": "Choose or create an account first."}]})
    data = body.model_dump()
    data.update(account_id=account_id, primary_contact_id=prospect_id, owner_id=body.owner_id or p["owner_id"] or UUID(user.id))
    async with con.transaction():
        opp = await create_opportunity_record(con, data, user)
        p_patch = {"account_id": account_id}
        if domain.PROSPECT_STATUSES.index(p["status"]) < domain.PROSPECT_STATUSES.index("Qualified") or p["status"] == "Nurture":
            p_patch["status"] = "Qualified"
        row = await update(con, "prospects", prospect_id, p_patch)
        await record_changes(con, "prospect", prospect_id, p, row, user.id)
        await log_activity(con, "prospect", prospect_id, "converted", f"Opportunity created: {opp['name']}", user.id)
    await followups.reconcile(request, con, "opportunity", opp["id"])
    return opp
