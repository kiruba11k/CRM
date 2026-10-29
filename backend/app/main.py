"""
backend/app/main.py - LeadStrategus CRM API.

Run locally:  uvicorn app.main:app --reload --port 8100   (from backend)
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from .config import get_settings
from .db import create_pool, migrate
from .routers import accounts, actions, admin, calendar, hubspot_import, opportunities, prospects, reports


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.dev_auth:
        logger.warning("CRM_DEV_AUTH is ON: X-Dev-User headers are trusted. Never use this in production.")
    app.state.pool = await create_pool(settings.database_url)
    await migrate(app.state.pool)
    await hubspot_import.mark_interrupted(app.state.pool)
    app.state.import_tasks = set()
    yield
    for task in app.state.import_tasks:
        task.cancel()
    if getattr(app.state, "google", None) is not None:
        await app.state.google.aclose()
        app.state.google = None
    await app.state.pool.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="LeadStrategus CRM API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
    for r in (accounts, prospects, opportunities, actions, reports, admin, hubspot_import, calendar):
        app.include_router(r.router, prefix="/api")

    @app.get("/health", tags=["health"])
    async def health():
        async with app.state.pool.acquire() as con:
            await con.fetchval("SELECT 1")
        return {"status": "ok"}

    return app


app = create_app()
