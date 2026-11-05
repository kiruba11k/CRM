"""Custom properties: admins define them (Settings → Custom properties);
anyone who can edit a record fills them in on its page."""
import re
from typing import Any, Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .. import customfields
from ..auth import User, current_user, ensure_can_edit, get_con, require_admin
from ..records import get_or_404

router = APIRouter(prefix="/custom-fields", tags=["custom-fields"])
Entity = Literal["accounts", "prospects", "opportunities"]
FieldType = Literal["text", "number", "date", "select", "checkbox"]


class FieldIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity: Entity
    label: str = Field(min_length=1, max_length=60)
    type: FieldType
    options: list[str] = Field(default_factory=list, max_length=50)


class FieldPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: Optional[str] = Field(None, min_length=1, max_length=60)
    options: Optional[list[str]] = Field(None, max_length=50)
    active: Optional[bool] = None
    position: Optional[int] = None


def _options(type_: str, options: list[str]) -> list[str]:
    opts = list(dict.fromkeys(o.strip()[:60] for o in options if o.strip()))
    if type_ == "select" and not opts:
        raise HTTPException(422, {"message": "A dropdown needs at least one option.", "errors": [{"field": "options", "message": "Add at least one option."}]})
    return opts if type_ == "select" else []


@router.get("")
async def list_fields(entity: Entity, include_inactive: bool = False, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return await customfields.fields(con, entity, include_inactive)


@router.post("", status_code=201)
async def create_field(body: FieldIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    label = body.label.strip()
    if await con.fetchval("SELECT 1 FROM custom_fields WHERE entity = $1 AND lower(label) = lower($2)", body.entity, label):
        raise HTTPException(409, {"message": f"There is already a property called “{label}”.", "errors": [{"field": "label", "message": "That name is taken."}]})
    key = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:40] or "field"
    if not key[0].isalpha():
        key = f"f_{key}"[:40]
    base, n = key, 2
    while await con.fetchval("SELECT 1 FROM custom_fields WHERE entity = $1 AND key = $2", body.entity, key):
        key = f"{base[:36]}_{n}"; n += 1
    pos = await con.fetchval("SELECT coalesce(max(position), 0) + 1 FROM custom_fields WHERE entity = $1", body.entity)
    row = await con.fetchrow(
        "INSERT INTO custom_fields(entity, key, label, type, options, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) "
        "RETURNING id, entity, key, label, type, options, position, active",
        body.entity, key, label, body.type, _options(body.type, body.options), pos, UUID(user.id))
    return dict(row)


@router.patch("/{field_id}")
async def update_field(field_id: UUID, body: FieldPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    f = await con.fetchrow("SELECT * FROM custom_fields WHERE id = $1", field_id)
    if not f:
        raise HTTPException(404, "Field not found.")
    patch = body.model_dump(exclude_unset=True)
    if "label" in patch:
        patch["label"] = patch["label"].strip()
    if "options" in patch:
        patch["options"] = _options(f["type"], patch["options"])
    if patch:
        sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(patch, start=2))
        await con.execute(f"UPDATE custom_fields SET {sets} WHERE id = $1", field_id, *patch.values())
    row = await con.fetchrow("SELECT id, entity, key, label, type, options, position, active FROM custom_fields WHERE id = $1", field_id)
    return dict(row)


@router.get("/values/{entity}")
async def all_values(entity: Entity, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Every record's values, for table columns: {record_id: {key: value}}."""
    return await customfields.values(con, entity)


@router.get("/values/{entity}/{record_id}")
async def record_values(entity: Entity, record_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return (await customfields.values(con, entity, [record_id])).get(str(record_id), {})


@router.put("/values/{entity}/{record_id}")
async def save_values(entity: Entity, record_id: UUID, body: dict[str, Any], con: asyncpg.Connection = Depends(get_con),
                      user: User = Depends(current_user)):
    rec = await get_or_404(con, entity, record_id, "Record")
    ensure_can_edit(user, rec.get("owner_id"))
    async with con.transaction():
        return await customfields.save(con, entity, record_id, body, user.id)
