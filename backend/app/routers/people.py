"""People and roles (Settings → People & access).

Admins (anyone with manage_users) add people ahead of their first Google
sign-in, set their job title and role, and define roles as named sets of
permissions (app/access.py). There is always at least one active person who
can manage people, so nobody can lock the team out.
"""
import re
from typing import Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .. import access
from ..auth import User, current_user, get_con, require
from ..config import Settings, get_settings
from ..schemas import UserPatch

router = APIRouter(tags=["people"])
manage_users = require("manage_users")

_USERS = ("SELECT u.id, u.email, u.name, u.role, r.name AS role_name, u.title, u.active, u.last_seen_at, u.created_at "
          "FROM users u JOIN roles r ON r.key = u.role")


async def _audit(con: asyncpg.Connection, summary: str, user: User) -> None:
    await con.execute("INSERT INTO settings_changes(area, summary, changed_by) VALUES ('People & roles', $1, $2)", summary, UUID(user.id))


async def _guard(con: asyncpg.Connection) -> None:
    """Call inside the transaction after a change: someone must still be able to manage people."""
    n = await con.fetchval("SELECT count(*) FROM users u JOIN roles r ON r.key = u.role WHERE u.active AND 'manage_users' = ANY(r.permissions)")
    if not n:
        raise HTTPException(409, "That would leave nobody who can manage people and roles. Give someone else that access first.")


def _clean(v: Optional[str], limit: int) -> Optional[str]:
    v = " ".join((v or "").split())
    if len(v) > limit:
        raise HTTPException(422, f"Keep it to {limit} characters.")
    return v or None


async def _role(con: asyncpg.Connection, key: str) -> asyncpg.Record:
    r = await con.fetchrow("SELECT * FROM roles WHERE key = $1", key)
    if r is None:
        raise HTTPException(422, "Pick one of the CRM’s roles.")
    return r


# ── People ────────────────────────────────────────────────────────────

