"""
backend/app/domain.py - the CRM's business rules, kept free of I/O.

Everything the Lightweight CRM Build Specification v2 says about
controlled lists, required fields and follow-up discipline lives here as
plain data and pure functions, so the rules are unit-tested without a
database and the API layer only has to call validate_*().

Section references (§) point at the spec.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

# ── §5.1 Controlled Next Action list (shared by prospects + opportunities)
NEXT_ACTIONS: dict[str, str] = {
    "01": "Call prospect",
    "02": "Email prospect",
    "03": "LinkedIn outreach",
    "04": "Follow up on unanswered communication",
    "05": "Schedule meeting",
    "06": "Conduct discovery meeting",
    "07": "Prepare / send proposal",
    "08": "Follow up on proposal",
    "09": "Prepare / send pricing or quotation",
    "10": "Commercial negotiation",
    "11": "Follow up on contract / legal",
    "12": "Internal discussion / coordination",
    "13": "Build / enrich target database",
    "14": "Research account / prospect",
    "15": "Request referral / introduction",
    "16": "Reconnect after a specified period",
    "17": "Review nurtured opportunity",
    "18": "Other",
}
OTHER_CODE = "18"
OTHER_MAX_LEN = 50  # §5.2

# ── §3.2 Opportunity stages + starter probabilities (ordered)
STAGES: list[tuple[str, int]] = [
    ("Lead identified", 5),
    ("Qualified", 15),
    ("Discovery / scoping", 25),
    ("Solution design", 40),
    ("Proposal submitted", 55),
    ("Negotiation", 75),
    ("Verbal commitment", 90),
    ("Won", 100),
    ("Lost", 0),
]
STAGE_NAMES = [s for s, _ in STAGES]
STAGE_PROBABILITY = dict(STAGES)
WON, LOST = "Won", "Lost"
CLOSED_STAGES = {WON, LOST}

# ── §3.1 Prospect statuses
PROSPECT_STATUSES = ["New", "Contacted", "Engaged", "Qualified", "Nurture", "Disqualified"]
CLOSED_PROSPECT_STATUSES = {"Disqualified"}

# ── §4.1 Risk ratings
RISK_RATINGS = ["Unassessed", "Low", "Medium", "High"]

# ── Configurable controlled lists (§2, §4.2). Starting values from the
# spec; admins edit them in Settings (app/listconfig.py keeps these lists
# in sync with the database, mutating them in place).
ACCOUNT_STATUSES = ["Target", "Active customer", "Inactive / do not pursue"]
SOURCES = ["Outbound", "Referral", "Event / tradeshow", "Inbound", "Partner", "Other"]
NURTURE_REASONS = [
    "Budget unavailable", "Timing delayed", "No response", "Project postponed",
    "Priority changed", "Decision-maker unavailable", "Other",
]
LOST_REASONS = ["Budget", "Timing", "Chose a competitor", "No decision / went quiet", "Not a fit", "Other"]
SERVICE_LINES = ["LinkedIn lead generation", "Tradeshow pipeline", "GTM intelligence", "Thought leadership"]
CURRENCIES = ["USD", "EUR", "GBP"]
ROLES = ["salesperson", "manager", "admin"]

# §5.4 manager escalation default (business days overdue)
ESCALATION_BUSINESS_DAYS = 3

# Lists admins can edit. Each value here is the *active* list (shown in
# dropdowns); RETIRED holds options hidden from dropdowns that records may
# still carry, so validation accepts both.
EDITABLE_LISTS: dict[str, list[str]] = {
    "sources": SOURCES, "nurture_reasons": NURTURE_REASONS, "lost_reasons": LOST_REASONS,
    "service_lines": SERVICE_LINES, "account_statuses": ACCOUNT_STATUSES, "currencies": CURRENCIES,
}
DEFAULT_LISTS: dict[str, list[str]] = {k: list(v) for k, v in EDITABLE_LISTS.items()}
RETIRED: dict[str, list[str]] = {k: [] for k in EDITABLE_LISTS}
# Values the CRM itself relies on (import fallbacks, column defaults).
PROTECTED: dict[str, set[str]] = {
    "sources": {"Other"}, "nurture_reasons": {"Other"}, "lost_reasons": {"Other"}, "account_statuses": {"Target"},
    "service_lines": set(), "currencies": set(),
}
DEFAULT_PROBABILITIES: dict[str, int] = dict(STAGES)

# §5 reminder settings (admin-editable). Overdue actions and nurture
# revisit reminders are required by the spec, so they aren't switches.
DEFAULT_REMINDERS: dict[str, Any] = {
    "meeting_15": True,         # default for new meetings
    "meeting_day": False,       # default for new meetings
    "due_before": False,        # flag actions due the next business day
    "escalation": True,         # flag overdue actions to managers
    "escalation_days": ESCALATION_BUSINESS_DAYS,
}
REMINDERS: dict[str, Any] = dict(DEFAULT_REMINDERS)


def accepted(key: str) -> list[str]:
    return EDITABLE_LISTS[key] + RETIRED[key]


def apply_config(lists: dict[str, tuple[list[str], list[str]]], probabilities: dict[str, int], reminders: dict[str, Any]) -> None:
    """Swap in admin-edited values without rebinding the module globals."""
    for key, (active, retired) in lists.items():
        EDITABLE_LISTS[key][:] = active
        RETIRED[key][:] = retired
    probs = {**DEFAULT_PROBABILITIES, **probabilities}
    STAGES[:] = [(name, probs[name]) for name, _ in STAGES]
    STAGE_PROBABILITY.clear()
    STAGE_PROBABILITY.update(dict(STAGES))
    REMINDERS.clear()
    REMINDERS.update({**DEFAULT_REMINDERS, **reminders})


def reset_config() -> None:
    apply_config({k: (list(v), []) for k, v in DEFAULT_LISTS.items()}, {}, {})


def stage_index(stage: str) -> int:
    return STAGE_NAMES.index(stage)


def next_action_label(code: Optional[str], other: Optional[str]) -> str:
    if not code:
        return ""
    if code == OTHER_CODE:
        return f"Other: {other or ''}".strip()
    return NEXT_ACTIONS.get(code, "")


def to_decimal(value: Any) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None


def weighted_value(value: Any, stage: str) -> Decimal:
    v = to_decimal(value) or Decimal(0)
    return (v * STAGE_PROBABILITY[stage] / 100).quantize(Decimal("0.01"))


def business_days_between(start: date, end: date) -> int:
    """Weekdays strictly after `start` up to and including `end`."""
    n, d = 0, start
    while d < end:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


# ── Validation ────────────────────────────────────────────────────────
# Each validator takes the full (merged) record as a dict and returns
# (errors, warnings): lists of {"field", "message"}. Errors block a save;
# warnings are review prompts that never change data (§4.1).

Issue = dict[str, str]


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def _check_next_action(
    rec: dict, code_f: str, other_f: str, due_f: Optional[str], required: bool, errors: list[Issue], label: str
) -> None:
    code, other = rec.get(code_f), rec.get(other_f)
    if code and code not in NEXT_ACTIONS:
        errors.append({"field": code_f, "message": f"{label} must be one of the standard Next Action options."})
    if code == OTHER_CODE:
        if _blank(other):
            errors.append({"field": other_f, "message": "Describe the “Other” action (50 characters max)."})
        elif len(other.strip()) > OTHER_MAX_LEN:
            errors.append({"field": other_f, "message": f"“Other” description must be {OTHER_MAX_LEN} characters or fewer."})
    elif not _blank(other):
        errors.append({"field": other_f, "message": "Only fill the “Other” description when the action is Other."})
    if required:
        if not code:
            errors.append({"field": code_f, "message": f"{label} is required."})
        if due_f and not rec.get(due_f):
            errors.append({"field": due_f, "message": f"{label} due date is required."})


def _check_follow_up(rec: dict, errors: list[Issue], open_action: bool) -> None:
    """§6.1: a next action with a time can go into the owner's calendar."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    if not open_action:
        return
    if rec.get("next_action_time") and not rec.get("next_action_due"):
        errors.append({"field": "next_action_time", "message": "Set the due date before adding a time."})
    if rec.get("next_action_in_calendar") and not rec.get("next_action_time"):
        errors.append({"field": "next_action_time", "message": "Add a time to put this follow-up in your calendar."})
    tz = rec.get("next_action_time_zone")
    if tz:
        try:
            ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError):
            errors.append({"field": "next_action_time_zone", "message": "Unknown time zone."})


