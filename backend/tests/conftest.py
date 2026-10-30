"""
API tests run against a real Postgres. Point CRM_TEST_DATABASE_URL at a
throwaway database (its public schema is dropped and recreated), e.g.

    CRM_TEST_DATABASE_URL=postgresql://crm:crm@localhost/crm_test pytest

Without it the API tests are skipped and only the pure rule tests run.
"""
import asyncio
import os

import asyncpg
import pytest

from app.db import normalise_dsn

TEST_DB = os.environ.get("CRM_TEST_DATABASE_URL", "")
RAW_DB = normalise_dsn(TEST_DB) if TEST_DB else ""
ADMIN = "admin@leadstrategus.com"
MANAGER = "manager@leadstrategus.com"
REP = "rep@leadstrategus.com"
REP2 = "rep2@leadstrategus.com"


def _run(coro):
    return asyncio.run(coro)


async def _reset_schema():
    con = await asyncpg.connect(RAW_DB)
    try:
        await con.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    finally:
        await con.close()


async def _truncate():
    con = await asyncpg.connect(RAW_DB)
    try:
        await con.execute(
            "TRUNCATE email_threads, settings_changes, launch_checklist, app_settings, list_options, calendar_sync_log, meetings, calendar_connections, booking_links, import_runs, record_history, activities, opportunity_team, opportunities, prospects, accounts, users RESTART IDENTITY CASCADE"
        )
    finally:
        await con.close()


@pytest.fixture(scope="session")
def app():
    if not TEST_DB:
        pytest.skip("CRM_TEST_DATABASE_URL not set: skipping API tests")
    os.environ.update(
        CRM_DATABASE_URL=TEST_DB, CRM_DEV_AUTH="true", CRM_ADMIN_EMAILS=ADMIN, CRM_ALLOWED_DOMAIN="leadstrategus.com", CRM_HUBSPOT_TOKEN="test-token",
        CRM_GOOGLE_CLIENT_ID="test-client", CRM_GOOGLE_CLIENT_SECRET="test-secret", CRM_PUBLIC_API_URL="http://testserver",
        CRM_TOKEN_KEY="test-token-key", CRM_CONFIG_REFRESH_SECONDS="0"
    )
    from app.config import get_settings

    get_settings.cache_clear()
    _run(_reset_schema())
    from app.main import create_app

    return create_app()


@pytest.fixture()
def client(app):
    from fastapi.testclient import TestClient

    _run(_truncate()) if _tables_exist() else None
    with TestClient(app) as c:
        yield Api(c)
    _run(_truncate())
    from app import domain

    domain.reset_config()


def _tables_exist() -> bool:
    async def check():
        con = await asyncpg.connect(RAW_DB)
        try:
            return await con.fetchval("SELECT to_regclass('public.users') IS NOT NULL")
        finally:
            await con.close()

    return _run(check())


class Api:
    """TestClient wrapper that signs requests in as a given user."""

    def __init__(self, c):
        self.c = c
        self.ids = {}
        for email in (ADMIN, MANAGER, REP, REP2):
            self.ids[email] = self.c.get("/api/me", headers={"X-Dev-User": email}).json()["id"]
        self.patch(f"/api/users/{self.ids[MANAGER]}", {"role": "manager"}, as_=ADMIN)

    def _h(self, as_):
        return {"X-Dev-User": as_}

    def get(self, url, as_=REP, **kw):
        return self.c.get(url, headers=self._h(as_), **kw)

    def post(self, url, body, as_=REP):
        return self.c.post(url, json=body, headers=self._h(as_))

    def patch(self, url, body, as_=REP):
        return self.c.patch(url, json=body, headers=self._h(as_))
