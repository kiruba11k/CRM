"""
backend/app/demo.py - dummy data that exercises every part of the CRM.

4 demo users, 12 accounts, 25 prospects, 18 opportunities across all nine
stages (incl. nurture, Won, Lost, High risk, three currencies), team
assignments, activity timelines, stage history, meetings, booking links,
Gmail thread links and two "Needs cleanup" records. Dates are relative to
the day it is loaded, so My Actions shows overdue, today and upcoming work.

Safety:
- Every row has a fixed ID derived from a name, so `remove` deletes exactly
  the demo rows and never touches real data.
- All demo records are owned by the demo users (emails demo.*@<domain>,
  names ending "(demo)"), so nothing demo is pushed into a real person's
  Google Calendar or Google Tasks.
- Demo meetings are marked as not sent to Google.
"""
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Optional

import asyncpg

from . import domain

NS = uuid.UUID("6f4e1c1a-3b7e-4c51-9d0e-1a2b3c4d5e6f")


def did(kind: str, key: str) -> uuid.UUID:
    return uuid.uuid5(NS, f"demo:{kind}:{key}")


USERS = [  # key, name, role
    ("meera", "Meera Shah (demo)", "manager"),
    ("arjun", "Arjun Patel (demo)", "salesperson"),
    ("sofia", "Sofia Lindqvist (demo)", "salesperson"),
    ("daniel", "Daniel Okafor (demo)", "salesperson"),
]

ACCOUNTS = [  # key, name, country, region, industry, status, website, owner, created days ago
    ("norvale", "Norvale Pharma", "Sweden", "Stockholm", "Pharmaceuticals", "Active customer", "https://www.norvale-pharma.example", "sofia", 160),
    ("halden", "Halden Medical Devices", "Germany", "Munich", "Medical devices", "Target", "https://halden-med.example", "arjun", 120),
    ("kestrel", "Kestrel Analytics", "United States", "Boston", "Software", "Active customer", "https://kestrel-analytics.example", "meera", 150),
    ("oriel", "Oriel Packaging", "United Kingdom", "Leeds", "Packaging", "Target", "https://oriel-pack.example", "daniel", 110),
    ("brightline", "Brightline Foods", "Netherlands", "Rotterdam", "Food & beverage", "Target", "https://brightline-foods.example", "sofia", 95),
    ("gulfmed", "GulfMed Distribution", "UAE", "Dubai", "Healthcare distribution", "Target", "https://gulfmed.example", "arjun", 80),
    ("atlas", "Atlas Fleet Systems", "United States", "Denver", "Logistics technology", "Active customer", "https://atlas-fleet.example", "daniel", 140),
    ("verdant", "Verdant Agritech", "India", "Bengaluru", "Agritech", "Target", "https://verdant-agri.example", "arjun", 40),
    ("lumen", "Lumen Robotics", "Japan", "Osaka", "Industrial automation", "Target", "https://lumen-robotics.example", "meera", 60),
    ("castell", "Castell Insurance", "Italy", "Milan", "Insurance", "Inactive / do not pursue", "https://castell-ins.example", "sofia", 130),
    ("northwind", "Northwind Energy", "Norway", "Bergen", "Renewable energy", "Target", "https://northwind-energy.example", "daniel", 70),
    ("pinecrest", "Pinecrest Hotels", "Spain", "Barcelona", "Hospitality", "Active customer", "https://pinecrest-hotels.example", "meera", 100),
]

