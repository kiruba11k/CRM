"""Bulk actions: apply one change to many records at once.

Each record goes through exactly the same path as editing it on its own page
(permissions, validation rules, change history, Calendar/Tasks sync), so a
bulk change can't do anything a single edit couldn't. Records that fail a
rule are skipped and reported with the reason; the rest are saved.
"""
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..auth import User, current_user, get_con
from ..schemas import AccountPatch, OpportunityPatch, ProspectPatch
from .accounts import update_account
from .opportunities import update_opportunity
from .prospects import update_prospect

router = APIRouter(prefix="/bulk", tags=["bulk"])

NEXT_ACTION = {"next_action_code", "next_action_other", "next_action_due"}
ENTITIES: dict[str, dict[str, Any]] = {
    "accounts": {"table": "accounts", "name": "name", "fields": {"owner_id", "status"}, "patch": AccountPatch,
                 "update": lambda id_, p, req, con, user: update_account(id_, p, con, user)},
    "prospects": {"table": "prospects", "name": "full_name", "fields": {"owner_id", "status"} | NEXT_ACTION, "patch": ProspectPatch,
                  "update": update_prospect},
    "opportunities": {"table": "opportunities", "name": "name", "fields": {"owner_id", "stage", "risk_rating"} | NEXT_ACTION,
                      "patch": OpportunityPatch, "update": update_opportunity},
}
MAX = 500


class BulkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[UUID] = Field(min_length=1, max_length=MAX)
    changes: dict[str, Any] = Field(min_length=1)


def _reason(detail: Any) -> str:
    if isinstance(detail, dict):
        errs = [e.get("message", "") for e in detail.get("errors", []) if isinstance(e, dict)]
        return " ".join(errs) or str(detail.get("message", "Couldn’t save."))
    return str(detail)


@router.post("/{entity}")
async def bulk_update(entity: Literal["accounts", "prospects", "opportunities"], body: BulkIn, request: Request,
                      con: asyncpg.Connection = Depends(get_con), user: User = Depends(current_user)):
    spec = ENTITIES[entity]
    bad = set(body.changes) - spec["fields"]
    if bad:
        raise HTTPException(422, f"These can’t be changed in bulk: {', '.join(sorted(bad))}.")
    try:
        patch = spec["patch"](**body.changes)
    except ValidationError as e:
        raise HTTPException(422, "; ".join(err["msg"] for err in e.errors())) from e
    ids = list(dict.fromkeys(body.ids))
    names = {r["id"]: r["n"] for r in await con.fetch(
        f"SELECT id, {spec['name']} AS n FROM {spec['table']} WHERE id = ANY($1::uuid[])", ids)}
    updated, failed = [], []
    for id_ in ids:
        if id_ not in names:
            failed.append({"id": id_, "name": None, "message": "Not found (it may have been deleted)."})
            continue
        try:
            await spec["update"](id_, patch.model_copy(), request, con, user)
            updated.append(id_)
        except HTTPException as e:
            failed.append({"id": id_, "name": names[id_], "message": _reason(e.detail)})
    return {"entity": entity, "requested": len(ids), "updated": len(updated), "updated_ids": updated, "failed": failed}
