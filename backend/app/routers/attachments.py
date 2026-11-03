"""Files and links on deals and accounts.

Uploads (up to MAX_BYTES) are stored in Postgres, which needs no setup but
counts against the database plan; links (Google Drive, Docs, anywhere https)
store nothing. Downloads are always served as attachments with a safe content
type, so a file can never run as a web page inside the CRM.
"""
import re
from typing import Literal, Optional
from urllib.parse import quote
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from ..auth import User, current_user, ensure_can_edit, get_con
from ..records import log_activity

router = APIRouter(prefix="/attachments", tags=["attachments"])
MAX_BYTES = 10 * 1024 * 1024
KINDS = ["Proposal", "Contract", "Statement of work", "Pricing", "Brief", "Presentation", "Other"]
Entity = Literal["opportunity", "account"]
TYPES = {
    "pdf": "application/pdf", "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "csv": "text/csv", "txt": "text/plain", "rtf": "application/rtf", "odt": "application/vnd.oasis.opendocument.text",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "zip": "application/zip", "eml": "message/rfc822", "msg": "application/vnd.ms-outlook",
}
_TABLE = {"opportunity": "opportunities", "account": "accounts"}
_COLS = "a.id, a.entity_type, a.entity_id, a.kind, a.title, a.url, a.filename, a.content_type, a.size_bytes, a.note, a.created_at, a.uploaded_by, u.name AS uploaded_by_name"


async def _owner(con: asyncpg.Connection, entity: str, entity_id: UUID) -> Optional[UUID]:
    row = await con.fetchrow(f"SELECT owner_id FROM {_TABLE[entity]} WHERE id = $1", entity_id)
    if row is None:
        raise HTTPException(404, "Record not found.")
    return row["owner_id"]


def _kind(kind: Optional[str]) -> str:
    if kind and kind not in KINDS:
        raise HTTPException(422, f"Type must be one of: {', '.join(KINDS)}.")
    return kind or "Other"


def _clean_name(name: str) -> str:
    name = re.sub(r"[\x00-\x1f/\\\\]+", "_", (name or "").strip())[:180]
    return name or "file"


async def _one(con: asyncpg.Connection, att_id: UUID) -> dict:
    r = await con.fetchrow(f"SELECT {_COLS} FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.id = $1", att_id)
    if r is None:
        raise HTTPException(404, "Attachment not found.")
    return dict(r)


@router.get("")
async def list_attachments(entity_type: Entity, entity_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    rows = await con.fetch(f"SELECT {_COLS} FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by "
                           "WHERE a.entity_type = $1 AND a.entity_id = $2 ORDER BY a.created_at DESC", entity_type, entity_id)
    return {"kinds": KINDS, "max_bytes": MAX_BYTES, "extensions": sorted(TYPES), "items": [dict(r) for r in rows]}


@router.post("/upload", status_code=201)
async def upload(request: Request, entity_type: Entity, entity_id: UUID, filename: str, kind: Optional[str] = None,
                 note: Optional[str] = None, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Body = the file's raw bytes (application/octet-stream)."""
    ensure_can_edit(user, await _owner(con, entity_type, entity_id))
    name = _clean_name(filename)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in TYPES:
        raise HTTPException(415, f"That file type isn’t allowed. Use one of: {', '.join(sorted(TYPES))}.")
    if int(request.headers.get("content-length") or 0) > MAX_BYTES:
        raise HTTPException(413, "Files can be up to 10 MB. For bigger files, put them in Google Drive and add a link.")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Files can be up to 10 MB. For bigger files, put them in Google Drive and add a link.")
    if not data:
        raise HTTPException(422, "The file is empty.")
    async with con.transaction():
        att_id = await con.fetchval(
            "INSERT INTO attachments(entity_type, entity_id, kind, title, filename, content_type, size_bytes, note, uploaded_by) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
            entity_type, entity_id, _kind(kind), name, name, TYPES[ext], len(data), (note or "").strip()[:300] or None, UUID(user.id))
        await con.execute("INSERT INTO attachment_blobs(attachment_id, content) VALUES ($1, $2)", att_id, bytes(data))
        await log_activity(con, entity_type, entity_id, "attachment", f"Attached {_kind(kind).lower()}: {name}", user.id)
    return await _one(con, att_id)


class LinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity_type: Entity
    entity_id: UUID
    url: str
    title: Optional[str] = None
    kind: Optional[str] = None
    note: Optional[str] = None


def _link_title(url: str) -> str:
    if "docs.google.com/document" in url:
        return "Google Doc"
    if "docs.google.com/spreadsheets" in url:
        return "Google Sheet"
    if "docs.google.com/presentation" in url:
        return "Google Slides"
    if "drive.google.com" in url:
        return "Google Drive file"
    return re.sub(r"^https://(www\.)?", "", url).split("/")[0]


@router.post("/link", status_code=201)
async def add_link(body: LinkIn, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    ensure_can_edit(user, await _owner(con, body.entity_type, body.entity_id))
    url = body.url.strip()
    if not re.match(r"^https://[^\s/]+\.[^\s]+$", url) or len(url) > 2000:
        raise HTTPException(422, "Paste a full https:// link.")
    title = " ".join((body.title or "").split())[:200] or _link_title(url)
    async with con.transaction():
        att_id = await con.fetchval(
            "INSERT INTO attachments(entity_type, entity_id, kind, title, url, note, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            body.entity_type, body.entity_id, _kind(body.kind), title, url, (body.note or "").strip()[:300] or None, UUID(user.id))
        await log_activity(con, body.entity_type, body.entity_id, "attachment", f"Linked {_kind(body.kind).lower()}: {title}", user.id)
    return await _one(con, att_id)


@router.get("/{att_id}/download")
async def download(att_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    r = await con.fetchrow("SELECT a.filename, a.content_type, b.content FROM attachments a JOIN attachment_blobs b ON b.attachment_id = a.id WHERE a.id = $1", att_id)
    if r is None:
        raise HTTPException(404, "File not found.")
    ascii_name = r["filename"].encode("ascii", "replace").decode().replace('"', "'")
    return Response(content=bytes(r["content"]), media_type=r["content_type"] or "application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(r['filename'])}",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "private, no-store"})


@router.delete("/{att_id}")
async def delete(att_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    a = await _one(con, att_id)
    if not (user.can_edit_all or str(a["uploaded_by"]) == user.id):
        ensure_can_edit(user, await _owner(con, a["entity_type"], a["entity_id"]))
    async with con.transaction():
        await con.execute("DELETE FROM attachments WHERE id = $1", att_id)
        await log_activity(con, a["entity_type"], a["entity_id"], "attachment", f"Removed {a['kind'].lower()}: {a['title']}", user.id)
    return {"deleted": True}


@router.get("/usage/summary")
async def usage(con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    r = await con.fetchrow("SELECT count(*) FILTER (WHERE filename IS NOT NULL) AS files, count(*) FILTER (WHERE url IS NOT NULL) AS links, "
                           "COALESCE(sum(size_bytes), 0) AS bytes FROM attachments")
    return {**dict(r), "db_bytes": await con.fetchval("SELECT pg_database_size(current_database())")}