# key, name, account, job title, status, source, owner, next action (code, other), due offset, created days ago, extra
PROSPECTS = [
    ("elin", "Elin Berg", "norvale", "VP Marketing", "Qualified", "Referral", "sofia", ("08", None), 2, 150, {}),
    ("erik", "Erik Holm", "norvale", "Head of Sales", "Engaged", "Outbound", "sofia", ("02", None), 6, 85, {}),
    ("victor", "Victor Lindgren", "norvale", "Procurement Manager", "Engaged", "Referral", "sofia", ("12", None), 5, 30, {}),
    ("priya", "Priya Raman", "halden", "VP Sales", "Contacted", "Event / tradeshow", "arjun", ("01", None), -2, 60, {}),
    ("jonas", "Jonas Weber", "halden", "Marketing Director", "New", "Outbound", "arjun", ("03", None), 0, 12, {}),
    ("hannah", "Hannah Schulz", "halden", "Product Marketing Lead", "New", "Outbound", "arjun", ("14", None), 12, 8, {}),
    ("grace", "Grace Chen", "kestrel", "CMO", "Qualified", "Inbound", "meera", ("11", None), 0, 140, {}),
    ("tom", "Tom Avery", "kestrel", "Demand Generation Lead", "Engaged", "Inbound", "meera", ("05", None), 3, 45, {}),
    ("ines", "Ines Duarte", "oriel", "Commercial Director", "Qualified", "Referral", "daniel", ("10", None), 1, 100, {}),
    ("harry", "Harry Cole", "oriel", "Operations Manager", "Contacted", "Outbound", "daniel", ("04", None), -4, 35, {}),
    ("femke", "Femke de Vries", "brightline", "Brand Manager", "Nurture", "Event / tradeshow", "sofia", ("16", None), 40, 90, {}),
    ("aisha", "Aisha Rahman", "gulfmed", "General Manager", "Qualified", "Partner", "arjun", ("06", None), 4, 75, {}),
    ("omar", "Omar Haddad", "gulfmed", "Procurement Lead", "New", "Outbound", "arjun", ("14", None), 5, 20, {"cleanup": True}),
    ("rachel", "Rachel Kim", "atlas", "VP Growth", "Engaged", "Inbound", "daniel", ("07", None), -1, 130, {}),
    ("luis", "Luis Romero", "atlas", "Sales Operations", "Disqualified", "Outbound", "daniel", None, None, 110, {"disqualified_reason": "Left the company"}),
    ("ananya", "Ananya Rao", "verdant", "Founder", "Contacted", "Referral", "arjun", ("01", None), 2, 38, {}),
    ("kenji", "Kenji Mori", "lumen", "Head of Business Development", "Qualified", "Event / tradeshow", "meera", ("15", None), 3, 58, {}),
    ("mei", "Mei Tanaka", "lumen", "Operations Director", "Contacted", "Outbound", "meera", ("04", None), -1, 25, {}),
    ("giulia", "Giulia Ferri", "castell", "Marketing Lead", "Disqualified", "Outbound", "sofia", None, None, 125, {"disqualified_reason": "Account not pursuing outside agencies"}),
    ("lars", "Lars Nygaard", "northwind", "Commercial VP", "Qualified", "Partner", "daniel", ("08", None), 0, 65, {}),
    ("marta", "Marta Soler", "pinecrest", "Director of Sales", "Qualified", "Referral", "meera", ("09", None), 2, 95, {}),
    ("pablo", "Pablo Ruiz", "pinecrest", "Revenue Manager", "Engaged", "Inbound", "meera", ("02", None), 8, 40, {}),
    ("noah", "Noah Fischer", None, "Event Organiser", "New", "Event / tradeshow", "arjun", ("13", None), 10, 6, {}),
    ("chloe", "Chloe Martin", None, "Growth Consultant", "Contacted", "Inbound", "arjun", ("18", "Send case study on tradeshow ROI"), -6, 18, {}),
    ("sam", "Sam Taylor", None, "Partnerships Lead", "New", "Outbound", "sofia", ("03", None), 1, 4, {}),
]