@router.get("/users")
async def users(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return [dict(r) for r in await con.fetch(_USERS + " ORDER BY u.active DESC, u.name")]


class PersonIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str
    name: str = Field(min_length=1, max_length=120)
    title: Optional[str] = None
    role: str = "salesperson"


@router.post("/users", status_code=201)
async def add_person(body: PersonIn, con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings),
                     user: User = Depends(manage_users)):
    email = body.email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(422, "Enter a valid email address.")
    if not email.endswith("@" + settings.allowed_domain.lower()):
        raise HTTPException(422, f"Only {settings.allowed_domain} Google accounts can sign in to the CRM.")
    role = await _role(con, body.role)
    name = _clean(body.name, 120)
    if not name:
        raise HTTPException(422, "Enter their name.")
    existing = await con.fetchrow("SELECT name, active FROM users WHERE email = $1", email)
    if existing:
        raise HTTPException(409, f"{existing['name']} ({email}) is already in the CRM" + ("" if existing["active"] else ", deactivated: reactivate them instead") + ".")
    async with con.transaction():
        row = await con.fetchrow(
            "INSERT INTO users(email, name, title, role, added_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            email, name, _clean(body.title, 80), role["key"], UUID(user.id))
        await _audit(con, f"Added {name} ({email}) as {role['name']}.", user)
    return dict(await con.fetchrow(_USERS + " WHERE u.id = $1", row["id"]))


@router.patch("/users/{user_id}")
async def update_person(user_id: UUID, body: UserPatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(manage_users)):
    before = await con.fetchrow(_USERS + " WHERE u.id = $1", user_id)
    if before is None:
        raise HTTPException(404, "Person not found.")
    patch = body.model_dump(exclude_unset=True)
    self_ = str(user_id) == user.id
    if self_ and patch.get("active") is False:
        raise HTTPException(409, "You can’t deactivate yourself.")
    changes, sets, vals = [], [], []
    if "name" in patch:
        name = _clean(patch["name"], 120)
        if not name:
            raise HTTPException(422, "Enter their name.")
        if name != before["name"]:
            sets.append("name"); vals.append(name); changes.append(f"name → {name}")
    if "title" in patch:
        title = _clean(patch["title"], 80)
        if title != before["title"]:
            sets.append("title"); vals.append(title); changes.append(f"job title → {title or 'none'}")
    if patch.get("role") and patch["role"] != before["role"]:
        role = await _role(con, patch["role"])
        if self_ and "manage_users" not in role["permissions"]:
            raise HTTPException(409, "You can’t take away your own access to manage people. Ask another admin.")
        sets.append("role"); vals.append(role["key"]); changes.append(f"role {before['role_name']} → {role['name']}")
    if "active" in patch and patch["active"] is not None and patch["active"] != before["active"]:
        sets.append("active"); vals.append(patch["active"]); changes.append("reactivated" if patch["active"] else "deactivated")
    if sets:
        async with con.transaction():
            await con.execute(f"UPDATE users SET {', '.join(f'{c} = ${i}' for i, c in enumerate(sets, start=2))} WHERE id = $1", user_id, *vals)
            await _guard(con)
            await _audit(con, f"{before['name']}: {', '.join(changes)}.", user)
    return dict(await con.fetchrow(_USERS + " WHERE u.id = $1", user_id))


# ── Roles ─────────────────────────────────────────────────────────────

async def _roles(con: asyncpg.Connection) -> dict:
    rows = await con.fetch(
        "SELECT r.key, r.name, r.description, r.permissions, r.system, r.position, "
        "(SELECT count(*) FROM users u WHERE u.role = r.key AND u.active) AS members "
        "FROM roles r ORDER BY r.position, r.name")
    return {"permissions": access.PERMISSIONS, "roles": [dict(r) for r in rows]}


@router.get("/roles")
async def roles(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    return await _roles(con)


class RoleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    description: str = ""
    permissions: list[str] = []


class RolePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[list[str]] = None


def _perms(perms: list[str]) -> list[str]:
    unknown = set(perms) - set(access.KEYS)
    if unknown:
        raise HTTPException(422, f"Unknown permission: {', '.join(sorted(unknown))}.")
    return [k for k in access.KEYS if k in perms]


def _role_name(v: Optional[str]) -> str:
    name = _clean(v, 40)
    if not name or len(name) < 2:
        raise HTTPException(422, "Give the role a name (2 to 40 characters).")
    return name


@router.post("/roles", status_code=201)
async def create_role(body: RoleIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(manage_users)):
    name = _role_name(body.name)
    base = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "role"
    if not base[0].isalpha():
        base = "r_" + base
    key, n = base[:36], 2
    while await con.fetchval("SELECT 1 FROM roles WHERE key = $1", key):
        key, n = f"{base[:33]}_{n}", n + 1
    if await con.fetchval("SELECT 1 FROM roles WHERE lower(name) = lower($1)", name):
        raise HTTPException(409, f"There’s already a role called {name}.")
    perms = _perms(body.permissions)
    async with con.transaction():
        await con.execute(
            "INSERT INTO roles(key, name, description, permissions, position) VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM roles))",
            key, name, _clean(body.description, 200) or "", perms)
        await _audit(con, f"Created role {name}" + (f" with: {', '.join(access.LABEL[p] for p in perms)}." if perms else " with no extra permissions."), user)
    return await _roles(con)


@router.patch("/roles/{key}")
async def update_role(key: str, body: RolePatch, con: asyncpg.Connection = Depends(get_con), user: User = Depends(manage_users)):
    r = await con.fetchrow("SELECT * FROM roles WHERE key = $1", key)
    if r is None:
        raise HTTPException(404, "Role not found.")
    patch = body.model_dump(exclude_unset=True)
    changes, sets, vals = [], [], []
    if patch.get("name") is not None:
        name = _role_name(patch["name"])
        if name != r["name"]:
            if await con.fetchval("SELECT 1 FROM roles WHERE lower(name) = lower($1) AND key <> $2", name, key):
                raise HTTPException(409, f"There’s already a role called {name}.")
            sets.append("name"); vals.append(name); changes.append(f"renamed to {name}")
    if patch.get("description") is not None:
        sets.append("description"); vals.append(_clean(patch["description"], 200) or "")
    if patch.get("permissions") is not None:
        perms = _perms(patch["permissions"])
        if key == "admin" and perms != access.KEYS:
            raise HTTPException(409, "The Admin role always has every permission.")
        added = [access.LABEL[p] for p in perms if p not in r["permissions"]]
        removed = [access.LABEL[p] for p in r["permissions"] if p not in perms and p in access.LABEL]
        if added or removed:
            sets.append("permissions"); vals.append(perms)
            changes += ([f"added {', '.join(added)}"] if added else []) + ([f"removed {', '.join(removed)}"] if removed else [])
    if sets:
        async with con.transaction():
            await con.execute(f"UPDATE roles SET {', '.join(f'{c} = ${i}' for i, c in enumerate(sets, start=2))}, updated_at = now() WHERE key = $1", key, *vals)
            await _guard(con)
            if changes:
                await _audit(con, f"Role {r['name']}: {'; '.join(changes)}.", user)
    return await _roles(con)


@router.delete("/roles/{key}")
async def delete_role(key: str, reassign_to: Optional[str] = None, con: asyncpg.Connection = Depends(get_con),
                      user: User = Depends(manage_users)):
    r = await con.fetchrow("SELECT * FROM roles WHERE key = $1", key)
    if r is None:
        raise HTTPException(404, "Role not found.")
    if r["system"]:
        raise HTTPException(409, f"{r['name']} is built in and can’t be deleted.")
    members = await con.fetchval("SELECT count(*) FROM users WHERE role = $1", key)
    async with con.transaction():
        if members:
            if not reassign_to or reassign_to == key:
                raise HTTPException(409, f"{members} {'person has' if members == 1 else 'people have'} this role. Choose a role to move them to.")
            target = await _role(con, reassign_to)
            await con.execute("UPDATE users SET role = $2 WHERE role = $1", key, target["key"])
        await con.execute("DELETE FROM roles WHERE key = $1", key)
        await _guard(con)
        await _audit(con, f"Deleted role {r['name']}" + (f"; moved {members} to {target['name']}." if members else "."), user)
    return await _roles(con)
