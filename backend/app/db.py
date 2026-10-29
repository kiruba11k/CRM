"""
backend/app/db.py - asyncpg pool and a tiny forward-only migration runner.

Unlike the public site's optional tracking store, the CRM cannot run
without its database, so a missing DATABASE_URL is a startup error.
Migrations are plain .sql files in app/migrations, applied in name order
inside a transaction and recorded in schema_migrations.
"""
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg
from loguru import logger

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


# libpq-only options that asyncpg would otherwise send as server settings.
# Neon's copy-paste connection string includes channel_binding=require.
_LIBPQ_ONLY = {"channel_binding"}


def normalise_dsn(url: str) -> str:
    url = url.replace("postgresql+asyncpg://", "postgresql://", 1)
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k not in _LIBPQ_ONLY]
    return urlunsplit(parts._replace(query=urlencode(query)))


def is_pooled(url: str) -> bool:
    """Neon's pooled endpoint (PgBouncer, transaction mode) has `-pooler` in the host."""
    return "-pooler." in (urlsplit(url).hostname or "")


async def create_pool(database_url: str) -> asyncpg.Pool:
    if not database_url:
        raise RuntimeError("CRM_DATABASE_URL is not set")
    return await asyncpg.create_pool(
        normalise_dsn(database_url), min_size=0, max_size=5, command_timeout=30,
        # Neon idle-suspends; recycle connections before that kills them.
        max_inactive_connection_lifetime=120,
        # PgBouncer in transaction mode can't keep prepared statements.
        statement_cache_size=0 if is_pooled(database_url) else 100,
    )


async def migrate(pool: asyncpg.Pool) -> list[str]:
    applied_now: list[str] = []
    async with pool.acquire() as con:
        # One transaction with a transaction-scoped lock: serialises workers
        # starting at once, and works through Neon's transaction pooler too.
        async with con.transaction():
            await con.execute("SELECT pg_advisory_xact_lock(727274)")
            await con.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            done = {r["name"] for r in await con.fetch("SELECT name FROM schema_migrations")}
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                if path.name in done:
                    continue
                await con.execute(path.read_text())
                await con.execute("INSERT INTO schema_migrations(name) VALUES ($1)", path.name)
                applied_now.append(path.name)
                logger.info(f"Applied migration {path.name}")
    return applied_now