# key, name, account, contact, owner, stage, value, currency, close offset, service line, source, risk, next (code, due offset), extra
OPPS = [
    ("norvale_li", "Norvale · LinkedIn lead generation", "norvale", "elin", "sofia", "Proposal submitted", 42000, "USD", 30,
     "LinkedIn lead generation", "Referral", "Medium", ("08", 2), {"proposal_due": -3, "teams": {"proposal": ["sofia", "meera"]}, "history": ["Qualified", "Discovery / scoping", "Solution design", "Proposal submitted"]}),
    ("norvale_gtm", "Norvale · GTM intelligence", "norvale", "victor", "sofia", "Won", 14500, "USD", None,
     "GTM intelligence", "Referral", "Low", None, {"won": (-40, 14500)}),
    ("halden_li", "Halden · LinkedIn lead generation", "halden", "priya", "arjun", "Lead identified", 18000, "EUR", 60,
     "LinkedIn lead generation", "Event / tradeshow", "Unassessed", ("05", -3), {}),
    ("halden_ts", "Halden · Tradeshow pipeline", "halden", "jonas", "arjun", "Discovery / scoping", 12000, "EUR", 90,
     "Tradeshow pipeline", "Event / tradeshow", "Low", None, {"nurture": ("Budget unavailable", 20, "17", None)}),
    ("kestrel_tl", "Kestrel · Thought leadership series", "kestrel", "grace", "meera", "Verbal commitment", 12000, "USD", 10,
     "Thought leadership", "Inbound", "Low", ("11", 0), {"history": ["Qualified", "Solution design", "Negotiation", "Verbal commitment"]}),
    ("kestrel_ts", "Kestrel · Tradeshow pipeline", "kestrel", "tom", "meera", "Won", 16200, "USD", None,
     "Tradeshow pipeline", "Inbound", "Low", None, {"won": (-75, 16200)}),
    ("oriel_ts", "Oriel · Tradeshow pipeline", "oriel", "ines", "daniel", "Negotiation", 27000, "GBP", 20,
     "Tradeshow pipeline", "Referral", "High", ("10", 1), {"high": ("Budget sign-off moved to the new CFO", "Exec sponsor call with the CFO this week"), "teams": {"database_build": ["arjun"]}}),
    ("oriel_li", "Oriel · LinkedIn lead generation", "oriel", "harry", "daniel", "Lost", 9000, "GBP", None,
     "LinkedIn lead generation", "Outbound", "Medium", None, {"lost": (-100, "No decision / went quiet", "Champion moved roles; no reply since")}),
    ("brightline_gtm", "Brightline · GTM intelligence", "brightline", "femke", "sofia", "Discovery / scoping", 15000, "EUR", 120,
     "GTM intelligence", "Event / tradeshow", "Medium", None, {"nurture": ("Timing delayed", 45, "17", None)}),
    ("gulfmed_li", "GulfMed · LinkedIn lead generation", "gulfmed", "aisha", "arjun", "Qualified", 24000, "USD", 50,
     "LinkedIn lead generation", "Partner", "Low", ("06", 4), {}),
    ("atlas_ts", "Atlas · Tradeshow pipeline", "atlas", "rachel", "daniel", "Solution design", 9600, "USD", 45,
     "Tradeshow pipeline", "Inbound", "Medium", ("07", -1), {"cleanup": True, "teams": {"database_build": ["arjun", "daniel"]}}),
    ("atlas_li", "Atlas · LinkedIn lead generation", "atlas", "rachel", "daniel", "Lost", 20000, "USD", None,
     "LinkedIn lead generation", "Inbound", "Medium", None, {"lost": (-20, "Chose a competitor", "Went with an in-house team")}),
    ("verdant_gtm", "Verdant · GTM intelligence", "verdant", "ananya", "arjun", "Lead identified", 8000, "USD", 75,
     "GTM intelligence", "Referral", "Unassessed", ("14", 7), {}),
    ("lumen_tl", "Lumen · Thought leadership series", "lumen", "kenji", "meera", "Qualified", 30000, "USD", 60,
     "Thought leadership", "Event / tradeshow", "High", ("15", 3), {"high": ("Single champion; no budget owner yet", "Map the buying group with the champion")}),
    ("castell_li", "Castell · LinkedIn lead generation", "castell", "giulia", "sofia", "Lost", 11000, "EUR", None,
     "LinkedIn lead generation", "Outbound", "Low", None, {"lost": (-60, "Budget", None)}),
    ("northwind_ts", "Northwind · Tradeshow pipeline", "northwind", "lars", "daniel", "Proposal submitted", 36000, "EUR", 25,
     "Tradeshow pipeline", "Partner", "Low", ("08", 0), {"proposal_due": -2, "teams": {"proposal": ["daniel", "meera"]}}),
    ("pinecrest_gtm", "Pinecrest · GTM intelligence", "pinecrest", "marta", "meera", "Won", 22000, "EUR", None,
     "GTM intelligence", "Referral", "Low", None, {"won": (-15, 21000)}),
    ("pinecrest_tl", "Pinecrest · Thought leadership series", "pinecrest", "pablo", "meera", "Negotiation", 18000, "EUR", 14,
     "Thought leadership", "Inbound", "Medium", ("09", 2), {}),
]

