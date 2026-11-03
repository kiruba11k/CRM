"""
backend/app/csvimport.py - bulk import of accounts, prospects and deals
(opportunities) from a CSV file, with column mapping.

Flow (stateless; the browser sends the file text with each step):
1. analyze  - read the CSV, list its columns, suggest a mapping
2. plan     - apply the mapping and options to every row and say what
              would happen: ready / needs cleanup / duplicate / error
3. commit   - store the rows that can be stored, in file order

Values are normalised to the CRM's controlled lists (case-insensitive),
dates in common formats and amounts like "$12,500". Owners match users by
email or name; accounts match by name (and can be created once per file).
Duplicates are skipped, never overwritten. Records that break a CRM rule
(no next action, Qualified without value…) are imported with the reasons
in `cleanup_reasons` (the Needs cleanup list), as the HubSpot import does;
rows missing essentials are skipped with the reason.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional
from uuid import UUID

import asyncpg

from . import domain
from .importer import DEFAULT_STAGE_MAP, map_lost_reason

MAX_ROWS = 5000
MAX_BYTES = 5 * 1024 * 1024
REVIEW_OTHER = "Review after CSV import"

# field -> (label, required, header aliases). Aliases are compared after
# lower-casing and dropping everything but letters and digits.
FIELDS: dict[str, dict[str, tuple[str, bool, list[str]]]] = {
    "accounts": {
        "name": ("Account / company name", True, ["name", "account", "accountname", "company", "companyname", "organization", "organisation"]),
        "country": ("Country", True, ["country", "geography", "countryregion", "nation"]),
        "region": ("Region / city", False, ["region", "city", "state", "regioncity"]),
        "industry": ("Industry", False, ["industry", "segment", "sector", "vertical"]),
        "status": ("Account status", False, ["status", "accountstatus", "lifecyclestage", "type"]),
        "website": ("Website", False, ["website", "domain", "url", "web", "companydomainname"]),
        "linkedin_url": ("LinkedIn URL", False, ["linkedin", "linkedinurl", "companylinkedin", "linkedincompanypage"]),
        "owner": ("Owner (email or name)", False, ["owner", "accountowner", "owneremail", "companyowner", "salesperson"]),
        "notes": ("Notes", False, ["notes", "note", "description", "comments", "about"]),
    },
    "prospects": {
        "full_name": ("Full name", False, ["fullname", "name", "contactname", "prospect", "prospectname", "contact"]),
        "first_name": ("First name", False, ["firstname", "first", "givenname", "forename"]),
        "last_name": ("Last name", False, ["lastname", "last", "surname", "familyname"]),
        "email": ("Email", False, ["email", "emailaddress", "workemail", "mail"]),
        "phone": ("Phone", False, ["phone", "phonenumber", "mobile", "mobilephone", "telephone", "tel"]),
        "job_title": ("Job title", False, ["jobtitle", "title", "position", "role", "designation"]),
        "linkedin_url": ("LinkedIn URL", False, ["linkedin", "linkedinurl", "linkedinprofile", "profileurl"]),
        "account": ("Account / company", False, ["account", "company", "companyname", "accountname", "organization", "organisation"]),
        "country": ("Country (for new accounts)", False, ["country", "geography", "countryregion"]),
        "status": ("Status", False, ["status", "leadstatus", "prospectstatus", "stage"]),
        "source": ("Source", False, ["source", "leadsource", "origin", "channel"]),
        "owner": ("Owner (email or name)", False, ["owner", "contactowner", "owneremail", "leadowner", "salesperson"]),
        "next_action": ("Next action", False, ["nextaction", "nextstep", "action", "followup"]),
        "next_action_due": ("Next action due date", False, ["nextactiondue", "nextactiondate", "duedate", "due", "followupdate", "nextstepdate"]),
        "notes": ("Notes", False, ["notes", "note", "description", "comments"]),
    },
    "opportunities": {
        "name": ("Deal name", True, ["name", "dealname", "opportunity", "opportunityname", "deal", "title"]),
        "account": ("Account / company", True, ["account", "company", "companyname", "accountname", "organization", "organisation", "associatedcompany"]),
        "country": ("Country (geography)", False, ["country", "geography", "region"]),
        "primary_contact": ("Primary contact (email or name)", False, ["contact", "primarycontact", "contactemail", "contactname", "associatedcontact"]),
        "owner": ("Owner (email or name)", False, ["owner", "dealowner", "owneremail", "salesperson"]),
        "stage": ("Stage", False, ["stage", "dealstage", "pipelinestage", "salesstage"]),
        "estimated_value": ("Estimated value", False, ["value", "amount", "dealvalue", "estimatedvalue", "dealamount"]),
        "currency": ("Currency", False, ["currency", "currencycode", "dealcurrencycode"]),
        "expected_close": ("Expected close date", False, ["expectedclose", "expectedclosedate", "closedate", "close"]),
        "service_line": ("Service line", False, ["serviceline", "service", "product", "projecttype"]),
        "deal_source": ("Deal source", False, ["source", "dealsource", "leadsource", "origin"]),
        "risk_rating": ("Risk rating", False, ["risk", "riskrating"]),
        "high_risk_reason": ("High-risk reason", False, ["highriskreason", "riskreason"]),
        "risk_mitigation": ("Risk mitigation", False, ["riskmitigation", "mitigation"]),
        "next_action": ("Next action", False, ["nextaction", "nextstep", "action"]),
        "next_action_due": ("Next action due date", False, ["nextactiondue", "nextactiondate", "duedate", "due", "nextstepdate"]),
        "actual_value": ("Actual contract value (won)", False, ["actualvalue", "contractvalue", "wonvalue", "actualamount"]),
        "won_date": ("Won date", False, ["wondate", "datewon"]),
        "lost_reason": ("Lost reason", False, ["lostreason", "closedlostreason", "reasonlost"]),
        "lost_date": ("Lost date", False, ["lostdate", "datelost"]),
    },
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


# ── Reading and mapping ───────────────────────────────────────────────

def read_csv(text: str) -> tuple[list[str], list[dict[str, str]]]:
    if len(text.encode("utf-8", "ignore")) > MAX_BYTES:
        raise ValueError("The file is larger than 5 MB. Split it into smaller files.")
    text = text.lstrip("﻿")
    if not text.strip():
        raise ValueError("The file is empty.")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        raise ValueError("The file has no rows.")
    headers = [h.strip() or f"Column {i + 1}" for i, h in enumerate(rows[0])]
    seen: dict[str, int] = {}
    for i, h in enumerate(headers):  # make duplicate headers unique
        if h in seen:
            seen[h] += 1
            headers[i] = f"{h} ({seen[h]})"
        else:
            seen[h] = 1
    body = rows[1:]
    if len(body) > MAX_ROWS:
        raise ValueError(f"The file has {len(body)} rows; import at most {MAX_ROWS} at a time.")
    return headers, [{h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(headers)} for r in body]


def suggest_mapping(entity: str, headers: list[str]) -> dict[str, Optional[str]]:
    by_norm = {_norm(h): h for h in headers}
    used: set[str] = set()
    out: dict[str, Optional[str]] = {}
    for f, (_label, _req, aliases) in FIELDS[entity].items():
        hit = next((by_norm[a] for a in aliases if a in by_norm and by_norm[a] not in used), None)
        out[f] = hit
        if hit:
            used.add(hit)
    # A single "Name" column on prospects is the full name, not first name.
    return out


# ── Value parsing ─────────────────────────────────────────────────────

_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def parse_date(v: str, day_first: bool) -> Optional[date]:
    s = (v or "").strip()
    if not s:
        return None
    s = s.split("T")[0].split(" ")[0] if re.match(r"^\d{4}-\d{2}-\d{2}[T ]", s) else s
    if m := re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s):
        y, mo, d = map(int, m.groups())
    elif m := re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})", s):
        a, b, y = map(int, m.groups())
        y = y + 2000 if y < 100 else y
        d, mo = (a, b) if day_first else (b, a)
    elif m := re.fullmatch(r"(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s,-]+(\d{4})", s):
        d, mon, y = int(m.group(1)), m.group(2)[:3].lower(), int(m.group(3))
        mo = _MONTHS.get(mon, 0)
    elif m := re.fullmatch(r"([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})", s):
        mon, d, y = m.group(1)[:3].lower(), int(m.group(2)), int(m.group(3))
        mo = _MONTHS.get(mon, 0)
    else:
        raise ValueError(f"“{v}” isn’t a date the CRM understands (use e.g. 2026-11-15).")
    try:
        return date(y, mo, d)
    except ValueError as e:
        raise ValueError(f"“{v}” isn’t a valid date.") from e


def parse_money(v: str):
    s = (v or "").strip()
    if not s:
        return None
    cleaned = re.sub(r"[^\d.,-]", "", s)
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(",", "") if cleaned.rfind(".") > cleaned.rfind(",") else cleaned.replace(".", "").replace(",", ".")
    elif "," in cleaned:
        parts = cleaned.split(",")
        cleaned = cleaned.replace(",", "") if len(parts[-1]) == 3 else cleaned.replace(",", ".")
    d = domain.to_decimal(cleaned)
    if d is None:
        raise ValueError(f"“{v}” isn’t an amount.")
    return d


def match_choice(v: str, options: list[str]) -> Optional[str]:
    s = _norm(v)
    if not s:
        return None
    for o in options:
        if _norm(o) == s:
            return o
    return next((o for o in options if s and (_norm(o).startswith(s) or s.startswith(_norm(o)))), None)


# Common names for the closed stages in exports from other CRMs.
# HubSpot's default pipeline labels normalise to its stage IDs ("Contract sent"
# → "contractsent"), so the HubSpot importer's mapping covers them too.
STAGE_ALIASES = {**DEFAULT_STAGE_MAP, "closedwon": "Won", "won": "Won", "closedlost": "Lost", "lost": "Lost", "dealwon": "Won", "deallost": "Lost"}


def match_stage(v: str, extra: Optional[dict[str, str]] = None) -> Optional[str]:
    if extra and _norm(v) in extra:
        return extra[_norm(v)]
    return STAGE_ALIASES.get(_norm(v)) or match_choice(v, domain.STAGE_NAMES)


def match_next_action(v: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """→ (code, other text, warning)."""
    s = (v or "").strip()
    if not s:
        return None, None, None
    code = s.zfill(2) if s.isdigit() else None
    if code in domain.NEXT_ACTIONS:
        return (code, None, None) if code != domain.OTHER_CODE else (code, "See notes", None)
    for c, label in domain.NEXT_ACTIONS.items():
        if _norm(label) == _norm(s) and c != domain.OTHER_CODE:
            return c, None, None
    other = re.sub(r"^other:\s*", "", s, flags=re.I)
    if len(other) > domain.OTHER_MAX_LEN:
        return domain.OTHER_CODE, other[: domain.OTHER_MAX_LEN].rstrip(), f"Next action shortened to {domain.OTHER_MAX_LEN} characters."
    return domain.OTHER_CODE, other, None


# ── Planning ──────────────────────────────────────────────────────────

@dataclass
class Options:
    day_first: bool = True
    create_missing_accounts: bool = True
    default_country: Optional[str] = None
    default_owner_id: Optional[UUID] = None
    default_currency: str = "USD"
    # The user's own choices for stage values the CRM couldn't match: normalised value → stage.
    stage_map: dict[str, str] = field(default_factory=dict)


@dataclass
class RowPlan:
    row: int
    status: str  # ready | cleanup | duplicate | error
    messages: list[str] = field(default_factory=list)
    label: str = ""
    record: dict = field(default_factory=dict)
    new_account: Optional[dict] = None  # {name, name_key, country}
    account_key: Optional[str] = None
    unknown_stage: Optional[str] = None

    def out(self) -> dict:
        return {"row": self.row, "status": self.status, "messages": self.messages, "label": self.label}


class Lookups:
    def __init__(self, users, accounts, prospects, opps):
        self.users = users
        self.by_email = {u["email"].lower(): u["id"] for u in users}
        self.by_name = {_norm(u["name"].replace("(demo)", "")): u["id"] for u in users}
        firsts: dict[str, list] = {}
        for u in users:
            first = u["name"].replace("(demo)", "").split()
            if first:
                firsts.setdefault(_norm(first[0]), []).append(u["id"])
        # A first name alone matches only when it is unambiguous.
        self.by_first = {k: v[0] for k, v in firsts.items() if len(v) == 1}
        self.accounts = {a["name_key"]: (a["id"], a["country"]) for a in accounts}
        self.prospect_emails = {p["email"].lower(): p["id"] for p in prospects if p["email"]}
        self.prospect_names = {}
        for p in prospects:
            self.prospect_names.setdefault((_norm(p["full_name"]), p["account_id"]), p["id"])
            self.prospect_names.setdefault((_norm(p["full_name"]), None), p["id"])
        self.opps = {(o["account_id"], _norm(o["name"])) for o in opps}

    @classmethod
    async def load(cls, con: asyncpg.Connection) -> "Lookups":
        return cls(
            await con.fetch("SELECT id, email, name FROM users WHERE active"),
            await con.fetch("SELECT id, name_key, country FROM accounts"),
            await con.fetch("SELECT id, email, full_name, account_id FROM prospects"),
            await con.fetch("SELECT account_id, name FROM opportunities"),
        )

    def owner(self, v: str) -> Optional[UUID]:
        s = (v or "").strip()
        if not s:
            return None
        return self.by_email.get(s.lower()) or self.by_name.get(_norm(s)) or self.by_first.get(_norm(s))


def _get(raw: dict, mapping: dict, f: str) -> str:
    col = mapping.get(f)
    return (raw.get(col) or "").strip() if col else ""


def plan_rows(entity: str, rows: list[dict], mapping: dict, opts: Options, lk: Lookups, user_id: UUID, today: date) -> list[RowPlan]:
    plans: list[RowPlan] = []
    new_accounts: dict[str, dict] = {}   # name_key -> account to create (once per file)
    seen_keys: set = set()               # duplicates inside the file

    def account_for(name: str, country: str, p: RowPlan) -> Optional[tuple[Optional[UUID], str, str]]:
        """(existing id or None, country, name_key) or None if it can't be resolved."""
        key = domain.account_name_key(name)
        if not key:
            return None
        if key in lk.accounts:
            return lk.accounts[key][0], lk.accounts[key][1], key
        if not opts.create_missing_accounts:
            p.messages.append(f"Account “{name}” doesn’t exist (creating missing accounts is off).")
            return None
        c = country or opts.default_country
        if not c:
            p.messages.append(f"Account “{name}” doesn’t exist and has no country: map a Country column or set a default country.")
            return None
        if key not in new_accounts:
            new_accounts[key] = {"name": name, "name_key": key, "country": c}
            p.messages.append(f"New account “{name}” will be created.")
        p.new_account = new_accounts[key]
        return None, new_accounts[key]["country"], key

    def owner_for(v: str, p: RowPlan) -> UUID:
        o = lk.owner(v)
        if v and not o:
            p.messages.append(f"Owner “{v}” isn’t a CRM user: assigned to the default owner.")
        return o or opts.default_owner_id or user_id

    for i, raw in enumerate(rows, start=2):  # row 1 is the header
        p = RowPlan(row=i, status="ready")
        try:
            if entity == "accounts":
                name = _get(raw, mapping, "name")
                p.label = name
                if not name:
                    raise ValueError("No account name.")
                key = domain.account_name_key(name)
                if key in lk.accounts or key in seen_keys:
                    p.status = "duplicate"
                    p.messages.append("An account with this name already exists." if key in lk.accounts else "Same account appears earlier in the file.")
                    plans.append(p)
                    continue
                seen_keys.add(key)
                country = _get(raw, mapping, "country") or opts.default_country
                rec = {"name": name, "name_key": key, "country": country, "region": _get(raw, mapping, "region") or None,
                       "industry": _get(raw, mapping, "industry") or None, "website": _get(raw, mapping, "website") or None,
                       "linkedin_url": _get(raw, mapping, "linkedin_url") or None, "notes": _get(raw, mapping, "notes") or None,
                       "owner_id": lk.owner(_get(raw, mapping, "owner")) or opts.default_owner_id}
                if _get(raw, mapping, "owner") and not lk.owner(_get(raw, mapping, "owner")):
                    p.messages.append(f"Owner “{_get(raw, mapping, 'owner')}” isn’t a CRM user: "
                                      + ("assigned to the default owner." if opts.default_owner_id else "left without an owner."))
                st = _get(raw, mapping, "status")
                rec["status"] = match_choice(st, domain.ACCOUNT_STATUSES) or "Target"
                if st and rec["status"] == "Target" and _norm(st) != "target":
                    p.messages.append(f"Status “{st}” not in the list: set to Target.")
                if not country:
                    raise ValueError("No country (map a Country column or set a default country).")
                p.record = rec

            elif entity == "prospects":
                full = _get(raw, mapping, "full_name") or " ".join(x for x in (_get(raw, mapping, "first_name"), _get(raw, mapping, "last_name")) if x)
                email = _get(raw, mapping, "email").lower() or None
                p.label = full or (email or "")
                if not full:
                    raise ValueError("No name (map Full name, or First and Last name).")
                if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                    p.messages.append(f"“{email}” isn’t an email address: left out.")
                    email = None
                if email and (email in lk.prospect_emails or email in seen_keys):
                    p.status = "duplicate"
                    p.messages.append("A prospect with this email already exists." if email in lk.prospect_emails else "Same email appears earlier in the file.")
                    plans.append(p)
                    continue
                if email:
                    seen_keys.add(email)
                acc_id, acc_name = None, _get(raw, mapping, "account")
                if acc_name:
                    res = account_for(acc_name, _get(raw, mapping, "country"), p)
                    if res:
                        acc_id, _c, p.account_key = res
                st = _get(raw, mapping, "status")
                status = match_choice(st, domain.PROSPECT_STATUSES) if st else "New"
                if not status:
                    raise ValueError(f"Status “{st}” isn’t one of: {', '.join(domain.PROSPECT_STATUSES)}.")
                src = _get(raw, mapping, "source")
                source = match_choice(src, domain.SOURCES) if src else None
                if src and not source:
                    p.messages.append(f"Source “{src}” not in the list: left blank.")
                rec = {"full_name": full, "email": email, "phone": _get(raw, mapping, "phone") or None,
                       "job_title": _get(raw, mapping, "job_title") or None, "linkedin_url": _get(raw, mapping, "linkedin_url") or None,
                       "account_id": acc_id, "status": status, "source": source, "notes": _get(raw, mapping, "notes") or None,
                       "next_action_code": None, "next_action_other": None, "next_action_due": None,
                       "owner_id": owner_for(_get(raw, mapping, "owner"), p) if status not in domain.CLOSED_PROSPECT_STATUSES else lk.owner(_get(raw, mapping, "owner"))}
                if status not in domain.CLOSED_PROSPECT_STATUSES:
                    code, other, warn = match_next_action(_get(raw, mapping, "next_action"))
                    if warn:
                        p.messages.append(warn)
                    due = parse_date(_get(raw, mapping, "next_action_due"), opts.day_first)
                    if not code or not due:
                        code, other, due = code or domain.OTHER_CODE, other if code else REVIEW_OTHER, due or today
                        rec["cleanup"] = ["No next action or due date in the file: set a real next action."]
                    rec.update(next_action_code=code, next_action_other=other, next_action_due=due)
                p.record = rec

            else:  # opportunities
                name = _get(raw, mapping, "name")
                acc_name = _get(raw, mapping, "account")
                p.label = f"{name} · {acc_name}" if acc_name else name
                if not name:
                    raise ValueError("No deal name.")
                if not acc_name:
                    raise ValueError("No account (every deal needs one).")
                res = account_for(acc_name, _get(raw, mapping, "country"), p)
                if not res:
                    raise ValueError(p.messages.pop() if p.messages else f"Account “{acc_name}” can’t be resolved.")
                acc_id, country, p.account_key = res
                dkey = (acc_id or p.account_key, _norm(name))
                if (acc_id and (acc_id, _norm(name)) in lk.opps) or dkey in seen_keys:
                    p.status = "duplicate"
                    p.messages.append("This account already has a deal with this name." if acc_id and (acc_id, _norm(name)) in lk.opps else "Same deal appears earlier in the file.")
                    plans.append(p)
                    continue
                seen_keys.add(dkey)
                st = _get(raw, mapping, "stage")
                stage = match_stage(st, opts.stage_map) if st else "Lead identified"
                if not stage:
                    p.unknown_stage = st
                    raise ValueError(f"Stage “{st}” isn’t one of the CRM’s stages: choose one for it above.")
                cur = (_get(raw, mapping, "currency") or opts.default_currency).upper()
                if not re.fullmatch(r"[A-Z]{3}", cur):
                    raise ValueError(f"Currency “{cur}” isn’t a three-letter code.")
                contact = _get(raw, mapping, "primary_contact")
                contact_id = None
                if contact:
                    contact_id = lk.prospect_emails.get(contact.lower()) or lk.prospect_names.get((_norm(contact), acc_id)) or lk.prospect_names.get((_norm(contact), None))
                    if not contact_id:
                        p.messages.append(f"Contact “{contact}” not found: left blank.")
                rec: dict[str, Any] = {
                    "name": name, "account_id": acc_id, "geography": _get(raw, mapping, "country") or country, "stage": stage,
                    "owner_id": owner_for(_get(raw, mapping, "owner"), p), "primary_contact_id": contact_id, "currency": cur,
                    "estimated_value": parse_money(_get(raw, mapping, "estimated_value")),
                    "expected_close": parse_date(_get(raw, mapping, "expected_close"), opts.day_first),
                    "high_risk_reason": _get(raw, mapping, "high_risk_reason") or None, "risk_mitigation": _get(raw, mapping, "risk_mitigation") or None,
                    "next_action_code": None, "next_action_other": None, "next_action_due": None,
                }
                for f, options, label in (("service_line", domain.SERVICE_LINES, "Service line"), ("deal_source", domain.SOURCES, "Deal source")):
                    v = _get(raw, mapping, f)
                    rec[f] = match_choice(v, options) if v else None
                    if v and not rec[f]:
                        p.messages.append(f"{label} “{v}” not in the list: left blank.")
                rv = _get(raw, mapping, "risk_rating")
                rec["risk_rating"] = match_choice(rv, domain.RISK_RATINGS) if rv else "Unassessed"
                if rv and not rec["risk_rating"]:
                    rec["risk_rating"] = "Unassessed"
                    p.messages.append(f"Risk “{rv}” not in the list: set to Unassessed.")
                cleanup: list[str] = []
                if stage == domain.WON:
                    rec["actual_value"] = parse_money(_get(raw, mapping, "actual_value")) or rec["estimated_value"]
                    rec["won_date"] = parse_date(_get(raw, mapping, "won_date"), opts.day_first) or rec["expected_close"] or today
                elif stage == domain.LOST:
                    lr = _get(raw, mapping, "lost_reason")
                    rec["lost_reason"], rec["lost_notes"] = map_lost_reason(lr)
                    rec["lost_date"] = parse_date(_get(raw, mapping, "lost_date"), opts.day_first) or rec["expected_close"] or today
                else:
                    code, other, warn = match_next_action(_get(raw, mapping, "next_action"))
                    if warn:
                        p.messages.append(warn)
                    due = parse_date(_get(raw, mapping, "next_action_due"), opts.day_first)
                    if not code or not due:
                        code, other, due = code or domain.OTHER_CODE, other if code else REVIEW_OTHER, due or today
                        cleanup.append("No next action or due date in the file: set a real next action.")
                    rec.update(next_action_code=code, next_action_other=other, next_action_due=due)
                check = {**rec, "account_id": acc_id or "new"}
                errors, _ = domain.validate_opportunity(check, today)
                cleanup += [e["message"] for e in errors]
                rec["cleanup"] = cleanup
                p.record = rec
            if entity == "prospects":
                errors, _ = domain.validate_prospect({**p.record, "account_id": p.record.get("account_id") or p.account_key})
                p.record["cleanup"] = p.record.get("cleanup", []) + [e["message"] for e in errors]
            if p.record.get("cleanup"):
                p.status = "cleanup"
                p.messages += p.record["cleanup"]
        except ValueError as e:
            p.status = "error"
            p.messages.append(str(e))
        plans.append(p)
    return plans