def validate_account(rec: dict) -> tuple[list[Issue], list[Issue]]:
    errors: list[Issue] = []
    if _blank(rec.get("name")):
        errors.append({"field": "name", "message": "Account / company name is required."})
    if _blank(rec.get("country")):
        errors.append({"field": "country", "message": "Geography (country) is required."})
    if rec.get("status") and rec["status"] not in accepted("account_statuses"):
        errors.append({"field": "status", "message": "Unknown account status."})
    return errors, []


def validate_prospect(rec: dict) -> tuple[list[Issue], list[Issue]]:
    errors: list[Issue] = []
    warnings: list[Issue] = []
    status = rec.get("status") or "New"
    active = status not in CLOSED_PROSPECT_STATUSES
    if _blank(rec.get("full_name")):
        errors.append({"field": "full_name", "message": "Name is required."})
    if status not in PROSPECT_STATUSES:
        errors.append({"field": "status", "message": "Unknown prospect status."})
    if rec.get("source") and rec["source"] not in accepted("sources"):
        errors.append({"field": "source", "message": "Unknown source."})
    if active and not rec.get("owner_id"):
        errors.append({"field": "owner_id", "message": "Owner is required for active prospects."})
    _check_next_action(rec, "next_action_code", "next_action_other", "next_action_due", active, errors, "Next action")
    _check_follow_up(rec, errors, active)
    if active and all(_blank(rec.get(k)) for k in ("email", "phone", "linkedin_url")):
        warnings.append({"field": "email", "message": "Add at least one contact route (email, phone or LinkedIn) before active outreach."})
    if not rec.get("account_id"):
        warnings.append({"field": "account_id", "message": "Not linked to an account yet."})
    return errors, warnings


