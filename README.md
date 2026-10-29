# LeadStrategus CRM

Internal, lightweight CRM built to the *Lightweight CRM Build Specification v2*:
Accounts, Prospects/Contacts, Opportunities and Next Actions, with
disciplined follow-up, risk and nurture rules, and Google Workspace
integration. Staff only (Google Workspace sign-in).

| Layer | Stack |
|---|---|
| Backend | FastAPI (Python 3.12) + asyncpg |
| Frontend | TypeScript + React, built with Node.js 20 and Vite |
| Database | Neon (serverless PostgreSQL) |
| Hosting | Render free tier: API as a free web service, frontend as a free static site |

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Database, API, all spec validation rules, Google sign-in, roles, history, My Actions, pipeline/forecast totals, CSV export, tests | **Done** (`backend/`) |
| 2 | Frontend: My Actions, Prospects, Pipeline, Opportunity/Prospect/Account records, quick create, saved views | **Done** (`frontend/`) |
| 2b | Frontend: Reports & metrics, Settings (lists, reminders, users & roles, integrations, export & backup, launch checklist), Meetings & booking links, Import from HubSpot | **Done**: Reports, users & roles, CSV export live; Meetings opens a pre-filled Google Calendar event and logs it |
| 3 | HubSpot import: owners, companies, contacts, deals, associations, notes/calls/meetings/tasks, logged emails; re-runnable; Needs cleanup queue | **Done** (`backend/app/importer.py`) |
| 4 | Google Calendar + Meet sync per user (create, update, cancel, retry, sync log), shared booking links, Gmail links | **Done** (`backend/app/google_calendar.py`, `routers/calendar.py`) |
| 5 | Editable controlled lists, reminder toggles, shared launch checklist | Planned (Reports done) |

## Layout

```
backend/
  app/domain.py        spec rules: lists, stages, validation, follow-up logic (no I/O)
  app/migrations/      plain SQL, applied in order on startup
  app/auth.py          Google ID-token sign-in (Workspace domain only) + role checks
  app/routers/         accounts, prospects, opportunities, actions, reports, admin, hubspot_import, calendar
  app/hubspot.py       read-only HubSpot CRM v3 client (paging, 429 retry)
  app/importer.py      HubSpot → CRM mapping and the import run
  app/google_calendar.py  per-user Google OAuth + Calendar events (encrypted refresh tokens)
  scripts/seed_demo.py sample data for a local dev database
  tests/               rule tests (no DB) + API tests (real Postgres)
frontend/
  src/types.ts         TypeScript types for every API response
  src/pages/           My Actions, Prospects, Pipeline, records, views, Reports, Settings, Meetings, Import, Needs cleanup (.tsx)
  src/components/      quick create, activity timeline + history
render.yaml            Render blueprint: API + static site, both on the free plan
```

## Run locally

Needs Python 3.12+, Node 20+ and a Postgres database.

```bash
# API on :8100
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env        # set CRM_DATABASE_URL; CRM_DEV_AUTH=true for local use
uvicorn app.main:app --reload --port 8100
python scripts/seed_demo.py http://localhost:8100   # optional sample data

# Frontend on :5174 (proxies /api to :8100)
cd ../frontend
npm install
echo "VITE_DEV_USER=you@leadstrategus.com" > .env.local   # local only, with CRM_DEV_AUTH=true
npm run dev
npm run typecheck   # tsc --noEmit (also part of npm run build)
```

API docs: http://localhost:8100/docs. In production the frontend uses Google
sign-in: set `VITE_GOOGLE_CLIENT_ID` (frontend) and `CRM_GOOGLE_CLIENT_ID`
(API) to the OAuth client of an **Internal** Google Cloud app, and leave
`CRM_DEV_AUTH` false.

## Tests

```bash
cd backend
createdb crm_test
CRM_TEST_DATABASE_URL=postgresql://USER:PASS@localhost/crm_test pytest
```

The test database's `public` schema is dropped and recreated. Without
`CRM_TEST_DATABASE_URL` only the pure rule tests run. CI runs both
(`.github/workflows/backend-tests.yml`), and type-checks and builds the
frontend (`.github/workflows/frontend-checks.yml`).

## How the spec maps to the code

| Spec | Where |
|---|---|
| §2 fields, §2.4 one account → many prospects/opportunities | `backend/app/migrations/001_init.sql`, `/api/accounts`, `/api/prospects`, `/api/opportunities` |
| Duplicate accounts | normalised name key (unique) + `GET /api/accounts/duplicates?name=`, warning in quick create |
| §3 statuses, stages, probabilities, weighted value | `domain.STAGES`, `GET /api/lists`, `GET /api/reports/pipeline`, Pipeline page |
| §4 risk rating, Put on Nurture?, revisit outcomes | `domain.validate_opportunity`, `POST /api/opportunities/{id}/revisit`, My Actions revisit panel |
| §5 Next Action list, “Other” ≤ 50 chars, mandatory follow-up | `domain.NEXT_ACTIONS`, `POST …/complete-action`, `NextActionFields` in `frontend/src/ui.tsx` |
| §5.4 escalation after N business days | `GET /api/actions` (`escalated`), `CRM_ESCALATION_BUSINESS_DAYS` |
| §7 views | My Actions, Prospects, Pipeline, Forecast & views pages |
| §8.1 roles (proposed: confirm) | `auth.py`: salesperson edits own records; manager/admin edit all; admin manages users |
| §8.3 history & audit | `record_history` table, history panel on every record, `GET /api/export/history.csv` |
| Currencies never summed | every total is keyed by currency |
| §6 Calendar + Meet: event ID stored, no duplicates, failures visible + retry | `routers/calendar.py` (`sync_meeting`), `meetings` + `calendar_sync_log` tables, Meetings page |
| HubSpot import | `app/importer.py`, `/api/import/hubspot/*`, Import page; rule-breaking records listed at `/api/import/cleanup` (Needs cleanup page) |

