"""§6.2 Gmail thread links.

A user pastes the link of a Gmail thread onto an account, prospect or
opportunity. The CRM keeps the thread reference from that link, the link,
the user's label, and who linked it when. It reads nothing from Gmail and
needs no Gmail permission: opening the link shows the thread to whoever
already has access to it in Gmail.
"""
import re
from typing import Literal, Optional
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from ..auth import User, current_user, ensure_can_edit, get_con
from ..records import log_activity, raise_if_errors

router = APIRouter(prefix="/email-threads", tags=["gmail"])

_TABLE = {"account": "accounts", "prospect": "prospects", "opportunity": "opportunities"}
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def gmail_thread_ref(url: str) -> Optional[str]:
    """Thread reference from a Gmail link, or None if it isn't one.

    Accepts the address-bar form (…/mail/u/0/#inbox/FMfcgz…, #all/18c2…,
    #label/Clients/…, #search/q/…) and permalinks carrying th= or
    permthid=thread-f:…."""
    url = (url or "").strip()
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "mail.google.com":
        return None
    query = parse_qs(parts.query)
    for key in ("permthid", "th"):
        if query.get(key):
            ref = query[key][0]
            ref = ref.split(":", 1)[1] if ref.startswith("thread-") else ref
            return ref if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", ref) else None
    last = parts.fragment.split("?")[0].rstrip("/").split("/")[-1] if parts.fragment else ""
    return last if _TOKEN.match(last) and "/" in parts.fragment else None


class ThreadIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    entity_type: Literal["account", "prospect", "opportunity"]
    entity_id: UUID
    url: Optional[str] = None
    label: Optional[str] = None


async def _record_owner(con: asyncpg.Connection, entity_type: str, entity_id: UUID):
    row = await con.fetchrow(f"SELECT owner_id FROM {_TABLE[entity_type]} WHERE id = $1", entity_id)
    if row is None:
        raise HTTPException(404, "Record not found.")
    return row["owner_id"]


_SQL = ("SELECT t.id, t.entity_type, t.entity_id, t.thread_ref, t.url, t.label, t.linked_at, t.linked_by, u.name AS linked_by_name "
        "FROM email_threads t LEFT JOIN users u ON u.id = t.linked_by")


@router.get("")
async def list_threads(entity_type: Literal["account", "prospect", "opportunity"], entity_id: UUID,
                       con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(_SQL + " WHERE t.entity_type = $1 AND t.entity_id = $2 ORDER BY t.linked_at DESC", entity_type, entity_id)
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def link_thread(body: ThreadIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    ensure_can_edit(user, await _record_owner(con, body.entity_type, body.entity_id))
    errors = []
    ref = gmail_thread_ref(body.url or "")
    if ref is None:
        errors.append({"field": "url", "message": "Paste the link of a Gmail thread: open the thread in Gmail and copy the address bar."})
    if not body.label:
        errors.append({"field": "label", "message": "Add a short label, e.g. the email subject."})
    elif len(body.label) > 200:
        errors.append({"field": "label", "message": "Keep the label to 200 characters."})
    raise_if_errors(errors)
    async with con.transaction():
        try:
            tid = await con.fetchval(
                "INSERT INTO email_threads(entity_type, entity_id, thread_ref, url, label, linked_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
                body.entity_type, body.entity_id, ref, body.url, body.label, UUID(user.id))
        except asyncpg.UniqueViolationError as e:
            raise HTTPException(409, "That Gmail thread is already linked to this record.") from e
        await log_activity(con, body.entity_type, body.entity_id, "email", f"Gmail thread linked: {body.label}", user.id)
    return dict(await con.fetchrow(_SQL + " WHERE t.id = $1", tid))


@router.delete("/{thread_id}")
async def unlink_thread(thread_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    t = await con.fetchrow("SELECT * FROM email_threads WHERE id = $1", thread_id)
    if t is None:
        raise HTTPException(404, "Linked thread not found.")
    if not (user.can_edit_all or str(t["linked_by"]) == user.id):
        raise HTTPException(403, "Only the person who linked this thread, a manager or an admin can remove it.")
    async with con.transaction():
        await con.execute("DELETE FROM email_threads WHERE id = $1", thread_id)
        await log_activity(con, t["entity_type"], t["entity_id"], "email", f"Gmail thread unlinked: {t['label']}", user.id)
    return {"ok": True}
