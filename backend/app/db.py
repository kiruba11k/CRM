"""
backend/app/db.py - asyncpg pool and a tiny forward-only migration runner.

Unlike the public site's optional tracking store, the CRM cannot run
without its database, so a missing DATABASE_URL is a startup error.
Migrations are plain .sql files in app/migrations, applied in name order
inside a transaction and recorded in schema_migrations.
"""
from pathlib import Path

import asyncpg
from loguru import logger

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def normalise_dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def create_pool(database_url: str) -> asyncpg.Pool:
    if not database_url:
        raise RuntimeError("CRM_DATABASE_URL is not set")
    return await asyncpg.create_pool(
        normalise_dsn(database_url), min_size=0, max_size=5, command_timeout=30,
        # Neon idle-suspends; recycle connections before that kills them.
        max_inactive_connection_lifetime=120,
    )


async def migrate(pool: asyncpg.Pool) -> list[str]:
    applied_now: list[str] = []
    async with pool.acquire() as con:
        await con.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
        # Serialise concurrent workers starting at once.
        await con.execute("SELECT pg_advisory_lock(727274)")
        try:
            done = {r["name"] for r in await con.fetch("SELECT name FROM schema_migrations")}
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                if path.name in done:
                    continue
                async with con.transaction():
                    await con.execute(path.read_text())
                    await con.execute("INSERT INTO schema_migrations(name) VALUES ($1)", path.name)
                applied_now.append(path.name)
                logger.info(f"Applied migration {path.name}")
        finally:
            await con.execute("SELECT pg_advisory_unlock(727274)")
    return applied_now