## Google Calendar + Meet sync

Each person connects their own calendar from **Meetings & booking**. A
meeting scheduled in the CRM is saved first (and logged on the linked
prospect or opportunity), then created in the owner's Google Calendar with
a Meet link and invites. The Google event ID is stored, so editing or
cancelling the meeting changes that same event; a create that is retried
after a lost reply finds the event instead of adding a second one. Every
attempt is in the sync log; failures stay on the meeting with **Retry
sync**. Meetings saved before someone connects are pushed when they do.

Setup, in the same Google Cloud project as sign-in (no cost: the Calendar
API is free within its usage quotas):

1. **APIs & Services → Library:** enable **Google Calendar API**.
2. **OAuth consent screen:** user type **Internal**; add the scope
   `.../auth/calendar.events`.
3. **Credentials →** the existing *Web* OAuth client: add
   `https://<your-api>.onrender.com/api/calendar/oauth/callback` under
   *Authorised redirect URIs*, and copy the client secret.
4. **Render (API service):** set `CRM_GOOGLE_CLIENT_SECRET` and
   `CRM_PUBLIC_API_URL` (the API's own URL). `CRM_TOKEN_KEY` is generated
   by the blueprint; it encrypts stored refresh tokens, so keep it stable
   (changing it means everyone reconnects).

Until these are set, the Meetings page still works: it opens a pre-filled
Google Calendar event and logs the meeting on the record.

Booking links are Google Calendar **appointment schedules** (Google runs
the booking page, free/busy check and invites); the CRM keeps a shared,
team-wide list of them.

## HubSpot import

1. In HubSpot (super-admin): **Settings → Integrations → Private apps →
   Create a private app** with read-only scopes for companies, contacts,
   deals and owners, plus notes, calls, meetings, tasks and emails if you
   want activity history. Private apps cost nothing extra on any plan.
2. Set the token as `CRM_HUBSPOT_TOKEN` on the API service in Render. It is
   never typed into the browser.
3. In the CRM, as an admin: **Import from HubSpot** → test the connection,
   choose objects, check the stage mapping, review the data-quality check,
   then start the import and watch its progress.

How it behaves:

- **Re-runnable.** Every record keeps its HubSpot ID. Running it again
  refreshes records the import created, adds new ones and never
  duplicates. Records someone has edited in the CRM since, and records that
  already existed in the CRM before the import (matched by company domain or
  name, or contact email), are kept as they are.
- **Nothing is dropped or silently fixed.** Records that break a CRM rule
  (no next step, Qualified with no value or risk rating, Won with no value,
  no company, unmatched owner) are imported and listed in **Needs cleanup**
  for their owner. Saving a fixed record removes it from the list.
- **Owners** are matched by work email; leadstrategus.com owners without a
  CRM user are added as salespeople. Other owners' records go to the admin
  who ran the import, flagged.
- **Emails:** only subject, date and direction are stored, never bodies.
- **Free tier:** keep the Import page open until it finishes. Render's free
  API sleeps when nothing is calling it, which would interrupt a long
  import; the open page polls the progress and keeps it awake. An
  interrupted run is marked as such and can simply be run again.

## Deploy: Render (free) + Neon (free)

1. **Neon:** create a project at console.neon.tech, then **Connect** → copy
   the connection string. The direct one (host without `-pooler`) is
   recommended; the pooled one also works. Tables are created automatically
   on the API's first start.
   **Free plan settings:** pick the region closest to your Render region
   (e.g. AWS Frankfurt with Render Frankfurt). Under **Branches → main →
   Compute**, set the autoscaling **maximum to 0.25 CU**: the free plan's
   monthly CU-hours then cover about 400 active hours, plenty for working
   hours, because the database suspends after 5 minutes idle (always on in
   Free) and the API closes idle connections after 2 minutes so it can.
   Free storage (1 GB per project at the time of writing) holds years of
   CRM records; check Neon's plans page for current limits. If the CU-hours
   run out, Neon suspends the database until the next month or an upgrade.
2. **Google:** in Google Cloud, create an OAuth client (type *Web*) for an app
   with user type **Internal**. Add the static site's URL to *Authorised
   JavaScript origins*.
3. **Render:** **New → Blueprint** → pick this repo. `render.yaml` creates:
   - `leadstrategus-crm-api` (FastAPI, free web service). Set
     `CRM_DATABASE_URL`, `CRM_GOOGLE_CLIENT_ID`, `CRM_ADMIN_EMAILS` and
     `CRM_FRONTEND_ORIGIN` (the static site's URL).
   - `leadstrategus-crm` (React + TypeScript, free static site). Set
     `VITE_API_URL` (the API's URL) and `VITE_GOOGLE_CLIENT_ID`.
   Because the two URLs reference each other, deploy once, copy each
   service's `onrender.com` URL into the other's variable, then redeploy.
   `CRM_DEV_AUTH` must stay `false`.

**Free-tier behaviour to expect**

- The API **sleeps after ~15 minutes without traffic**. The first request
  after that takes up to about a minute while it wakes; the frontend waits
  up to 90 seconds and shows a "waking up" message instead of failing.
  The static site itself never sleeps.
- Free web services get 750 instance hours a month per workspace, enough
  for one service running all month. Moving the API to Render's smallest
  paid instance removes the sleep.
- Neon's free plan also suspends an idle database and resumes it on the
  next query (usually within a second or two). The API recycles idle
  connections so a resumed database is picked up cleanly.