MEETINGS = [  # key, opportunity, owner, day offset, hour (UTC), minutes, action title, attendee contact
    ("m1", "norvale_li", "sofia", 2, 9, 45, "Proposal walkthrough", "elin"),
    ("m2", "oriel_ts", "daniel", 1, 14, 30, "Commercial negotiation", "ines"),
    ("m3", "kestrel_tl", "meera", 0, 16, 30, "Contract review", "grace"),
    ("m4", "gulfmed_li", "arjun", 4, 8, 60, "Discovery meeting", "aisha"),
    ("m5", "pinecrest_tl", "meera", 6, 11, 30, "Pricing discussion", "pablo"),
    ("m6", "atlas_ts", "daniel", -5, 15, 45, "Solution design workshop", "rachel"),
]

THREADS = [  # key, entity type, entity key, label, linked by
    ("t1", "opportunity", "norvale_li", "Re: Q1 pilot scope and pricing", "sofia"),
    ("t2", "opportunity", "oriel_ts", "Oriel × LeadStrategus: revised terms", "daniel"),
    ("t3", "account", "kestrel", "Kestrel quarterly review notes", "meera"),
]

NOTES = {
    "call": ["Intro call: confirmed pain points and current agency setup.", "Follow-up call: walked through last quarter's results.",
             "Call with the buying group: timelines and budget owner confirmed."],
    "note": ["Shared case study on comparable programme.", "Agreed success metrics for the pilot.", "Internal review: pricing approved by manager."],
    "email": ["Sent recap and next steps after the meeting.", "Sent proposal deck and pricing options."],
    "meeting": ["Discovery meeting held with three stakeholders.", "Workshop on target accounts and messaging."],
}


def _email(first_last: str, account: Optional[str]) -> str:
    first, last = first_last.lower().split(" ", 1)
    domain_part = next((w for k, _n, _c, _r, _i, _s, w, _o, _d in ACCOUNTS if k == account), None) if account else None
    host = domain_part.split("//")[1].replace("www.", "") if domain_part else "example.com"
    return f"{first}.{last.replace(' ', '')}@{host}"


async def is_loaded(con: asyncpg.Connection) -> bool:
    return bool(await con.fetchval("SELECT 1 FROM accounts WHERE id = $1", did("account", ACCOUNTS[0][0])))


def _all_ids() -> dict[str, list[uuid.UUID]]:
    return {
        "users": [did("user", u[0]) for u in USERS],
        "accounts": [did("account", a[0]) for a in ACCOUNTS],
        "prospects": [did("prospect", p[0]) for p in PROSPECTS],
        "opportunities": [did("opportunity", o[0]) for o in OPPS],
    }