def validate_opportunity(rec: dict, today: Optional[date] = None) -> tuple[list[Issue], list[Issue]]:
    errors: list[Issue] = []
    warnings: list[Issue] = []
    today = today or date.today()
    stage = rec.get("stage")
    if stage not in STAGE_NAMES:
        return [{"field": "stage", "message": "Unknown sales stage."}], []
    idx = stage_index(stage)
    is_won, is_lost = stage == WON, stage == LOST
    closed = is_won or is_lost
    nurtured = bool(rec.get("on_nurture"))

    def need(field: str, msg: str) -> None:
        if _blank(rec.get(field)):
            errors.append({"field": field, "message": msg})

    need("name", "Opportunity name is required.")
    need("account_id", "Account is required.")
    need("owner_id", "Owner is required for every opportunity.")
    need("geography", "Geography is required.")
    if rec.get("currency") not in accepted("currencies"):
        errors.append({"field": "currency", "message": "Currency must be one of " + ", ".join(CURRENCIES) + "."})
    for f, allowed, label in (
        ("risk_rating", RISK_RATINGS, "risk rating"),
        ("service_line", accepted("service_lines"), "service line"),
        ("deal_source", accepted("sources"), "deal source"),
        ("lost_reason", accepted("lost_reasons"), "lost reason"),
        ("nurture_reason", accepted("nurture_reasons"), "nurture reason"),
    ):
        if rec.get(f) and rec[f] not in allowed:
            errors.append({"field": f, "message": f"Unknown {label}."})

    qualified_plus = idx >= stage_index("Qualified") and not is_lost
    value = to_decimal(rec.get("estimated_value"))
    if rec.get("estimated_value") not in (None, "") and value is None:
        errors.append({"field": "estimated_value", "message": "Estimated deal value must be a number."})
    if qualified_plus and not (value and value > 0):
        errors.append({"field": "estimated_value", "message": "Estimated deal value is required from Qualified."})
    risk = rec.get("risk_rating") or "Unassessed"
    if qualified_plus and risk == "Unassessed":
        errors.append({"field": "risk_rating", "message": "Risk rating must be Low, Medium or High from Qualified."})
    if risk == "High":
        need("high_risk_reason", "High risk needs a reason.")
        need("risk_mitigation", "High risk needs a mitigation / next action.")
    if idx >= stage_index("Solution design") and not closed:
        need("expected_close", "Expected close date is required from Solution design.")
    if stage == "Proposal submitted":
        need("proposal_due", "Proposal date is required once a proposal is submitted.")
    if is_won:
        actual = to_decimal(rec.get("actual_value"))
        if not (actual and actual > 0):
            errors.append({"field": "actual_value", "message": "Won needs the actual contract value."})
        need("won_date", "Won needs the won date.")
    if is_lost:
        need("lost_reason", "Lost needs a lost reason.")
        need("lost_date", "Lost needs the lost date.")

    if nurtured and closed:
        errors.append({"field": "on_nurture", "message": "Won and Lost opportunities can’t be put on nurture."})
    if nurtured and not closed:
        need("nurture_reason", "Nurture reason is required.")
        need("nurture_until", "Nurture-until (revisit) date is required.")
        _check_next_action(rec, "nurture_next_action_code", "nurture_next_action_other", None, True, errors, "Nurture next action")
    else:
        _check_next_action(rec, "nurture_next_action_code", "nurture_next_action_other", None, False, errors, "Nurture next action")

    _check_next_action(rec, "next_action_code", "next_action_other", "next_action_due", not closed and not nurtured, errors, "Next action")
    _check_follow_up(rec, errors, not closed and not nurtured)

    # Review prompts (§4.1): flag, never overwrite the human-set rating.
    if idx >= stage_index("Qualified") and not closed and not rec.get("primary_contact_id"):
        warnings.append({"field": "primary_contact_id", "message": "A primary contact is recommended from Qualified."})
    due = rec.get("next_action_due")
    if not closed and not nurtured and isinstance(due, date) and due < today:
        warnings.append({"field": "next_action_due", "message": "Next action is overdue."})
    close = rec.get("expected_close")
    if not closed and isinstance(close, date) and close < today:
        warnings.append({"field": "expected_close", "message": "Expected close date has passed: review the date or stage."})
    return errors, warnings


