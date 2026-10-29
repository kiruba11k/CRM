"""
backend/app/auth.py - Google Workspace sign-in and role checks.

The frontend signs the user in with Google Identity Services and sends the
ID token as `Authorization: Bearer <token>`. We verify it against Google's
certificates, require a verified email from the allowed Workspace domain
(`hd` claim), and map it to a CRM user (created on first sign-in).

§8.1 access model (proposed, confirm before production): everyone sees
the shared pipeline; salespeople edit records they own; managers and
admins edit everything; only admins manage users.
"""
from dataclasses import dataclass
from typing import Optional

import asyncpg
from fastapi import Depends, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from loguru import logger

from . import listconfig
from .config import Settings, get_settings


@dataclass
class User:
    id: str
    email: str
    name: str
    role: str

    @property
    def can_edit_all(self) -> bool:
        return self.role in ("manager", "admin")


def _verify_google_token(token: str, settings: Settings) -> dict:
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    if not settings.google_client_id:
        raise HTTPException(503, "Google sign-in is not configured (CRM_GOOGLE_CLIENT_ID).")
    try:
        info = id_token.verify_oauth2_token(token, google_requests.Request(), settings.google_client_id)
    except ValueError as e:
        raise HTTPException(401, f"Invalid Google token: {e}") from e
    if not info.get("email_verified"):
        raise HTTPException(401, "Google email is not verified.")
    if (info.get("hd") or "").lower() != settings.allowed_domain.lower():
        raise HTTPException(403, f"Only {settings.allowed_domain} accounts can use the CRM.")
    return info


async def _upsert_user(con: asyncpg.Connection, email: str, name: str, settings: Settings) -> User:
    email = email.lower()
    row = await con.fetchrow("SELECT id, email, name, role, active FROM users WHERE email = $1", email)
    if row is None:
        role = "admin" if email in settings.admin_email_set else "salesperson"
        row = await con.fetchrow(
            "INSERT INTO users(email, name, role) VALUES ($1, $2, $3) "
            "ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email, name, role, active",
            email, name or email.split("@")[0], role,
        )
        logger.info(f"New CRM user {email} ({row['role']})")
    if not row["active"]:
        raise HTTPException(403, "Your CRM access has been disabled.")
    return User(id=str(row["id"]), email=row["email"], name=row["name"], role=row["role"])


async def get_con(request: Request):
    async with request.app.state.pool.acquire() as con:
        yield con


async def current_user(
    con: asyncpg.Connection = Depends(get_con),
    authorization: Optional[str] = Header(default=None),
    x_dev_user: Optional[str] = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> User:
    if settings.dev_auth and x_dev_user:
        email = x_dev_user.strip().lower()
        if not email.endswith("@" + settings.allowed_domain.lower()):
            raise HTTPException(403, f"Only {settings.allowed_domain} accounts can use the CRM.")
        user = await _upsert_user(con, email, "", settings)
    else:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Sign in with your Google Workspace account.")
        info = await run_in_threadpool(_verify_google_token, authorization[7:].strip(), settings)
        user = await _upsert_user(con, info["email"], info.get("name", ""), settings)
    # Pick up list / reminder changes made by another API instance.
    await listconfig.ensure_fresh(con, settings.config_refresh_seconds)
    return user


def ensure_can_edit(user: User, owner_id: Optional[str]) -> None:
    """Unowned records (e.g. an account nobody works yet) are open to all."""
    if user.can_edit_all or owner_id is None or str(owner_id) == user.id:
        return
    raise HTTPException(403, "You can only edit records you own. Ask a manager to reassign it.")


def ensure_can_assign(user: User, new_owner_id: Optional[str]) -> None:
    """Salespeople may only assign records to themselves."""
    if new_owner_id is None or user.can_edit_all or str(new_owner_id) == user.id:
        return
    raise HTTPException(403, "Only managers and admins can assign records to someone else.")


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Admins only.")
    return user
