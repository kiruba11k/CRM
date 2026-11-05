"""Static lists of records ("add to a list", CRM review §4.4): a named set of
companies, contacts or deals that anyone on the team can use as a filter,
e.g. "Arab Health 2027 invite list". Lists are shared; the person who made a
list, a manager or an admin can rename or delete it."""
from typing import Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, get_con

router = APIRouter(prefix="/record-lists", tags=["record-lists"])
Entity = Literal["accounts", "prospects", "opportunities"]


class ListIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity: Entity
    name: str = Field(min_length=1, max_length=80)


class MembersIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[UUID] = Field(min_length=1, max_length=500)


_SELECT = ("SELECT l.id, l.entity, l.name, l.owner_id, u.name AS owner_name, l.created_at, "
           "(SELECT count(*) FROM record_list_members m WHERE m.list_id = l.id) AS size, "
           "coalesce((SELECT array_agg(m.record_id) FROM record_list_members m WHERE m.list_id = l.id), '{}') AS record_ids "
           "FROM record_lists l LEFT JOIN users u ON u.id = l.owner_id ")


async def _get(con: asyncpg.Connection, list_id: UUID) -> dict:
    row = await con.fetchrow(_SELECT + "WHERE l.id = $1", list_id)
    if not row:
        raise HTTPException(404, "List not found.")
    return dict(row)


def _can_manage(user: User, lst: dict) -> None:
    if str(lst["owner_id"]) != user.id and not user.can_edit_all:
        raise HTTPException(403, "Only the person who made this list, a manager or an admin can change it.")


@router.get("")
async def list_lists(entity: Entity, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return [dict(r) for r in await con.fetch(_SELECT + "WHERE l.entity = $1 ORDER BY lower(l.name)", entity)]


@router.post("", status_code=201)
async def create_list(body: ListIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Give the list a name.")
    try:
        new_id = await con.fetchval("INSERT INTO record_lists(entity, name, owner_id) VALUES ($1, $2, $3) RETURNING id", body.entity, name, UUID(user.id))
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, f"There is already a list called “{name}”.") from e
    return await _get(con, new_id)


@router.delete("/{list_id}")
async def delete_list(list_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    _can_manage(user, await _get(con, list_id))
    await con.execute("DELETE FROM record_lists WHERE id = $1", list_id)
    return {"ok": True}


@router.post("/{list_id}/members")
async def add_members(list_id: UUID, body: MembersIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Anyone can add records to a list; records already on it are left as they are."""
    lst = await _get(con, list_id)
    table = lst["entity"]
    found = {r["id"] for r in await con.fetch(f"SELECT id FROM {table} WHERE id = ANY($1::uuid[])", body.ids)}
    await con.executemany(
        "INSERT INTO record_list_members(list_id, record_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [(list_id, i, UUID(user.id)) for i in found])
    out = await _get(con, list_id)
    return {**out, "added": len(found), "not_found": len(set(body.ids) - found)}


@router.post("/{list_id}/remove")
async def remove_members(list_id: UUID, body: MembersIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    await _get(con, list_id)
    await con.execute("DELETE FROM record_list_members WHERE list_id = $1 AND record_id = ANY($2::uuid[])", list_id, body.ids)
    return await _get(con, list_id)