NEXT_ACTION_FIELDS = ("next_action_code", "next_action_other", "next_action_due", "next_action_time", "next_action_time_zone")


def next_action_title(code: Optional[str], other: Optional[str]) -> str:
    """The action part of “[Account] — [Action]”: Other's own words, else the label."""
    if code == OTHER_CODE:
        return (other or "").strip() or "Follow-up"
    return NEXT_ACTIONS.get(code or "", "") or "Follow-up"


def normalise_closed_opportunity(rec: dict) -> dict:
    """§5.3: Won/Lost records stop open-record reminders, so clear the
    open next action on closure (history keeps what it was)."""
    if rec.get("stage") in CLOSED_STAGES:
        rec = {**rec, **{f: None for f in NEXT_ACTION_FIELDS}, "next_action_in_calendar": False}
    return rec


def account_name_key(name: str) -> str:
    """Normalised name for duplicate checks: lower-case, no punctuation,
    common company suffixes dropped (`Norvale Pharma Ltd.` == `norvale pharma`)."""
    import re

    key = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower())
    words = [w for w in key.split() if w not in {"ltd", "limited", "inc", "llc", "gmbh", "plc", "co", "corp", "the", "sa", "srl", "bv", "ag"}]
    return " ".join(words)


def lists_payload() -> dict:
    return {
        "next_actions": [{"code": c, "label": l} for c, l in NEXT_ACTIONS.items()],
        "other_code": OTHER_CODE,
        "other_max_length": OTHER_MAX_LEN,
        "stages": [{"name": s, "probability": p} for s, p in STAGES],
        "prospect_statuses": PROSPECT_STATUSES,
        "risk_ratings": RISK_RATINGS,
        "account_statuses": ACCOUNT_STATUSES,
        "sources": SOURCES,
        "nurture_reasons": NURTURE_REASONS,
        "lost_reasons": LOST_REASONS,
        "service_lines": SERVICE_LINES,
        "currencies": CURRENCIES,
        "roles": ROLES,
        "retired": {k: list(v) for k, v in RETIRED.items()},
        "reminders": dict(REMINDERS),
    }
