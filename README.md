# LeadStrategus CRM

Internal, lightweight CRM built to the *Lightweight CRM Build Specification v2*:
Accounts, Prospects/Contacts, Opportunities and Next Actions, with
disciplined follow-up, risk and nurture rules, and Google Workspace
integration. Staff only (Google Workspace sign-in).

Stack: FastAPI + asyncpg on Postgres (Neon) for the API, React + Vite for the frontend.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Database, API, all spec validation rules, Google sign-in, roles, history, My Actions, pipeline/forecast totals, CSV export, tests | **Done** (`backend/`) |
| 2 | Frontend: My Actions, Prospects, Pipeline, Opportunity/Prospect/Account records, quick create, saved views | **Done** (`frontend/`) |
| 3 | HubSpot import (accounts, contacts, deals, activity history) | Planned |
| 4 | Google Calendar + Meet, booking links, Gmail contextual links | Planned (Gmail links done) |
| 5 | Reports page, editable controlled lists, launch checklist | Planned |

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
  src/pages/           My Actions, Prospects, Pipeline, records, views
  src/components/      quick create, activity timeline + history
render.yaml            Render blueprint for the API
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
(`.github/workflows/backend-tests.yml`).

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

## Deploy (Render)

`render.yaml` defines the API service: **New → Blueprint**, pick this repo,
then set the environment values from `backend/.env.example`. The frontend
is a static site: build command `npm install && npm run build`, publish
directory `frontend/dist`, with `VITE_API_URL` and `VITE_GOOGLE_CLIENT_ID` set
and a rewrite of `/*` to `/index.html` for client-side routes.
