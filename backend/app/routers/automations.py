"""Settings → Automations: admins add, pause and remove workflow rules."""
import json
from typing import Any, Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .. import domain
from ..auth import User, current_user, get_con, require_admin

router = APIRouter(prefix="/automations", tags=["automations"])


class RuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    entity: Literal["prospect", "opportunity"]
    trigger: Literal["created", "stage_changed", "status_changed"]
    trigger_value: Optional[str] = None
    action: Literal["set_next_action", "assign_owner", "add_to_list", "log_note"]
    params: dict[str, Any] = Field(default_factory=dict)


class RulePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    active: Optional[bool] = None
    name: Optional[str] = Field(None, min_length=1, max_length=80)


def _problems(r: RuleIn) -> list[dict]:
    e = []
    def bad(field: str, msg: str) -> None:
        e.append({"field": field, "message": msg})
    if r.entity == "opportunity" and r.trigger == "status_changed":
        bad("trigger", "Deals change stage, not status.")
    if r.entity == "prospect" and r.trigger == "stage_changed":
        bad("trigger", "Contacts change status, not stage.")
    if r.trigger_value:
        allowed = domain.STAGE_NAMES if r.trigger == "stage_changed" else domain.PROSPECT_STATUSES
        if r.trigger_value not in allowed:
            bad("trigger_value", "Choose a stage or status from the list.")
    p = r.params
    if r.action == "set_next_action":
        if p.get("code") not in domain.NEXT_ACTIONS:
            bad("params.code", "Choose the next action.")
        if not isinstance(p.get("days"), int) or not 0 <= p["days"] <= 365:
            bad("params.days", "Due in 0 to 365 business days.")
    elif r.action == "assign_owner" and not p.get("user_id"):
        bad("params.user_id", "Choose who to assign.")
    elif r.action == "add_to_list" and not p.get("list_id"):
        bad("params.list_id", "Choose a list.")
    elif r.action == "log_note" and not str(p.get("text") or "").strip():
        bad("params.text", "Write the note.")
    return e


async def _all(con: asyncpg.Connection) -> list[dict]:
    rows = await con.fetch("SELECT a.*, u.name AS created_by_name FROM automations a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at")
    return [{**dict(r), "params": json.loads(r["params"] or "{}")} for r in rows]


@router.get("")
async def list_rules(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return await _all(con)


@router.post("", status_code=201)
async def create_rule(body: RuleIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    errors = _problems(body)
    if errors:
        raise HTTPException(422, {"message": "Fix the highlighted fields before saving.", "errors": errors})
    await con.execute(
        "INSERT INTO automations(name, entity, trigger, trigger_value, action, params, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        body.name.strip(), body.entity, body.trigger, body.trigger_value or None, body.action, json.dumps(body.params), UUID(user.id))
    return await _all(con)


@router.patch("/{rule_id}")
async def update_rule(rule_id: UUID, body: RulePatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    patch = body.model_dump(exclude_unset=True)
    if patch:
        sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(patch, start=2))
        if (await con.execute(f"UPDATE automations SET {sets} WHERE id = $1", rule_id, *patch.values())) == "UPDATE 0":
            raise HTTPException(404, "Rule not found.")
    return await _all(con)


@router.delete("/{rule_id}")
async def delete_rule(rule_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    await con.execute("DELETE FROM automations WHERE id = $1", rule_id)
    return await _all(con)
