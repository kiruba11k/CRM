"""HubSpot import (admin only) and the "Needs cleanup" queue (everyone).

The token lives only on the server (CRM_HUBSPOT_TOKEN). Imports run in the
background; the frontend polls the run for progress.
"""
import asyncio
import csv
import io
import json
from typing import Literal, Optional
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import domain, importer
from ..auth import User, current_user, get_con, require_admin
from ..config import Settings, get_settings
from ..hubspot import HubSpot, HubSpotError

router = APIRouter(prefix="/import", tags=["import"])

_RUN_COLS = "id, status, message, started_at, finished_at, options, progress, counts, error_count"


async def mark_interrupted(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as con:
        await con.execute(
            "UPDATE import_runs SET status = 'interrupted', finished_at = now(), message = $1 WHERE status = 'running'",
            "The server restarted during the import. Run it again: records already imported are updated, not duplicated.",
        )


def _client(request: Request, settings: Settings) -> HubSpot:
    if not settings.hubspot_token:
        raise HTTPException(503, "HubSpot isn’t connected yet: add the private-app token as CRM_HUBSPOT_TOKEN on the API server.")
    return HubSpot(settings.hubspot_token, settings.hubspot_base_url, getattr(request.app.state, "hubspot_transport", None))


def _run_out(row: asyncpg.Record, with_errors: bool = False) -> dict:
    out = dict(row)
    for k in ("options", "progress", "counts", "errors"):
        if isinstance(out.get(k), str):
            out[k] = json.loads(out[k])
    if not with_errors:
        out.pop("errors", None)
    return out


@router.get("/hubspot/status")
async def status(con: asyncpg.Connection = Depends(get_con), settings: Settings = Depends(get_settings), user: User = Depends(require_admin)):
    last = await con.fetchrow(f"SELECT {_RUN_COLS} FROM import_runs ORDER BY started_at DESC LIMIT 1")
    return {"configured": bool(settings.hubspot_token), "last_run": _run_out(last) if last else None}


@router.post("/hubspot/test")
async def test_connection(request: Request, settings: Settings = Depends(get_settings), user: User = Depends(require_admin)):
    try:
        async with _client(request, settings) as hs:
            info = await hs.account_info()
            owners = await hs.owners()
    except HubSpotError as e:
        raise HTTPException(502, e.message) from e
    return {
        "portal_id": info.get("portalId"), "ui_domain": info.get("uiDomain"), "currency": info.get("companyCurrency"),
        "time_zone": info.get("timeZone"), "owners": len(owners),
    }


@router.get("/hubspot/summary")
async def summary(request: Request, settings: Settings = Depends(get_settings), user: User = Depends(require_admin)):
    """Record counts per object (None where a scope is missing) and the
    deal pipelines with a suggested stage mapping."""
    try:
        async with _client(request, settings) as hs:
            totals: dict[str, Optional[int]] = {}
            missing: list[str] = []
            for obj in ("companies", "contacts", "deals", "notes", "calls", "meetings", "tasks", "emails"):
                try:
                    totals[obj] = await hs.total(obj)
                except HubSpotError as e:
                    if e.status == 401:
                        raise
                    totals[obj] = None
                    missing.append(obj)
            totals["owners"] = len(await hs.owners())
            pipelines = await hs.deal_pipelines()
    except HubSpotError as e:
        raise HTTPException(502, e.message) from e
    return {
        "totals": totals,
        "missing_scopes": missing,
        "pipelines": [
            {"id": p["id"], "label": p.get("label"), "stages": [
                {"id": s["id"], "label": s.get("label"), "probability": (s.get("metadata") or {}).get("probability"),
                 "closed": str((s.get("metadata") or {}).get("isClosed")).lower() == "true"}
                for s in sorted(p.get("stages", []), key=lambda s: s.get("displayOrder", 0))]}
            for p in pipelines
        ],
        "suggested_stage_map": importer.suggest_stage_map(pipelines),
        "lead_status_map": importer.DEFAULT_LEAD_STATUS_MAP,
    }


class PreviewIn(BaseModel):
    stage_map: dict[str, str] = {}


@router.post("/hubspot/preview")
async def preview(body: PreviewIn, request: Request, con: asyncpg.Connection = Depends(get_con),
                  settings: Settings = Depends(get_settings), user: User = Depends(require_admin)):
    """Data-quality check before import: reads HubSpot, writes nothing."""
    _check_stage_map(body.stage_map)
    try:
        async with _client(request, settings) as hs:
            owners = await hs.owners()
            pipelines = await hs.deal_pipelines()
            companies, contacts, deals, tasks = [], [], [], []
            async for page in hs.objects("companies", importer.COMPANY_PROPS):
                companies.extend(page)
            async for page in hs.objects("contacts", ["hubspot_owner_id"]):
                contacts.extend(page)
            async for page in hs.objects("deals", importer.DEAL_PROPS, ("companies", "contacts")):
                deals.extend(page)
            try:
                async for page in hs.objects("tasks", importer.TASK_PROPS, ("contacts", "deals")):
                    tasks.extend(page)
            except HubSpotError as e:
                if e.status == 401:
                    raise
    except HubSpotError as e:
        raise HTTPException(502, e.message) from e
    users = {r["email"] for r in await con.fetch("SELECT email FROM users")}
    matched = {str(o["id"]) for o in owners
               if (e := (o.get("email") or "").lower()) and (e in users or e.endswith("@" + settings.allowed_domain.lower()))}
    stage_map = {**importer.suggest_stage_map(pipelines), **body.stage_map}
    return {"issues": importer.quality_report(companies, deals, tasks, stage_map, matched, contacts),
            "counts": {"companies": len(companies), "contacts": len(contacts), "deals": len(deals), "tasks": len(tasks)}}


class RunIn(BaseModel):
    objects: list[str] = importer.OBJECT_KEYS
    stage_map: dict[str, str] = {}
    lead_status_map: dict[str, str] = {}


def _check_stage_map(stage_map: dict[str, str]) -> None:
    bad = sorted({v for v in stage_map.values() if v not in domain.STAGE_NAMES})
    if bad:
        raise HTTPException(422, f"Unknown CRM stage(s) in the mapping: {', '.join(bad)}.")


@router.post("/hubspot/runs", status_code=202)
async def start_run(body: RunIn, request: Request, con: asyncpg.Connection = Depends(get_con),
                    settings: Settings = Depends(get_settings), user: User = Depends(require_admin)):
    objects = set(body.objects)
    if not objects or objects - set(importer.OBJECT_KEYS):
        raise HTTPException(422, "Choose what to import: " + ", ".join(importer.OBJECT_KEYS) + ".")
    _check_stage_map(body.stage_map)
    lead_map = {k.upper(): v for k, v in {**importer.DEFAULT_LEAD_STATUS_MAP, **body.lead_status_map}.items()}
    bad = sorted({v for v in lead_map.values() if v not in domain.PROSPECT_STATUSES})
    if bad:
        raise HTTPException(422, f"Unknown prospect status(es) in the mapping: {', '.join(bad)}.")
    hs = _client(request, settings)
    try:
        async with hs:
            pipelines = await hs.deal_pipelines() if "deals" in objects else []
    except HubSpotError as e:
        raise HTTPException(502, e.message) from e
    stage_map = {**importer.suggest_stage_map(pipelines), **body.stage_map}
    options = {"objects": sorted(objects), "stage_map": stage_map, "lead_status_map": lead_map}
    try:
        row = await con.fetchrow(
            f"INSERT INTO import_runs(started_by, options) VALUES ($1, $2::jsonb) RETURNING {_RUN_COLS}",
            UUID(user.id), json.dumps(options))
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, "An import is already running. Wait for it to finish.") from e

    pool = request.app.state.pool
    client = _client(request, settings)
    ctx = importer.Ctx(importer_id=UUID(user.id), allowed_domain=settings.allowed_domain)
    opts = importer.Options(objects=objects, stage_map=stage_map, lead_map=lead_map)

    async def work() -> None:
        async with client:
            await importer.Run(pool, client, row["id"], ctx, opts).execute()

    task = asyncio.create_task(work())
    request.app.state.import_tasks.add(task)
    task.add_done_callback(request.app.state.import_tasks.discard)
    return _run_out(row)