async def load(con: asyncpg.Connection, domain_name: str, today: Optional[date] = None) -> dict:
    """Insert the demo dataset in one transaction. Refuses if any part of it
    is already there, or if a real account/user would clash with it."""
    today = today or date.today()
    day = lambda n: today + timedelta(days=n)  # noqa: E731
    ago = lambda n: datetime.combine(today - timedelta(days=n), time(9, 0), tzinfo=timezone.utc)  # noqa: E731
    if await is_loaded(con):
        raise ValueError("Demo data is already loaded. Remove it first to reload it.")
    clashes = await con.fetch("SELECT name FROM accounts WHERE name_key = ANY($1::text[])",
                              [domain.account_name_key(a[1]) for a in ACCOUNTS])
    if clashes:
        raise ValueError("Real accounts already use these demo names: " + ", ".join(r["name"] for r in clashes) + ".")
    U = {k: did("user", k) for k, *_ in USERS}
    A = {a[0]: did("account", a[0]) for a in ACCOUNTS}
    P = {p[0]: did("prospect", p[0]) for p in PROSPECTS}
    O = {o[0]: did("opportunity", o[0]) for o in OPPS}
    acc_country = {a[0]: a[2] for a in ACCOUNTS}
    counts: dict[str, int] = {}

    async with con.transaction():
        for key, name, role in USERS:
            await con.execute("INSERT INTO users(id, email, name, role) VALUES ($1, $2, $3, $4)",
                              U[key], f"demo.{key}@{domain_name}", name, role)
        for key, name, country, region, industry, status, website, owner, created in ACCOUNTS:
            await con.execute(
                "INSERT INTO accounts(id, name, name_key, country, region, industry, owner_id, status, website, notes, created_at, updated_at) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)",
                A[key], name, domain.account_name_key(name), country, region, industry, U[owner], status, website,
                "Demo data: safe to edit or remove.", ago(created))
        for key, name, acc, title, status, source, owner, action, due, created, extra in PROSPECTS:
            code, other = action or (None, None)
            reasons = ["No open next step in HubSpot: set a real next action and due date."] if extra.get("cleanup") else []
            errors, _ = domain.validate_prospect({"full_name": name, "status": status, "source": source, "owner_id": U[owner],
                                                  "next_action_code": code, "next_action_other": other,
                                                  "next_action_due": day(due) if due is not None else None, "email": "x"})
            if errors:
                raise ValueError(f"Demo prospect {name} breaks a rule: {errors}")
            await con.execute(
                "INSERT INTO prospects(id, full_name, account_id, job_title, email, phone, owner_id, status, disqualified_reason, source, "
                "next_action_code, next_action_other, next_action_due, cleanup_reasons, created_at, updated_at, last_activity_at) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)",
                P[key], name, A.get(acc), title, _email(name, acc), f"+44 20 7946 {sum(map(ord, key)) * 37 % 9000 + 1000}", U[owner], status,
                extra.get("disqualified_reason"), source, code, other, day(due) if due is not None else None, reasons,
                ago(created), ago(max(created - 10, 1)))
        for key, name, acc, contact, owner, stage, value, cur, close, line, source, risk, nxt, extra in OPPS:
            row = {
                "id": O[key], "name": name, "account_id": A[acc], "primary_contact_id": P[contact], "owner_id": U[owner], "stage": stage,
                "estimated_value": Decimal(value), "currency": cur, "expected_close": day(close) if close is not None else None,
                "geography": acc_country[acc], "service_line": line, "deal_source": source, "risk_rating": risk,
                "next_action_code": nxt[0] if nxt else None, "next_action_due": day(nxt[1]) if nxt else None,
                "created_at": ago(150 if stage in ("Won", "Lost") else 70), "cleanup_reasons":
                ["HubSpot stage wasn’t mapped: imported as Lead identified."] if extra.get("cleanup") else [],
            }
            if "proposal_due" in extra:
                row["proposal_due"] = day(extra["proposal_due"])
            if "high" in extra:
                row["high_risk_reason"], row["risk_mitigation"] = extra["high"]
            if "won" in extra:
                row["won_date"], row["actual_value"] = day(extra["won"][0]), Decimal(extra["won"][1])
            if "lost" in extra:
                row["lost_date"], row["lost_reason"], row["lost_notes"] = day(extra["lost"][0]), extra["lost"][1], extra["lost"][2]
            if "nurture" in extra:
                reason, until, ncode, nother = extra["nurture"]
                row.update(on_nurture=True, nurture_reason=reason, nurture_until=day(until), nurture_owner_id=U[owner],
                           nurture_next_action_code=ncode, nurture_next_action_other=nother)
            errors, _ = domain.validate_opportunity(row, today)
            if errors:
                raise ValueError(f"Demo opportunity {name} breaks a rule: {errors}")
            row["updated_at"] = row["created_at"]
            cols = list(row)
            await con.execute(f"INSERT INTO opportunities ({', '.join(cols)}) VALUES ({', '.join(f'${i}' for i in range(1, len(cols) + 1))})",
                              *row.values())
            for team, members in extra.get("teams", {}).items():
                for m in members:
                    await con.execute("INSERT INTO opportunity_team(opportunity_id, user_id, team) VALUES ($1, $2, $3)", O[key], U[m], team)
            stages = extra.get("history", [])
            for i in range(1, len(stages)):
                await con.execute(
                    "INSERT INTO record_history(entity_type, entity_id, field, old_value, new_value, changed_by, changed_at) "
                    "VALUES ('opportunity', $1, 'stage', $2, $3, $4, $5)", O[key], stages[i - 1], stages[i], U[owner], ago(60 - i * 12))
        counts["opportunities"] = len(OPPS)

        # Timelines: two entries per opportunity, one per prospect.
        n = 0
        kinds = ["call", "note", "email", "meeting"]
        for i, (key, _name, _acc, _contact, owner, *_rest) in enumerate(OPPS):
            for j in range(2):
                kind = kinds[(i + j) % 4]
                await con.execute(
                    "INSERT INTO activities(id, entity_type, entity_id, kind, summary, occurred_at, created_by) VALUES ($1, 'opportunity', $2, $3, $4, $5, $6)",
                    did("activity", f"{key}:{j}"), O[key], kind, NOTES[kind][(i + j) % len(NOTES[kind])], ago(30 - j * 14 - i % 5), U[owner])
                n += 1
        for i, (key, _name, _acc, _title, status, _src, owner, *_rest) in enumerate(PROSPECTS):
            kind = "email" if status == "New" else kinds[i % 3]
            await con.execute(
                "INSERT INTO activities(id, entity_type, entity_id, kind, summary, occurred_at, created_by) VALUES ($1, 'prospect', $2, $3, $4, $5, $6)",
                did("activity", key), P[key], kind, NOTES[kind][i % len(NOTES[kind])], ago(3 + i % 20), U[owner])
            n += 1
        counts["activities"] = n

        for key, opp, owner, offset, hour, minutes, action, contact in MEETINGS:
            o = next(x for x in OPPS if x[0] == opp)
            acc_name = next(a[1] for a in ACCOUNTS if a[0] == o[2])
            starts = datetime.combine(day(offset), time(hour, 0), tzinfo=timezone.utc)
            await con.execute(
                "INSERT INTO meetings(id, entity_type, entity_id, owner_id, title, description, starts_at, ends_at, time_zone, attendees, "
                "sync_status, sync_error, created_by) VALUES ($1, 'opportunity', $2, $3, $4, $5, $6, $7, 'Europe/London', $8, 'not_connected', $9, $3)",
                did("meeting", key), O[opp], U[owner], f"{acc_name} — {action}", "Demo meeting.", starts, starts + timedelta(minutes=minutes),
                [_email(next(p[1] for p in PROSPECTS if p[0] == contact), o[2])], "Demo data: not sent to Google Calendar.")
        for key, owner, label in (("b1", "sofia", "30-min discovery call"), ("b2", "meera", "Quarterly review (45 min)")):
            await con.execute("INSERT INTO booking_links(id, owner_id, name, url) VALUES ($1, $2, $3, $4)",
                              did("booking", key), U[owner], label, f"https://calendar.app.google/demo{key}{owner}")
        for key, etype, ekey, label, by in THREADS:
            eid = O[ekey] if etype == "opportunity" else A[ekey]
            await con.execute(
                "INSERT INTO email_threads(id, entity_type, entity_id, thread_ref, url, label, linked_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                did("thread", key), etype, eid, f"FMfcgzDemo{key}ThreadRef00", f"https://mail.google.com/mail/u/0/#inbox/FMfcgzDemo{key}ThreadRef00", label, U[by])
        counts.update(users=len(USERS), accounts=len(ACCOUNTS), prospects=len(PROSPECTS), meetings=len(MEETINGS),
                      booking_links=2, gmail_threads=len(THREADS))
    return counts


async def remove(con: asyncpg.Connection) -> dict:
    """Delete exactly the demo rows (fixed IDs) and what hangs off them.
    Real records that were linked to demo ones are unlinked, not deleted."""
    ids = _all_ids()
    users, accounts, prospects, opps = ids["users"], ids["accounts"], ids["prospects"], ids["opportunities"]
    entities = accounts + prospects + opps
    kept: list[str] = []
    async with con.transaction():
        await con.execute("DELETE FROM task_links WHERE entity_id = ANY($1::uuid[])", entities)
        await con.execute("DELETE FROM meetings WHERE entity_id = ANY($1::uuid[]) OR owner_id = ANY($2::uuid[])", entities, users)
        await con.execute("DELETE FROM email_threads WHERE entity_id = ANY($1::uuid[])", entities)
        await con.execute("DELETE FROM activities WHERE entity_id = ANY($1::uuid[])", entities)
        await con.execute("DELETE FROM record_history WHERE entity_id = ANY($1::uuid[])", entities)
        await con.execute("DELETE FROM booking_links WHERE owner_id = ANY($1::uuid[])", users)
        # Real opportunities pointing at a demo contact keep their record.
        await con.execute("UPDATE opportunities SET primary_contact_id = NULL WHERE primary_contact_id = ANY($1::uuid[]) AND NOT id = ANY($2::uuid[])",
                          prospects, opps)
        await con.execute("DELETE FROM opportunity_team WHERE opportunity_id = ANY($1::uuid[])", opps)
        await con.execute("DELETE FROM opportunities WHERE id = ANY($1::uuid[])", opps)
        await con.execute("UPDATE prospects SET account_id = NULL WHERE account_id = ANY($1::uuid[]) AND NOT id = ANY($2::uuid[])", accounts, prospects)
        await con.execute("DELETE FROM prospects WHERE id = ANY($1::uuid[])", prospects)
        # An account a real opportunity was added to stays (it can't lose its account).
        for r in await con.fetch("SELECT DISTINCT a.id, a.name FROM accounts a JOIN opportunities o ON o.account_id = a.id WHERE a.id = ANY($1::uuid[])", accounts):
            kept.append(r["name"])
        await con.execute("DELETE FROM accounts WHERE id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.account_id = accounts.id)", accounts)
        # Demo users still referenced by real data (e.g. as an owner) are deactivated instead.
        for uid in users:
            try:
                async with con.transaction():
                    await con.execute("DELETE FROM calendar_sync_log WHERE user_id = $1", uid)
                    await con.execute("DELETE FROM calendar_connections WHERE user_id = $1", uid)
                    await con.execute("DELETE FROM users WHERE id = $1", uid)
            except asyncpg.ForeignKeyViolationError:
                await con.execute("UPDATE users SET active = false WHERE id = $1", uid)
                kept.append(await con.fetchval("SELECT name FROM users WHERE id = $1", uid))
    return {"removed": True, "kept": kept}
