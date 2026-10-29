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
| 2b | Frontend: Reports & metrics, Settings (lists, reminders, users & roles, integrations, export & backup, launch checklist), Meetings & booking links, Import from HubSpot | **Done**: Reports, users & roles, CSV export live; Meetings opens a pre-filled Google Calendar event and logs it; Import is a review-only wizard until Phase 3 |
| 3 | HubSpot import backend (accounts, contacts, deals, activity history) | Planned (UI ready) |
| 4 | Google Calendar + Meet API sync, shared booking links | Planned (Gmail links and Calendar hand-off done) |
| 5 | Editable controlled lists, reminder toggles, shared launch checklist | Planned (Reports done) |

## Layout

```
backend/
  app/domain.py        spec rules: lists, stages, validation, follow-up logic (no I/O)
  app/migrations/      plain SQL, applied in order on startup
  app/auth.py          Google ID-token sign-in (Workspace domain only) + role checks
  app/routers/         accounts, prospects, opportunities, actions, reports, admin
  scripts/seed_demo.py sample data for a local dev database
  tests/               rule tests (no DB) + API tests (real Postgres)
frontend/
  src/types.ts         TypeScript types for every API response
  src/pages/           My Actions, Prospects, Pipeline, records, views, Reports, Settings, Meetings, Import (.tsx)
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
| §5 Next Action list, “Other” ≤ 50 chars, mandatory follow-up | `domain.NEXT_ACTIONS`, `POST …/complete-action`, `NextActionFields` in `frontend/src/ui.jsx` |
| §5.4 escalation after N business days | `GET /api/actions` (`escalated`), `CRM_ESCALATION_BUSINESS_DAYS` |
| §7 views | My Actions, Prospects, Pipeline, Forecast & views pages |
| §8.1 roles (proposed: confirm) | `auth.py`: salesperson edits own records; manager/admin edit all; admin manages users |
| §8.3 history & audit | `record_history` table, history panel on every record, `GET /api/export/history.csv` |
| Currencies never summed | every total is keyed by currency |

## Deploy: Render (free) + Neon (free)

1. **Neon:** create a project at console.neon.tech, then **Connect** → copy
   the connection string. The direct one (host without `-pooler`) is
   recommended; the pooled one also works. Tables are created automatically
   on the API's first start.
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
