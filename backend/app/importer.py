"""
backend/app/importer.py - HubSpot → CRM import.

Order: owners → companies (accounts) → contacts (prospects) → deals
(opportunities) → notes, calls, meetings, tasks and logged emails
(activity timeline). Every record keeps its HubSpot ID, so the import can
be re-run: records the import created are refreshed from HubSpot, while
records someone has edited in the CRM since (and records that existed in
the CRM before the import) are kept as they are.

Records that break a CRM rule are still imported, with the reasons stored
in `cleanup_reasons` (the "Needs cleanup" view), never dropped or silently
"fixed". The mapping functions are pure so they are unit-tested directly.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional
from uuid import UUID

import asyncpg
from loguru import logger

from . import domain
from .hubspot import HubSpot, HubSpotError

OBJECT_KEYS = ["owners", "companies", "contacts", "deals", "associations", "activity", "emails"]

# HubSpot's default sales pipeline stage IDs → CRM stages.
DEFAULT_STAGE_MAP = {
    "appointmentscheduled": "Discovery / scoping", "qualifiedtobuy": "Qualified",
    "presentationscheduled": "Solution design", "decisionmakerboughtin": "Negotiation",
    "contractsent": "Verbal commitment", "closedwon": "Won", "closedlost": "Lost",
}
DEFAULT_LEAD_STATUS_MAP = {
    "NEW": "New", "OPEN": "New", "ATTEMPTED_TO_CONTACT": "Contacted", "CONNECTED": "Engaged",
    "IN_PROGRESS": "Engaged", "OPEN_DEAL": "Qualified", "BAD_TIMING": "Nurture", "UNQUALIFIED": "Disqualified",
}
REVIEW_OTHER = "Review after HubSpot import"
UNASSIGNED_ACCOUNT = "Unassigned (HubSpot import)"
LOST_NOT_RECORDED = "Not recorded (imported)"

NOTE = {
    "owner": "Owner not found in the CRM: assigned to the person who ran the import.",
    "no_next_step": "No open next step in HubSpot: set a real next action and due date.",
    "no_company": f"No company on this deal in HubSpot: linked to “{UNASSIGNED_ACCOUNT}”.",
    "no_country": "Country missing in HubSpot: set the account’s country.",
    "stage_unmapped": "HubSpot stage wasn’t mapped: imported as Lead identified.",
    "lost_no_reason": f"No lost reason in HubSpot: recorded as Other (“{LOST_NOT_RECORDED}”).",
    "duplicate": "Possible duplicate company in HubSpot: another HubSpot company was merged into this account.",
    "unassigned": "Holds HubSpot deals that had no company: move each deal to its real account.",
}

COMPANY_PROPS = ["name", "domain", "website", "country", "state", "industry", "hubspot_owner_id", "lifecyclestage", "linkedin_company_page"]
CONTACT_PROPS = ["firstname", "lastname", "email", "jobtitle", "phone", "mobilephone", "hs_lead_status", "lifecyclestage", "hubspot_owner_id", "hs_analytics_source"]
DEAL_PROPS = ["dealname", "amount", "deal_currency_code", "closedate", "dealstage", "pipeline", "hubspot_owner_id", "closed_lost_reason", "createdate"]
TASK_PROPS = ["hs_task_subject", "hs_task_status", "hs_task_type", "hs_timestamp", "hubspot_owner_id"]
# HubSpot object → (activity kind, properties). Email bodies are never requested.
ENGAGEMENTS = {
    "notes": ("note", ["hs_note_body", "hs_timestamp", "hubspot_owner_id"]),
    "calls": ("call", ["hs_call_title", "hs_call_body", "hs_timestamp", "hubspot_owner_id"]),
    "meetings": ("meeting", ["hs_meeting_title", "hs_meeting_start_time", "hs_timestamp", "hubspot_owner_id"]),
    "tasks": ("task", TASK_PROPS),
    "emails": ("email", ["hs_email_subject", "hs_email_direction", "hs_timestamp", "hubspot_owner_id"]),
}
SOURCE_MAP = {
    "REFERRALS": "Referral", "ORGANIC_SEARCH": "Inbound", "DIRECT_TRAFFIC": "Inbound", "PAID_SEARCH": "Inbound",
    "SOCIAL_MEDIA": "Inbound", "PAID_SOCIAL": "Inbound", "EMAIL_MARKETING": "Inbound", "OTHER_CAMPAIGNS": "Other",
}


# ── Small parsers ─────────────────────────────────────────────────────

def clean(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def parse_dt(v: Any) -> Optional[datetime]:
    s = clean(v)
    if not s:
        return None
    try:
        if s.isdigit():
            return datetime.fromtimestamp(int(s) / 1000, tz=timezone.utc)
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_date(v: Any) -> Optional[date]:
    dt = parse_dt(v)
    return dt.date() if dt else None


def strip_html(text: Any, limit: int = 1000) -> str:
    s = re.sub(r"<[^>]+>", " ", str(text or ""))
    s = re.sub(r"\s+", " ", html.unescape(s)).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def domain_of(url: Any) -> Optional[str]:
    s = (clean(url) or "").lower()
    s = re.sub(r"^[a-z]+://", "", s)
    s = re.sub(r"^www\.", "", s).split("/")[0].split("?")[0]
    return s or None


def humanize(enum: Any) -> Optional[str]:
    """COMPUTER_SOFTWARE → Computer software."""
    s = clean(enum)
    return s.replace("_", " ").capitalize() if s and s.isupper() else s


def assoc_ids(obj: dict, kind: str) -> list[str]:
    results = ((obj.get("associations") or {}).get(kind) or {}).get("results") or []
    return list(dict.fromkeys(str(r["id"]) for r in results if r.get("id")))


def map_lost_reason(text: Optional[str]) -> tuple[str, Optional[str]]:
    """Free-text HubSpot reason → (CRM lost reason, notes)."""
    t = clean(text)
    if not t:
        return "Other", LOST_NOT_RECORDED
    for r in domain.LOST_REASONS:
        if t.lower() == r.lower():
            return r, None
    low = t.lower()
    for needle, reason in (("budget", "Budget"), ("price", "Budget"), ("timing", "Timing"), ("competitor", "Chose a competitor"),
                           ("no decision", "No decision / went quiet"), ("quiet", "No decision / went quiet"),
                           ("unresponsive", "No decision / went quiet"), ("fit", "Not a fit")):
        if needle in low:
            return reason, t
    return "Other", t


def task_next_action(task: dict, today: date) -> tuple[str, Optional[str], date]:
    p = task.get("properties") or {}
    kind = (clean(p.get("hs_task_type")) or "").upper()
    due = parse_date(p.get("hs_timestamp")) or today
    if kind == "CALL":
        return "01", None, due
    if kind == "EMAIL":
        return "02", None, due
    if kind.startswith("LINKED_IN"):
        return "03", None, due
    return domain.OTHER_CODE, (clean(p.get("hs_task_subject")) or "HubSpot task")[: domain.OTHER_MAX_LEN].strip(), due


def suggest_stage_map(pipelines: list[dict]) -> dict[str, str]:
    """HubSpot stage ID → CRM stage: known defaults, else closed won/lost
    from the stage metadata, else the open stage with the nearest probability."""
    open_stages = [(s, p) for s, p in domain.STAGES if s not in domain.CLOSED_STAGES]
    out: dict[str, str] = {}
    for pipe in pipelines:
        for st in pipe.get("stages", []):
            sid = str(st["id"])
            meta = st.get("metadata") or {}
            try:
                prob = float(meta.get("probability")) * 100
            except (TypeError, ValueError):
                prob = None
            if sid in DEFAULT_STAGE_MAP:
                out[sid] = DEFAULT_STAGE_MAP[sid]
            elif str(meta.get("isClosed")).lower() == "true":
                out[sid] = domain.WON if (prob or 0) >= 100 else domain.LOST
            elif prob is not None:
                out[sid] = min(open_stages, key=lambda sp: abs(sp[1] - prob))[0]
            else:
                out[sid] = "Lead identified"
    return out


# ── Pure mapping: HubSpot object → CRM row + cleanup notes ─────────────

def map_company(c: dict, owner_id: Optional[UUID]) -> tuple[dict, list[str]]:
    p = c.get("properties") or {}
    dom = domain_of(p.get("domain")) or domain_of(p.get("website"))
    name = clean(p.get("name")) or dom or f"HubSpot company {c['id']}"
    notes: list[str] = []
    country = clean(p.get("country"))
    if not country:
        country = "Unknown"
        notes.append(NOTE["no_country"])
    row = {
        "name": name,
        "name_key": domain.account_name_key(name) or f"hubspot company {c['id']}",
        "country": country,
        "region": clean(p.get("state")),
        "industry": humanize(p.get("industry")),
        "owner_id": owner_id,
        "status": "Active customer" if clean(p.get("lifecyclestage")) == "customer" else "Target",
        "website": clean(p.get("website")) or (f"https://{dom}" if dom else None),
        "linkedin_url": clean(p.get("linkedin_company_page")),
    }
    return row, notes


def map_contact(ct: dict, *, account_id: Optional[UUID], owner_id: Optional[UUID], importer_id: UUID, lead_map: dict[str, str], task: Optional[dict], today: date) -> tuple[dict, list[str]]:
    p = ct.get("properties") or {}
    email = (clean(p.get("email")) or "").lower() or None
    name = " ".join(x for x in (clean(p.get("firstname")), clean(p.get("lastname"))) if x) or email or f"HubSpot contact {ct['id']}"
    lead = (clean(p.get("hs_lead_status")) or "").upper()
    status = lead_map.get(lead) or ("Qualified" if clean(p.get("lifecyclestage")) in ("salesqualifiedlead", "opportunity") else "New")
    active = status not in domain.CLOSED_PROSPECT_STATUSES
    notes: list[str] = []
    if owner_id is None and active:
        owner_id = importer_id
        notes.append(NOTE["owner"])
    row: dict[str, Any] = {
        "full_name": name, "account_id": account_id, "job_title": clean(p.get("jobtitle")), "email": email,
        "phone": clean(p.get("phone")) or clean(p.get("mobilephone")), "owner_id": owner_id, "status": status,
        "source": SOURCE_MAP.get((clean(p.get("hs_analytics_source")) or "").upper()),
        "next_action_code": None, "next_action_other": None, "next_action_due": None,
    }
    if active:
        if task:
            row["next_action_code"], row["next_action_other"], row["next_action_due"] = task_next_action(task, today)
        else:
            row["next_action_code"], row["next_action_other"], row["next_action_due"] = domain.OTHER_CODE, REVIEW_OTHER, today
            notes.append(NOTE["no_next_step"])
    errors, _ = domain.validate_prospect(row)
    return row, notes + [e["message"] for e in errors]


def map_deal(d: dict, *, stage: Optional[str], account_id: UUID, country: str, no_company: bool, contact_id: Optional[UUID],
             owner_id: Optional[UUID], importer_id: UUID, default_currency: str, task: Optional[dict], today: date) -> tuple[dict, list[str]]:
    p = d.get("properties") or {}
    notes: list[str] = []
    if stage not in domain.STAGE_NAMES:
        stage = "Lead identified"
        notes.append(NOTE["stage_unmapped"])
    if no_company:
        notes.append(NOTE["no_company"])
    if owner_id is None:
        owner_id = importer_id
        notes.append(NOTE["owner"])
    amount = domain.to_decimal(p.get("amount"))
    close = parse_date(p.get("closedate"))
    row: dict[str, Any] = {
        "name": clean(p.get("dealname")) or f"HubSpot deal {d['id']}",
        "account_id": account_id, "primary_contact_id": contact_id, "owner_id": owner_id, "stage": stage,
        "estimated_value": amount, "currency": (clean(p.get("deal_currency_code")) or default_currency).upper()[:3],
        "geography": country, "risk_rating": "Unassessed",
        "expected_close": None, "actual_value": None, "won_date": None, "lost_date": None, "lost_reason": None, "lost_notes": None,
        "next_action_code": None, "next_action_other": None, "next_action_due": None,
    }
    if stage == domain.WON:
        row["actual_value"], row["won_date"] = amount, close or today
    elif stage == domain.LOST:
        row["lost_date"] = close or parse_date(p.get("createdate")) or today
        row["lost_reason"], row["lost_notes"] = map_lost_reason(p.get("closed_lost_reason"))
        if not clean(p.get("closed_lost_reason")):
            notes.append(NOTE["lost_no_reason"])
    else:
        row["expected_close"] = close
        if task:
            row["next_action_code"], row["next_action_other"], row["next_action_due"] = task_next_action(task, today)
        else:
            row["next_action_code"], row["next_action_other"], row["next_action_due"] = domain.OTHER_CODE, REVIEW_OTHER, today
            notes.append(NOTE["no_next_step"])
    errors, _ = domain.validate_opportunity(row, today)
    return row, notes + [e["message"] for e in errors]


def open_task_index(tasks: list[dict]) -> dict[tuple[str, str], dict]:
    """(“contacts”|“deals”, HubSpot ID) → the earliest open task."""
    out: dict[tuple[str, str], dict] = {}
    for t in tasks:
        p = t.get("properties") or {}
        if (clean(p.get("hs_task_status")) or "").upper() == "COMPLETED":
            continue
        due = parse_dt(p.get("hs_timestamp")) or datetime.max.replace(tzinfo=timezone.utc)
        for kind in ("contacts", "deals"):
            for hid in assoc_ids(t, kind):
                cur = out.get((kind, hid))
                if cur is None or due < (parse_dt(cur["properties"].get("hs_timestamp")) or datetime.max.replace(tzinfo=timezone.utc)):
                    out[(kind, hid)] = t
    return out


def engagement_summary(object_type: str, e: dict) -> tuple[str, Optional[datetime]]:
    p = e.get("properties") or {}
    when = parse_dt(p.get("hs_timestamp")) or parse_dt(p.get("hs_meeting_start_time"))
    if object_type == "notes":
        text = strip_html(p.get("hs_note_body")) or "Note"
    elif object_type == "calls":
        text = " · ".join(x for x in (clean(p.get("hs_call_title")), strip_html(p.get("hs_call_body"))) if x) or "Call"
    elif object_type == "meetings":
        text = clean(p.get("hs_meeting_title")) or "Meeting"
    elif object_type == "tasks":
        text = f"Task ({(clean(p.get('hs_task_status')) or 'open').lower().replace('_', ' ')}): {clean(p.get('hs_task_subject')) or 'untitled'}"
    else:
        direction = "Sent" if "OUTGOING" in (clean(p.get("hs_email_direction")) or "") or (clean(p.get("hs_email_direction")) or "") == "EMAIL" else "Received"
        text = f"{direction} email: {clean(p.get('hs_email_subject')) or '(no subject)'}"
    return f"[HubSpot] {text}", when


# ── Data-quality preview (step 4) ─────────────────────────────────────

def quality_report(companies: list[dict], deals: list[dict], tasks: list[dict], stage_map: dict[str, str],
                   owners_matched: set[str], contacts: list[dict]) -> list[dict]:
    open_tasks = open_task_index(tasks)
    keys: dict[str, set[str]] = {}
    for c in companies:
        p = c.get("properties") or {}
        for k in (domain_of(p.get("domain")) or domain_of(p.get("website")), domain.account_name_key(clean(p.get("name")) or "")):
            if k:
                keys.setdefault(k, set()).add(str(c["id"]))
    dup_ids = set().union(*[ids for ids in keys.values() if len(ids) > 1]) if keys else set()
    counts = {k: 0 for k in ("no_next_step", "qualified_no_amount", "won_no_amount", "lost_no_reason", "duplicate_companies", "risk", "owner", "no_company", "no_country")}
    counts["duplicate_companies"] = len(dup_ids)
    counts["no_country"] = sum(1 for c in companies if not clean((c.get("properties") or {}).get("country")))
    qualified_idx = domain.stage_index("Qualified")
    for d in deals:
        p = d.get("properties") or {}
        stage = stage_map.get(clean(p.get("dealstage")) or "") or "Lead identified"
        amount = domain.to_decimal(p.get("amount"))
        if stage == domain.WON:
            counts["won_no_amount"] += not (amount and amount > 0)
        elif stage == domain.LOST:
            counts["lost_no_reason"] += not clean(p.get("closed_lost_reason"))
        else:
            counts["no_next_step"] += ("deals", str(d["id"])) not in open_tasks
            if domain.stage_index(stage) >= qualified_idx:
                counts["qualified_no_amount"] += not (amount and amount > 0)
                counts["risk"] += 1
        counts["owner"] += (clean(p.get("hubspot_owner_id")) or "") not in owners_matched
        counts["no_company"] += not assoc_ids(d, "companies") and not assoc_ids(d, "contacts")
    counts["owner"] += sum(1 for c in contacts if (clean((c.get("properties") or {}).get("hubspot_owner_id")) or "") not in owners_matched)
    return [
        {"key": "no_next_step", "rule": "Open deals with no next step", "fix": f"Imported with next action “Other: {REVIEW_OTHER}” due on import day, for the owner to set properly", "count": counts["no_next_step"], "severity": "amber"},
        {"key": "qualified_no_amount", "rule": "Qualified+ deals with no amount", "fix": "Flagged: estimated value required from Qualified", "count": counts["qualified_no_amount"], "severity": "amber"},
        {"key": "won_no_amount", "rule": "Closed-won deals with no amount", "fix": "Flagged: actual contract value required", "count": counts["won_no_amount"], "severity": "red"},
        {"key": "lost_no_reason", "rule": "Closed-lost deals with no reason", "fix": f"Lost reason set to Other with the note “{LOST_NOT_RECORDED}”", "count": counts["lost_no_reason"], "severity": "amber"},
        {"key": "duplicate_companies", "rule": "Possible duplicate companies", "fix": "Same domain or near-identical name: merged into one account and flagged", "count": counts["duplicate_companies"], "severity": "red"},
        {"key": "risk", "rule": "Risk rating", "fix": "HubSpot has none: imported as Unassessed; open Qualified+ deals flagged for review", "count": counts["risk"], "severity": "amber"},
        {"key": "owner", "rule": "No owner, or owner not matched to a CRM user", "fix": "Assigned to you (the person running the import) and flagged", "count": counts["owner"], "severity": "amber"},
        {"key": "no_company", "rule": "Deals with no company or contact", "fix": f"Linked to “{UNASSIGNED_ACCOUNT}” and flagged", "count": counts["no_company"], "severity": "amber"},
        {"key": "no_country", "rule": "Companies with no country", "fix": "Country set to “Unknown” and flagged", "count": counts["no_country"], "severity": "amber"},
    ]


# ── The import run ────────────────────────────────────────────────────

@dataclass
class Options:
    objects: set[str]
    stage_map: dict[str, str]
    lead_map: dict[str, str]


@dataclass
class Ctx:
    importer_id: UUID
    allowed_domain: str
    today: date = field(default_factory=date.today)
    currency: str = "USD"
    owners: dict[str, UUID] = field(default_factory=dict)
    accounts: dict[str, tuple[UUID, str]] = field(default_factory=dict)
    contacts: dict[str, tuple[UUID, Optional[UUID]]] = field(default_factory=dict)
    deals: dict[str, UUID] = field(default_factory=dict)
    tasks: list[dict] = field(default_factory=list)
    open_tasks: dict[tuple[str, str], dict] = field(default_factory=dict)
    unassigned: Optional[tuple[UUID, str]] = None
    # Company domain → (account ID, country, HubSpot ID) seen in this run, so
    # duplicates merge even when the CRM account has no website of its own.
    domains: dict[str, tuple[UUID, str, str]] = field(default_factory=dict)


class Run:
    MAX_ERRORS = 1000

    def __init__(self, pool: asyncpg.Pool, hs: HubSpot, run_id: UUID, ctx: Ctx, opts: Options):
        self.pool, self.hs, self.id, self.ctx, self.opts = pool, hs, run_id, ctx, opts
        self.progress: dict[str, dict] = {}
        self.counts: dict[str, dict[str, int]] = {}
        self.errors: list[dict] = []
        self.error_count = 0

    # bookkeeping
    def count(self, entity: str, outcome: str) -> None:
        c = self.counts.setdefault(entity, {"created": 0, "updated": 0, "kept": 0, "merged": 0, "failed": 0})
        c[outcome] = c.get(outcome, 0) + 1

    def error(self, obj: str, hubspot_id: Optional[str], message: str) -> None:
        self.error_count += 1
        if len(self.errors) < self.MAX_ERRORS:
            self.errors.append({"object": obj, "hubspot_id": hubspot_id, "message": message})

    def phase(self, key: str, **kw) -> None:
        self.progress.setdefault(key, {"done": 0, "total": None, "state": "waiting"}).update(kw)

    async def flush(self, **final) -> None:
        import json

        sets = ["progress = $2::jsonb", "counts = $3::jsonb", "errors = $4::jsonb", "error_count = $5"]
        args: list[Any] = [self.id, json.dumps(self.progress), json.dumps(self.counts), json.dumps(self.errors), self.error_count]
        for k, v in final.items():
            args.append(v)
            sets.append(f"{k} = ${len(args)}")
        async with self.pool.acquire() as con:
            await con.execute(f"UPDATE import_runs SET {', '.join(sets)} WHERE id = $1", *args)

    # writes
    @staticmethod
    async def _upsert(con: asyncpg.Connection, table: str, hubspot_id: str, row: dict, notes: list[str], ts: datetime) -> tuple[UUID, str]:
        ex = await con.fetchrow(f"SELECT id, updated_at, hubspot_synced_at FROM {table} WHERE hubspot_id = $1", hubspot_id)
        data = {**row, "cleanup_reasons": list(dict.fromkeys(notes)), "hubspot_synced_at": ts, "updated_at": ts}
        if ex is None:
            data["hubspot_id"] = hubspot_id
            cols = list(data)
            ph = ", ".join(f"${i}" for i in range(1, len(cols) + 1))
            return await con.fetchval(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({ph}) RETURNING id", *data.values()), "created"
        # CRM-owned (claimed before import) or edited in the CRM since: keep.
        if ex["hubspot_synced_at"] is None or ex["updated_at"] > ex["hubspot_synced_at"]:
            return ex["id"], "kept"
        cols = list(data)
        sets = ", ".join(f"{c} = ${i}" for i, c in enumerate(cols, start=2))
        await con.execute(f"UPDATE {table} SET {sets} WHERE id = $1", ex["id"], *data.values())
        return ex["id"], "updated"

    async def _preload(self) -> None:
        async with self.pool.acquire() as con:
            for r in await con.fetch("SELECT hubspot_id, id, country FROM accounts WHERE hubspot_id IS NOT NULL"):
                self.ctx.accounts[r["hubspot_id"]] = (r["id"], r["country"])
            for r in await con.fetch("SELECT hubspot_id, id, account_id FROM prospects WHERE hubspot_id IS NOT NULL"):
                self.ctx.contacts[r["hubspot_id"]] = (r["id"], r["account_id"])
            for r in await con.fetch("SELECT hubspot_id, id FROM opportunities WHERE hubspot_id IS NOT NULL"):
                self.ctx.deals[r["hubspot_id"]] = r["id"]

    async def _totals(self) -> None:
        wanted = {"companies": "companies", "contacts": "contacts", "deals": "deals"}
        for key, obj in wanted.items():
            if key in self.opts.objects:
                try:
                    self.phase(key, total=await self.hs.total(obj))
                except HubSpotError:
                    self.phase(key, total=None)

    async def owners(self) -> None:
        self.phase("owners", state="running")
        owners = await self.hs.owners()
        create = "owners" in self.opts.objects
        async with self.pool.acquire() as con:
            for o in owners:
                email = (clean(o.get("email")) or "").lower()
                if not email:
                    continue
                uid = await con.fetchval("SELECT id FROM users WHERE email = $1", email)
                if uid:
                    self.count("users", "merged")
                elif create and email.endswith("@" + self.ctx.allowed_domain.lower()):
                    name = " ".join(x for x in (clean(o.get("firstName")), clean(o.get("lastName"))) if x) or email.split("@")[0]
                    uid = await con.fetchval("INSERT INTO users(email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id", email, name)
                    self.count("users", "created")
                else:
                    self.error("owner", str(o.get("id")), f"HubSpot owner {email} isn’t a {self.ctx.allowed_domain} user: their records go to the person running the import.")
                    continue
                self.ctx.owners[str(o["id"])] = uid
        self.phase("owners", state="done", done=len(owners), total=len(owners))

    def owner(self, props: dict) -> Optional[UUID]:
        return self.ctx.owners.get(clean(props.get("hubspot_owner_id")) or "")

    async def tasks(self) -> None:
        if not {"contacts", "deals", "activity"} & self.opts.objects:
            return
        try:
            async for page in self.hs.objects("tasks", TASK_PROPS, ("contacts", "deals", "companies")):
                self.ctx.tasks.extend(page)
        except HubSpotError as e:
            self.error("tasks", None, f"Couldn’t read HubSpot tasks, so open tasks won’t become next actions: {e.message}")
        self.ctx.open_tasks = open_task_index(self.ctx.tasks)

    async def companies(self) -> None:
        if "companies" not in self.opts.objects:
            return
        self.phase("companies", state="running")
        done = 0
        async for page in self.hs.objects("companies", COMPANY_PROPS):
            async with self.pool.acquire() as con:
                for c in page:
                    hid = str(c["id"])
                    try:
                        async with con.transaction():
                            await self._company(con, c, hid)
                    except (asyncpg.PostgresError, ValueError) as e:
                        self.count("accounts", "failed")
                        self.error("company", hid, str(e))
                    done += 1
            self.phase("companies", done=done)
            await self.flush()
        self.phase("companies", state="done", done=done)

    async def _company(self, con: asyncpg.Connection, c: dict, hid: str) -> None:
        owner_id = self.owner(c.get("properties") or {})
        row, notes = map_company(c, owner_id)
        ts = datetime.now(timezone.utc)
        exists = await con.fetchval("SELECT 1 FROM accounts WHERE hubspot_id = $1", hid)
        dom = domain_of(row["website"])
        if not exists:
            match = None
            if dom and dom in self.ctx.domains:
                acc_id, country, first_hid = self.ctx.domains[dom]
                match = {"id": acc_id, "country": country, "hubspot_id": first_hid}
            elif dom:
                match = await con.fetchrow(
                    "SELECT id, hubspot_id, country FROM accounts WHERE regexp_replace(regexp_replace(lower(coalesce(website, '')), '^[a-z]+://(www\\.)?', ''), '[/?].*$', '') = $1 LIMIT 1", dom)
            match = match or await con.fetchrow("SELECT id, hubspot_id, country FROM accounts WHERE name_key = $1", row["name_key"])
            if match is not None:
                if match["hubspot_id"] is None:
                    # Created in the CRM before the import: link it, keep CRM data.
                    await con.execute("UPDATE accounts SET hubspot_id = $2 WHERE id = $1", match["id"], hid)
                else:
                    await con.execute(
                        "UPDATE accounts SET cleanup_reasons = array_append(cleanup_reasons, $2) WHERE id = $1 AND NOT ($2 = ANY(cleanup_reasons))",
                        match["id"], NOTE["duplicate"])
                    self.error("company", hid, f"Merged into the account already imported from HubSpot company {match['hubspot_id']} (same domain or name).")
                self.ctx.accounts[hid] = (match["id"], match["country"])
                if dom:
                    self.ctx.domains.setdefault(dom, (match["id"], match["country"], match["hubspot_id"] or hid))
                self.count("accounts", "merged")
                return
        acc_id, outcome = await self._upsert(con, "accounts", hid, row, notes, ts)
        country = await con.fetchval("SELECT country FROM accounts WHERE id = $1", acc_id)
        self.ctx.accounts[hid] = (acc_id, country)
        if dom:
            self.ctx.domains.setdefault(dom, (acc_id, country, hid))
        self.count("accounts", outcome)

    async def contacts(self) -> None:
        if "contacts" not in self.opts.objects:
            return
        self.phase("contacts", state="running")
        done = 0
        assoc = ("companies",) if "associations" in self.opts.objects else ()
        async for page in self.hs.objects("contacts", CONTACT_PROPS, assoc):
            async with self.pool.acquire() as con:
                for ct in page:
                    hid = str(ct["id"])
                    try:
                        async with con.transaction():
                            await self._contact(con, ct, hid)
                    except (asyncpg.PostgresError, ValueError) as e:
                        self.count("prospects", "failed")
                        self.error("contact", hid, str(e))
                    done += 1
            self.phase("contacts", done=done)
            await self.flush()
        self.phase("contacts", state="done", done=done)

    async def _contact(self, con: asyncpg.Connection, ct: dict, hid: str) -> None:
        props = ct.get("properties") or {}
        account_id = next((self.ctx.accounts[c][0] for c in assoc_ids(ct, "companies") if c in self.ctx.accounts), None)
        owner_id = self.owner(props)
        row, notes = map_contact(ct, account_id=account_id, owner_id=owner_id, importer_id=self.ctx.importer_id,
                                 lead_map=self.opts.lead_map, task=self.ctx.open_tasks.get(("contacts", hid)), today=self.ctx.today)
        if row["email"] and not await con.fetchval("SELECT 1 FROM prospects WHERE hubspot_id = $1", hid):
            match = await con.fetchrow("SELECT id, hubspot_id, account_id FROM prospects WHERE lower(email) = $1", row["email"])
            if match is not None:
                if match["hubspot_id"] is None:
                    await con.execute("UPDATE prospects SET hubspot_id = $2 WHERE id = $1", match["id"], hid)
                else:
                    self.error("contact", hid, f"Same email as HubSpot contact {match['hubspot_id']}: merged into that prospect.")
                self.ctx.contacts[hid] = (match["id"], match["account_id"])
                self.count("prospects", "merged")
                return
        pid, outcome = await self._upsert(con, "prospects", hid, row, notes, datetime.now(timezone.utc))
        self.ctx.contacts[hid] = (pid, account_id)
        self.count("prospects", outcome)

    async def _unassigned_account(self, con: asyncpg.Connection) -> tuple[UUID, str]:
        if self.ctx.unassigned is None:
            key = domain.account_name_key(UNASSIGNED_ACCOUNT)
            acc_id = await con.fetchval(
                "INSERT INTO accounts(name, name_key, country, cleanup_reasons) VALUES ($1, $2, 'Unknown', $3) "
                "ON CONFLICT (name_key) DO UPDATE SET name_key = EXCLUDED.name_key RETURNING id",
                UNASSIGNED_ACCOUNT, key, [NOTE["unassigned"]])
            self.ctx.unassigned = (acc_id, "Unknown")
        return self.ctx.unassigned

    async def deals(self) -> None:
        if "deals" not in self.opts.objects:
            return
        try:
            self.ctx.currency = (clean((await self.hs.account_info()).get("companyCurrency")) or "USD").upper()
        except HubSpotError:
            pass
        self.phase("deals", state="running")
        done = 0
        assoc = ("companies", "contacts") if "associations" in self.opts.objects else ()
        async for page in self.hs.objects("deals", DEAL_PROPS, assoc):
            async with self.pool.acquire() as con:
                for d in page:
                    hid = str(d["id"])
                    try:
                        async with con.transaction():
                            await self._deal(con, d, hid)
                    except (asyncpg.PostgresError, ValueError) as e:
                        self.count("opportunities", "failed")
                        self.error("deal", hid, str(e))
                    done += 1
            self.phase("deals", done=done)
            await self.flush()
        self.phase("deals", state="done", done=done)

    async def _deal(self, con: asyncpg.Connection, d: dict, hid: str) -> None:
        props = d.get("properties") or {}
        contacts = [self.ctx.contacts[c] for c in assoc_ids(d, "contacts") if c in self.ctx.contacts]
        account = next((self.ctx.accounts[c] for c in assoc_ids(d, "companies") if c in self.ctx.accounts), None)
        if account is None:
            for _, acc_id in contacts:
                if acc_id:
                    account = (acc_id, await con.fetchval("SELECT country FROM accounts WHERE id = $1", acc_id))
                    break
        no_company = account is None
        if account is None:
            account = await self._unassigned_account(con)
        owner_id = self.owner(props)
        row, notes = map_deal(
            d, stage=self.opts.stage_map.get(clean(props.get("dealstage")) or ""), account_id=account[0], country=account[1],
            no_company=no_company, contact_id=contacts[0][0] if contacts else None, owner_id=owner_id,
            importer_id=self.ctx.importer_id, default_currency=self.ctx.currency,
            task=self.ctx.open_tasks.get(("deals", hid)), today=self.ctx.today)
        oid, outcome = await self._upsert(con, "opportunities", hid, row, notes, datetime.now(timezone.utc))
        self.ctx.deals[hid] = oid
        self.count("opportunities", outcome)

    async def activity(self) -> None:
        kinds = [k for k in ENGAGEMENTS if (k == "emails" and "emails" in self.opts.objects) or (k != "emails" and "activity" in self.opts.objects)]
        if not kinds:
            return
        self.phase("activity", state="running")
        done = 0
        for object_type in kinds:
            kind, props = ENGAGEMENTS[object_type]
            try:
                if object_type == "tasks" and self.ctx.tasks:
                    pages = [self.ctx.tasks[i: i + 100] for i in range(0, len(self.ctx.tasks), 100)]
                else:
                    pages = []
                    async for page in self.hs.objects(object_type, props, ("deals", "contacts", "companies")):
                        pages.append(page)
            except HubSpotError as e:
                self.error(object_type, None, f"Couldn’t read HubSpot {object_type}: {e.message}")
                continue
            for page in pages:
                async with self.pool.acquire() as con:
                    for e in page:
                        await self._engagement(con, object_type, kind, e)
                        done += 1
                self.phase("activity", done=done)
                await self.flush()
        self.phase("activity", state="done", done=done)

    async def _engagement(self, con: asyncpg.Connection, object_type: str, kind: str, e: dict) -> None:
        hid = f"{object_type}:{e['id']}"
        target = None
        for d in assoc_ids(e, "deals"):
            if d in self.ctx.deals:
                target = ("opportunity", self.ctx.deals[d])
                break
        if target is None:
            target = next((("prospect", self.ctx.contacts[c][0]) for c in assoc_ids(e, "contacts") if c in self.ctx.contacts), None)
        if target is None:
            target = next((("account", self.ctx.accounts[c][0]) for c in assoc_ids(e, "companies") if c in self.ctx.accounts), None)
        if target is None:
            self.count("activities", "failed")
            self.error(object_type, str(e["id"]), "Not linked to any imported company, contact or deal: skipped.")
            return
        summary, when = engagement_summary(object_type, e)
        owner_id = self.owner(e.get("properties") or {})
        try:
            new_id = await con.fetchval(
                "INSERT INTO activities(entity_type, entity_id, kind, summary, occurred_at, created_by, hubspot_id) "
                "VALUES ($1, $2, $3, $4, coalesce($5, now()), $6, $7) ON CONFLICT (hubspot_id) DO NOTHING RETURNING id",
                target[0], target[1], kind, summary, when, owner_id, hid)
        except asyncpg.PostgresError as err:
            self.count("activities", "failed")
            self.error(object_type, str(e["id"]), str(err))
            return
        self.count("activities", "created" if new_id else "kept")

    async def execute(self) -> None:
        try:
            await self._preload()
            await self._totals()
            await self.owners()
            await self.tasks()
            await self.companies()
            await self.contacts()
            await self.deals()
            await self.activity()
            c = self.counts
            parts = [f"{sum(v for k, v in c.get(e, {}).items() if k != 'failed')} {label}" for e, label in
                     (("accounts", "accounts"), ("prospects", "prospects"), ("opportunities", "opportunities"), ("activities", "activities"))]
            await self.flush(status="succeeded", finished_at=datetime.now(timezone.utc),
                             message=f"Imported {', '.join(parts)}. {self.error_count} issue(s) logged.")
        except HubSpotError as e:
            await self.flush(status="failed", finished_at=datetime.now(timezone.utc), message=e.message)
        except Exception as e:  # noqa: BLE001 - recorded on the run, then logged
            logger.exception("HubSpot import failed")
            await self.flush(status="failed", finished_at=datetime.now(timezone.utc), message=f"Import stopped: {e}")
