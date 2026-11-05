"""Saved views: named filters (and sort) on Prospects, Accounts and the
Pipeline. Private by default; shared views show for the whole team. Each
person can pick one view per page to open by default."""
import json
from typing import Any, Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..auth import User, current_user, get_con

router = APIRouter(prefix="/saved-views", tags=["saved views"])
Page = Literal["prospects", "accounts", "pipeline", "deals"]
MAX_PER_PAGE = 40

_SELECT = """
SELECT v.id, v.page, v.name, v.filters, v.shared, v.owner_id, u.name AS owner_name, v.position, v.updated_at,
       (d.view_id IS NOT NULL) AS is_default
FROM saved_views v JOIN users u ON u.id = v.owner_id
LEFT JOIN saved_view_defaults d ON d.view_id = v.id AND d.user_id = $2
"""


def _out(r: asyncpg.Record, user: User) -> dict:
    d = dict(r)
    d["filters"] = json.loads(d["filters"]) if isinstance(d["filters"], str) else d["filters"]
    d["mine"] = str(d["owner_id"]) == user.id
    return d


async def _one(con: asyncpg.Connection, view_id: UUID, user: User) -> dict:
    r = await con.fetchrow(_SELECT + " WHERE v.id = $1", view_id, UUID(user.id))
    if r is None or not (r["shared"] or str(r["owner_id"]) == user.id):
        raise HTTPException(404, "View not found.")
    return _out(r, user)


def _name(v: str) -> str:
    v = " ".join(v.split())
    if not 1 <= len(v) <= 60:
        raise HTTPException(422, "Give the view a name (up to 60 characters).")
    return v


def _filters(f: dict[str, Any]) -> str:
    s = json.dumps(f)
    if len(s) > 4000:
        raise HTTPException(422, "That view has too many filters to save.")
    return s


@router.get("")
async def list_views(page: Page, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(_SELECT + " WHERE v.page = $1 AND (v.owner_id = $2 OR v.shared) "
                           "ORDER BY (v.owner_id = $2) DESC, v.position, v.name", page, UUID(user.id))
    return [_out(r, user) for r in rows]


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: Page
    name: str
    filters: dict[str, Any] = Field(default_factory=dict)
    shared: bool = False


@router.post("", status_code=201)
async def create_view(body: ViewIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    name = _name(body.name)
    if await con.fetchval("SELECT count(*) FROM saved_views WHERE owner_id = $1 AND page = $2", UUID(user.id), body.page) >= MAX_PER_PAGE:
        raise HTTPException(409, f"You can save up to {MAX_PER_PAGE} views per page. Delete one first.")
    try:
        row = await con.fetchrow(
            "INSERT INTO saved_views(owner_id, page, name, filters, shared, position) "
            "VALUES ($1, $2, $3, $4::jsonb, $5, (SELECT COALESCE(max(position), 0) + 1 FROM saved_views WHERE owner_id = $1 AND page = $2)) RETURNING id",
            UUID(user.id), body.page, name, _filters(body.filters), body.shared)
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, f"You already have a view called “{name}”. Pick another name or update that one.") from e
    return await _one(con, row["id"], user)


class ViewPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    filters: Optional[dict[str, Any]] = None
    shared: Optional[bool] = None


@router.patch("/{view_id}")
async def update_view(view_id: UUID, body: ViewPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    v = await _one(con, view_id, user)
    if not v["mine"]:
        raise HTTPException(403, f"Only {v['owner_name']} can change this view. Save your own copy instead.")
    sets, vals = [], []
    if body.name is not None:
        sets.append("name"); vals.append(_name(body.name))
    if body.filters is not None:
        sets.append("filters"); vals.append(_filters(body.filters))
    if body.shared is not None:
        sets.append("shared"); vals.append(body.shared)
    if sets:
        assign = ", ".join(f"{c} = ${i}" + ("::jsonb" if c == "filters" else "") for i, c in enumerate(sets, start=2))
        try:
            await con.execute(f"UPDATE saved_views SET {assign}, updated_at = now() WHERE id = $1", view_id, *vals)
        except asyncpg.UniqueViolationError as e:
            raise HTTPException(409, "You already have a view with that name.") from e
        if body.shared is False:  # others can't keep a private view as their default
            await con.execute("DELETE FROM saved_view_defaults WHERE view_id = $1 AND user_id <> $2", view_id, UUID(user.id))
    return await _one(con, view_id, user)


@router.delete("/{view_id}")
async def delete_view(view_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    v = await _one(con, view_id, user)
    if not v["mine"] and not user.can("manage_settings"):
        raise HTTPException(403, f"Only {v['owner_name']} or an admin can delete this view.")
    await con.execute("DELETE FROM saved_views WHERE id = $1", view_id)
    return {"deleted": True}


class DefaultIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: Page
    view_id: Optional[UUID] = None   # None = back to the page's normal start


@router.put("/default")
async def set_default(body: DefaultIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    if body.view_id is None:
        await con.execute("DELETE FROM saved_view_defaults WHERE user_id = $1 AND page = $2", UUID(user.id), body.page)
        return {"page": body.page, "view_id": None}
    v = await _one(con, body.view_id, user)
    if v["page"] != body.page:
        raise HTTPException(422, "That view belongs to another page.")
    await con.execute(
        "INSERT INTO saved_view_defaults(user_id, page, view_id) VALUES ($1, $2, $3) "
        "ON CONFLICT (user_id, page) DO UPDATE SET view_id = EXCLUDED.view_id", UUID(user.id), body.page, body.view_id)
    return {"page": body.page, "view_id": body.view_id}
