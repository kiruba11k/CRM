"""
backend/app/listconfig.py - keeps domain.py's editable lists, stage
probabilities and reminder settings in sync with the database.

Changes made through this server apply at once. Every request also checks
(at most every `config_refresh_seconds`) whether the settings changed
elsewhere, so several API instances converge within that window.
"""
import json
import time
from typing import Any, Optional

import asyncpg

from . import domain

_state: dict[str, Any] = {"version": None, "checked": 0.0}

_VERSION_SQL = """
SELECT (SELECT count(*) FROM list_options), (SELECT max(updated_at) FROM list_options),
       (SELECT max(updated_at) FROM app_settings)
"""


async def _version(con: asyncpg.Connection) -> tuple:
    return tuple(await con.fetchrow(_VERSION_SQL))


async def seed(con: asyncpg.Connection) -> None:
    """Insert the spec's default options for any list that has none yet."""
    have = {r["list_key"] for r in await con.fetch("SELECT DISTINCT list_key FROM list_options")}
    rows = [(k, v, i) for k, vals in domain.DEFAULT_LISTS.items() if k not in have for i, v in enumerate(vals)]
    if rows:
        await con.executemany(
            "INSERT INTO list_options(list_key, value, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", rows)


async def load(con: asyncpg.Connection) -> None:
    await seed(con)
    lists: dict[str, tuple[list[str], list[str]]] = {k: ([], []) for k in domain.EDITABLE_LISTS}
    for r in await con.fetch("SELECT list_key, value, active FROM list_options ORDER BY list_key, position, value"):
        if r["list_key"] in lists:
            lists[r["list_key"]][0 if r["active"] else 1].append(r["value"])
    settings = {r["key"]: r["value"] for r in await con.fetch("SELECT key, value FROM app_settings")}
    decode = lambda v: json.loads(v) if isinstance(v, str) else (v or {})  # noqa: E731
    domain.apply_config(lists, decode(settings.get("stage_probabilities")), decode(settings.get("reminders")))
    _state["version"] = await _version(con)
    _state["checked"] = time.monotonic()


async def ensure_fresh(con: asyncpg.Connection, max_age: float) -> None:
    if _state["version"] is not None and time.monotonic() - _state["checked"] < max_age:
        return
    _state["checked"] = time.monotonic()
    if await _version(con) != _state["version"]:
        await load(con)


def invalidate() -> None:
    _state["version"] = None


async def save_setting(con: asyncpg.Connection, key: str, value: dict, user_id: Optional[str]) -> None:
    from uuid import UUID

    await con.execute(
        "INSERT INTO app_settings(key, value, updated_by) VALUES ($1, $2::jsonb, $3) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
        key, json.dumps(value), UUID(user_id) if user_id else None)
