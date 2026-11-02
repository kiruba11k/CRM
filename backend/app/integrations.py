"""Google side effects of saving a prospect or opportunity: the calendar
follow-up (§6.1) and the Google Tasks to-do (§6.3). Both run after the
record is committed and never fail the save."""
from uuid import UUID

import asyncpg
from fastapi import Request

from . import followups, tasksync


async def after_save(request: Request, con: asyncpg.Connection, entity_type: str, entity_id: UUID, completed: bool = False) -> None:
    await followups.reconcile(request, con, entity_type, entity_id)
    await tasksync.reconcile(request, con, entity_type, entity_id, completed=completed)
