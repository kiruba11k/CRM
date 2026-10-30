"""
backend/app/schemas.py - request bodies.

Types are checked here; business rules (what is required at which stage,
nurture, closure, Other ≤ 50 chars) are checked in domain.py on the merged
record, so create and update share one set of rules.

Required *values* are left Optional on purpose: domain.py reports a
missing name or account in the same plain words as every other rule,
instead of a generic "Field required".
"""
from datetime import date, datetime, time
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class _In(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class AccountIn(_In):
    name: Optional[str] = None
    country: Optional[str] = None
    region: Optional[str] = None
    industry: Optional[str] = None
    owner_id: Optional[UUID] = None
    status: str = "Target"
    website: Optional[str] = None
    linkedin_url: Optional[str] = None
    notes: Optional[str] = None


class AccountPatch(_In):
    name: Optional[str] = None
    country: Optional[str] = None
    region: Optional[str] = None
    industry: Optional[str] = None
    owner_id: Optional[UUID] = None
    status: Optional[str] = None
    website: Optional[str] = None
    linkedin_url: Optional[str] = None
    notes: Optional[str] = None


class _ProspectFields(_In):
    account_id: Optional[UUID] = None
    job_title: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    owner_id: Optional[UUID] = None
    disqualified_reason: Optional[str] = None
    source: Optional[str] = None
    next_action_code: Optional[str] = None
    next_action_other: Optional[str] = None
    next_action_due: Optional[date] = None
    next_action_time: Optional[time] = None
    next_action_time_zone: Optional[str] = None
    next_action_in_calendar: bool = False
    notes: Optional[str] = None


class ProspectIn(_ProspectFields):
    full_name: Optional[str] = None
    status: str = "New"


class ProspectPatch(_ProspectFields):
    full_name: Optional[str] = None
    status: Optional[str] = None


class _OpportunityFields(_In):
    primary_contact_id: Optional[UUID] = None
    owner_id: Optional[UUID] = None
    estimated_value: Optional[Decimal] = None
    expected_close: Optional[date] = None
    geography: Optional[str] = None
    service_line: Optional[str] = None
    deal_source: Optional[str] = None
    high_risk_reason: Optional[str] = None
    risk_mitigation: Optional[str] = None
    nurture_reason: Optional[str] = None
    nurture_until: Optional[date] = None
    nurture_owner_id: Optional[UUID] = None
    nurture_next_action_code: Optional[str] = None
    nurture_next_action_other: Optional[str] = None
    next_action_code: Optional[str] = None
    next_action_other: Optional[str] = None
    next_action_due: Optional[date] = None
    next_action_time: Optional[time] = None
    next_action_time_zone: Optional[str] = None
    next_action_in_calendar: bool = False
    proposal_due: Optional[date] = None
    delivery_lead: Optional[str] = None
    effort_estimate: Optional[str] = None
    actual_value: Optional[Decimal] = None
    won_date: Optional[date] = None
    lost_date: Optional[date] = None
    lost_reason: Optional[str] = None
    lost_notes: Optional[str] = None
    database_build_team: Optional[list[UUID]] = None
    proposal_team: Optional[list[UUID]] = None


class OpportunityIn(_OpportunityFields):
    name: Optional[str] = None
    account_id: Optional[UUID] = None
    stage: str = "Lead identified"
    currency: str = "USD"
    risk_rating: str = "Unassessed"
    on_nurture: bool = False


class OpportunityPatch(_OpportunityFields):
    name: Optional[str] = None
    account_id: Optional[UUID] = None
    stage: Optional[str] = None
    currency: Optional[str] = None
    risk_rating: Optional[str] = None
    on_nurture: Optional[bool] = None


class ConvertProspectIn(_In):
    name: Optional[str] = None
    account_id: Optional[UUID] = None
    owner_id: Optional[UUID] = None
    stage: str = "Qualified"
    estimated_value: Optional[Decimal] = None
    currency: str = "USD"
    expected_close: Optional[date] = None
    geography: Optional[str] = None
    service_line: Optional[str] = None
    risk_rating: str = "Unassessed"
    high_risk_reason: Optional[str] = None
    risk_mitigation: Optional[str] = None
    next_action_code: Optional[str] = None
    next_action_other: Optional[str] = None
    next_action_due: Optional[date] = None
    next_action_time: Optional[time] = None
    next_action_time_zone: Optional[str] = None
    next_action_in_calendar: bool = False


class CompleteActionIn(_In):
    """§5.3: completing an action asks for the next one. The next action
    and due date are required, but by domain.py, so the user gets the same
    plain-language errors as everywhere else."""
    note: Optional[str] = None
    next_action_code: Optional[str] = None
    next_action_other: Optional[str] = None
    next_action_due: Optional[date] = None
    next_action_time: Optional[time] = None
    next_action_time_zone: Optional[str] = None
    next_action_in_calendar: bool = False


class RevisitIn(_In):
    """§4.2 revisit outcome: reactivate, extend nurture, or mark lost."""
    outcome: Literal["reactivate", "extend", "lost"]
    next_action_code: Optional[str] = None
    next_action_other: Optional[str] = None
    next_action_due: Optional[date] = None
    next_action_time: Optional[time] = None
    next_action_time_zone: Optional[str] = None
    next_action_in_calendar: bool = False
    nurture_until: Optional[date] = None
    lost_reason: Optional[str] = None
    lost_notes: Optional[str] = None
    lost_date: Optional[date] = None


class NoteIn(_In):
    kind: Literal["note", "call", "meeting", "email"] = "note"
    summary: str


class UserPatch(_In):
    name: Optional[str] = None
    role: Optional[Literal["salesperson", "manager", "admin"]] = None
    active: Optional[bool] = None


class MeetingIn(_In):
    entity_type: Optional[Literal["account", "prospect", "opportunity"]] = None
    entity_id: Optional[UUID] = None
    title: Optional[str] = None
    description: Optional[str] = None
    starts_at: Optional[datetime] = None
    duration_minutes: int = 30
    time_zone: str = "UTC"
    attendees: list[str] = []
    add_meet: bool = True
    # None = the reminder defaults set in Settings → Reminders.
    reminder_15: Optional[bool] = None
    reminder_day: Optional[bool] = None


class MeetingPatch(_In):
    title: Optional[str] = None
    description: Optional[str] = None
    starts_at: Optional[datetime] = None
    duration_minutes: Optional[int] = None
    time_zone: Optional[str] = None
    attendees: Optional[list[str]] = None
    add_meet: Optional[bool] = None
    reminder_15: Optional[bool] = None
    reminder_day: Optional[bool] = None


class BookingLinkIn(_In):
    name: Optional[str] = None
    url: Optional[str] = None


class BookingLinkPatch(_In):
    name: Optional[str] = None
    active: Optional[bool] = None
