"""Bulk import of accounts, prospects and deals from CSV (managers and admins).

The browser sends the file text with each call; nothing is stored until
`commit`. Each committed import is recorded in import_runs (source 'csv').
"""
import json
from datetime import date
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from .. import csvimport, tasksync
from ..auth import User, current_user, get_con

router = APIRouter(prefix="/import/csv", tags=["import"])

Entity = Literal["accounts", "prospects", "opportunities"]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AnalyzeIn(_In):
    entity: Entity
    text: str


class OptionsIn(_In):
    day_first: bool = True
    create_missing_accounts: bool = True
    default_country: Optional[str] = None
    default_owner_id: Optional[UUID] = None
    default_currency: str = "USD"
    stage_map: dict[str, str] = {}


class PlanIn(_In):
    entity: Entity
    text: str
    mapping: dict[str, Optional[str]]
    options: OptionsIn = OptionsIn()
    file_name: Optional[str] = None


def _manager(user: User) -> None:
    if not user.can_edit_all:
        raise HTTPException(403, "Bulk import is for managers and admins.")


def _read(text: str):
    try:
        return csvimport.read_csv(text)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/fields")
async def fields(user: User = Depends(current_user)):
    return {e: [{"key": k, "label": l, "required": r} for k, (l, r, _a) in f.items()] for e, f in csvimport.FIELDS.items()}


@router.post("/analyze")
async def analyze(body: AnalyzeIn, user: User = Depends(current_user)):
    _manager(user)
    headers, rows = _read(body.text)
    return {"headers": headers, "row_count": len(rows), "sample": rows[:5],
            "mapping": csvimport.suggest_mapping(body.entity, headers)}


async def _plans(body: PlanIn, con: asyncpg.Connection, user: User):
    headers, rows = _read(body.text)
    bad = [c for c in body.mapping.values() if c and c not in headers]
    if bad:
        raise HTTPException(422, f"These columns aren’t in the file: {', '.join(bad)}.")
    unknown = set(body.mapping) - set(csvimport.FIELDS[body.entity])
    if unknown:
        raise HTTPException(422, f"Unknown fields: {', '.join(sorted(unknown))}.")
    m = body.mapping
    if body.entity == "prospects" and not (m.get("full_name") or m.get("first_name") or m.get("last_name")):
        raise HTTPException(422, "Map a Full name column, or First name and Last name.")
    for f, (label, required, _a) in csvimport.FIELDS[body.entity].items():
        if required and not m.get(f) and not (f == "country" and body.options.default_country):
            raise HTTPException(422, f"Map a column to “{label}”" + (" or set a default country." if f == "country" else "."))
    o = body.options
    if o.default_owner_id and not await con.fetchval("SELECT 1 FROM users WHERE id = $1 AND active", o.default_owner_id):
        raise HTTPException(422, "The default owner isn’t an active user.")
    lk = await csvimport.Lookups.load(con)
    opts = csvimport.Options(day_first=o.day_first, create_missing_accounts=o.create_missing_accounts,
                             default_country=(o.default_country or "").strip() or None, default_owner_id=o.default_owner_id,
                             default_currency=(o.default_currency or "USD").upper(),
                             stage_map={csvimport._norm(k): v for k, v in o.stage_map.items() if v in csvimport.domain.STAGE_NAMES})
    return csvimport.plan_rows(body.entity, rows, m, opts, lk, UUID(user.id), date.today())


@router.post("/plan")
async def plan(body: PlanIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    _manager(user)
    plans = await _plans(body, con, user)
    return {"summary": csvimport.summary(plans), "rows": [p.out() for p in plans], "unknown_stages": csvimport.unknown_stages(plans)}


@router.post("/commit")
async def commit(body: PlanIn, request: Request, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    _manager(user)
    plans = await _plans(body, con, user)
    result = await csvimport.commit(con, body.entity, plans, UUID(user.id))
    # Owners who mirror next actions to Google Tasks get the new ones too.
    if body.entity != "accounts" and result["created"]:
        owners = {p.record.get("owner_id") for p in plans if p.status in ("ready", "cleanup") and p.record.get("owner_id")}
        for owner in await con.fetch("SELECT user_id FROM calendar_connections WHERE tasks_enabled AND user_id = ANY($1::uuid[])", list(owners)):
            tasksync.start_backfill(request, owner["user_id"])
    s = csvimport.summary(plans)
    label = {"accounts": "accounts", "prospects": "prospects", "opportunities": "deals"}[body.entity]
    n = lambda k, word: f"{k} {word}{'' if k == 1 else 's'}"  # noqa: E731
    skipped = s["error"] + result["failed"]
    message = (f"Imported {n(result['created'], label[:-1])} from {body.file_name or 'CSV'}"
               + (f" and created {n(result['accounts_created'], 'new account')}" if result["accounts_created"] else "") + "."
               + (f" Skipped {n(s['duplicate'], 'duplicate')}." if s["duplicate"] else "")
               + (f" {n(skipped, 'row')} couldn’t be imported." if skipped else ""))
    await con.execute(
        "INSERT INTO import_runs(source, started_by, finished_at, status, message, options, counts, errors, error_count) "
        "VALUES ('csv', $1, now(), 'succeeded', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)",
        UUID(user.id), message, json.dumps({"entity": body.entity, "file": body.file_name}),
        json.dumps({label: {"created": result["created"], "failed": result["failed"]}, "summary": s}),
        json.dumps(result["failures"][:500]), result["failed"])
    return {"message": message, **result, "summary": s}