def summary(plans: list[RowPlan]) -> dict:
    out = {"ready": 0, "cleanup": 0, "duplicate": 0, "error": 0}
    for p in plans:
        out[p.status] += 1
    out["new_accounts"] = len({p.account_key for p in plans if p.new_account and p.status in ("ready", "cleanup")})
    return out


def unknown_stages(plans: list[RowPlan]) -> list[dict]:
    """Distinct stage values the CRM couldn't match, with how many rows use each."""
    counts: dict[str, int] = {}
    for p in plans:
        if p.unknown_stage:
            counts[p.unknown_stage] = counts.get(p.unknown_stage, 0) + 1
    return [{"value": v, "rows": n} for v, n in sorted(counts.items(), key=lambda x: -x[1])]


async def commit(con: asyncpg.Connection, entity: str, plans: list[RowPlan], user_id: UUID) -> dict:
    """Store every ready / cleanup row; each row in its own savepoint."""
    from .records import record_changes

    created_accounts: dict[str, UUID] = {}
    counts = {"created": 0, "accounts_created": 0, "failed": 0}
    failures: list[dict] = []
    table = {"accounts": "accounts", "prospects": "prospects", "opportunities": "opportunities"}[entity]
    kind = {"accounts": "account", "prospects": "prospect", "opportunities": "opportunity"}[entity]
    now = datetime.now(timezone.utc)
    for p in plans:
        if p.status not in ("ready", "cleanup"):
            continue
        try:
            async with con.transaction():
                rec = dict(p.record)
                cleanup = rec.pop("cleanup", [])
                if p.new_account:
                    key = p.new_account["name_key"]
                    if key not in created_accounts:
                        existing = await con.fetchval("SELECT id FROM accounts WHERE name_key = $1", key)
                        if existing is None:
                            existing = await con.fetchval(
                                "INSERT INTO accounts(name, name_key, country, notes) VALUES ($1, $2, $3, 'Created by CSV import.') RETURNING id",
                                p.new_account["name"], key, p.new_account["country"])
                            counts["accounts_created"] += 1
                        created_accounts[key] = existing
                    rec["account_id"] = created_accounts[key]
                rec["cleanup_reasons"] = cleanup
                rec["created_at"] = rec["updated_at"] = now
                cols = list(rec)
                row = await con.fetchrow(
                    f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(f'${i}' for i in range(1, len(cols) + 1))}) RETURNING *", *rec.values())
                await record_changes(con, kind, row["id"], None, dict(row), str(user_id))
                await con.execute(
                    "INSERT INTO activities(entity_type, entity_id, kind, summary, created_by) VALUES ($1, $2, 'note', $3, $4)",
                    kind, row["id"], f"Imported from CSV (row {p.row}).", user_id)
                counts["created"] += 1
        except (asyncpg.PostgresError, ValueError) as e:
            counts["failed"] += 1
            failures.append({"row": p.row, "label": p.label, "message": str(e).split("\n")[0]})
    return {**counts, "failures": failures}