@router.get("/hubspot/runs")
async def list_runs(con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    return [_run_out(r) for r in await con.fetch(f"SELECT {_RUN_COLS} FROM import_runs ORDER BY started_at DESC LIMIT 20")]


@router.get("/hubspot/runs/{run_id}")
async def get_run(run_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    row = await con.fetchrow(f"SELECT {_RUN_COLS}, errors FROM import_runs WHERE id = $1", run_id)
    if row is None:
        raise HTTPException(404, "Import run not found.")
    return _run_out(row, with_errors=True)


@router.get("/hubspot/runs/{run_id}/errors.csv")
async def run_errors_csv(run_id: UUID, con: asyncpg.Connection = Depends(get_con), user: User = Depends(require_admin)):
    errors = await con.fetchval("SELECT errors FROM import_runs WHERE id = $1", run_id)
    if errors is None:
        raise HTTPException(404, "Import run not found.")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["object", "hubspot_id", "message"])
    for e in json.loads(errors) if isinstance(errors, str) else errors:
        w.writerow([e.get("object"), e.get("hubspot_id") or "", e.get("message")])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="hubspot-import-{run_id}.csv"'})


@router.get("/cleanup")
async def cleanup(scope: Literal["mine", "all"] = "mine", con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    """Imported records that still break a CRM rule. Saving a record after
    fixing it removes it from this list."""
    owner = UUID(user.id) if scope == "mine" else None
    rows = await con.fetch(
        """
        SELECT 'account' AS entity, a.id, a.name, NULL::text AS account_name, a.owner_id, u.name AS owner_name, a.cleanup_reasons AS reasons, a.hubspot_id
          FROM accounts a LEFT JOIN users u ON u.id = a.owner_id
         WHERE cardinality(a.cleanup_reasons) > 0 AND ($1::uuid IS NULL OR a.owner_id = $1)
        UNION ALL
        SELECT 'prospect', p.id, p.full_name, ac.name, p.owner_id, u.name, p.cleanup_reasons, p.hubspot_id
          FROM prospects p LEFT JOIN users u ON u.id = p.owner_id LEFT JOIN accounts ac ON ac.id = p.account_id
         WHERE cardinality(p.cleanup_reasons) > 0 AND ($1::uuid IS NULL OR p.owner_id = $1)
        UNION ALL
        SELECT 'opportunity', o.id, o.name, ac.name, o.owner_id, u.name, o.cleanup_reasons, o.hubspot_id
          FROM opportunities o LEFT JOIN users u ON u.id = o.owner_id JOIN accounts ac ON ac.id = o.account_id
         WHERE cardinality(o.cleanup_reasons) > 0 AND ($1::uuid IS NULL OR o.owner_id = $1)
        ORDER BY 1, 3
        """,
        owner,
    )
    return [dict(r) for r in rows]
