"""Custom properties (CRM review P2): admins add fields to companies, contacts
and deals; values live in custom_values, one row per filled-in field."""
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional
from uuid import UUID

import asyncpg
from fastapi import HTTPException

TYPES = ("text", "number", "date", "select", "checkbox")
TABLE = {"accounts": "accounts", "prospects": "prospects", "opportunities": "opportunities"}


def canonical(field: dict, value: Any) -> Optional[str]:
    """The stored text for a value, None to clear it; raises ValueError if it doesn't fit the type."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    t = field["type"]
    if t == "text":
        s = str(value).strip()
        if len(s) > 500:
            raise ValueError("Keep it under 500 characters.")
        return s
    if t == "number":
        try:
            n = Decimal(str(value).replace(",", "").strip())
        except InvalidOperation as e:
            raise ValueError("Enter a number.") from e
        if not n.is_finite():
            raise ValueError("Enter a number.")
        return format(n.normalize(), "f")
    if t == "date":
        try:
            return date.fromisoformat(str(value)[:10]).isoformat()
        except ValueError as e:
            raise ValueError("Enter a date.") from e
    if t == "select":
        s = str(value)
        if s not in field["options"]:
            raise ValueError("Choose one of the listed options.")
        return s
    if t == "checkbox":
        if isinstance(value, bool):
            return "true" if value else None
        if str(value).lower() in ("true", "yes", "1"):
            return "true"
        if str(value).lower() in ("false", "no", "0"):
            return None
        raise ValueError("Tick or untick it.")
    raise ValueError("Unknown field type.")


def typed(field_type: str, text: str) -> Any:
    if field_type == "number":
        return float(text) if "." in text else int(text)
    if field_type == "checkbox":
        return text == "true"
    return text


async def fields(con: asyncpg.Connection, entity: str, include_inactive: bool = False) -> list[dict]:
    rows = await con.fetch(
        "SELECT id, entity, key, label, type, options, position, active FROM custom_fields "
        "WHERE entity = $1 AND (active OR $2) ORDER BY position, created_at", entity, include_inactive)
    return [dict(r) for r in rows]


async def values(con: asyncpg.Connection, entity: str, record_ids: Optional[list[UUID]] = None) -> dict[str, dict[str, Any]]:
    """{record_id: {key: value}} for active fields."""
    rows = await con.fetch(
        "SELECT v.record_id, f.key, f.type, v.value FROM custom_values v JOIN custom_fields f ON f.id = v.field_id "
        "WHERE f.entity = $1 AND f.active AND ($2::uuid[] IS NULL OR v.record_id = ANY($2::uuid[]))", entity, record_ids)
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        out.setdefault(str(r["record_id"]), {})[r["key"]] = typed(r["type"], r["value"])
    return out


async def save(con: asyncpg.Connection, entity: str, record_id: UUID, incoming: dict[str, Any], user_id: str) -> dict[str, Any]:
    defs = {f["key"]: f for f in await fields(con, entity)}
    errors, clean = [], {}
    for key, v in incoming.items():
        f = defs.get(key)
        if f is None:
            errors.append({"field": f"custom.{key}", "message": "This field no longer exists."})
            continue
        try:
            clean[key] = canonical(f, v)
        except ValueError as e:
            errors.append({"field": f"custom.{key}", "message": f"{f['label']}: {e}"})
    if errors:
        raise HTTPException(422, {"message": "Fix the highlighted fields before saving.", "errors": errors})
    for key, text in clean.items():
        if text is None:
            await con.execute("DELETE FROM custom_values WHERE field_id = $1 AND record_id = $2", defs[key]["id"], record_id)
        else:
            await con.execute(
                "INSERT INTO custom_values(field_id, record_id, value, updated_by) VALUES ($1, $2, $3, $4) "
                "ON CONFLICT (field_id, record_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
                defs[key]["id"], record_id, text, UUID(user_id))
    return (await values(con, entity, [record_id])).get(str(record_id), {})
