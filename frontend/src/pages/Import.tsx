// Import from HubSpot: connect → choose objects → map stages & fields →
// data-quality check → import. Admin only; the HubSpot token lives on the
// server (CRM_HUBSPOT_TOKEN) and is never typed into the browser.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api, downloadFile } from '../api'
import { fmtDateTime } from '../format'
import { useSession } from '../session'
import type { HubSpotSummary, HubSpotTest, ImportObject, ImportRun, ImportStatus, QualityIssue } from '../types'
import { Banner, ErrorBanner, SelectField, useLoad } from '../ui'

const STEPS = ['Connect', 'Choose objects', 'Map stages & fields', 'Data quality', 'Import']

const OBJECTS: { key: ImportObject; from: string; to: string; help: string; count: (t: Record<string, number | null>) => number | null }[] = [
  { key: 'owners', from: 'Owners', to: 'Users', help: 'Matched by work email. leadstrategus.com owners without a CRM user are added as salespeople.', count: (t) => t.owners },
  { key: 'companies', from: 'Companies', to: 'Accounts', help: 'Name, domain, country, industry, owner. Duplicates merged by domain or name.', count: (t) => t.companies },
  { key: 'contacts', from: 'Contacts', to: 'Prospects / contacts', help: 'Linked to accounts; contacts without a company stay unlinked.', count: (t) => t.contacts },
  { key: 'deals', from: 'Deals', to: 'Opportunities', help: 'All pipelines, open and closed, with amount and close date.', count: (t) => t.deals },
  { key: 'associations', from: 'Associations', to: 'Record links', help: 'Contact ↔ company ↔ deal.', count: () => null },
  { key: 'activity', from: 'Notes, calls, meetings, tasks', to: 'Activity history', help: 'Kept on the timeline; open tasks become next actions where they map.',
    count: (t) => sumOrNull([t.notes, t.calls, t.meetings, t.tasks]) },
  { key: 'emails', from: 'Logged emails', to: 'Activity history (minimal)', help: 'Subject, date and direction only; bodies are not stored.', count: (t) => t.emails },
]
const LEAD_STATUS_LABEL: Record<string, string> = {
  NEW: 'New', OPEN: 'Open', ATTEMPTED_TO_CONTACT: 'Attempted to contact', CONNECTED: 'Connected', IN_PROGRESS: 'In progress',
  OPEN_DEAL: 'Open deal', BAD_TIMING: 'Bad timing', UNQUALIFIED: 'Unqualified',
}
const FIELDS: [string, string][] = [
  ['dealname', 'Opportunity name'], ['amount', 'Estimated value (and actual value when won)'], ['deal_currency_code', 'Currency'],
  ['closedate', 'Expected close / won / lost date'], ['hubspot_owner_id', 'Owner'], ['closed_lost_reason', 'Lost reason (mapped to list, original kept in notes)'],
  ['hs_object_id', 'HubSpot ID (kept for re-runs)'],
]
const PHASES: [keyof ImportRun['progress'], string][] = [
  ['owners', 'Owners → users'], ['companies', 'Accounts'], ['contacts', 'Prospects / contacts'], ['deals', 'Opportunities'], ['activity', 'Activity history'],
]
const COUNT_LABEL: Record<string, string> = { users: 'Users', accounts: 'Accounts', prospects: 'Prospects', opportunities: 'Opportunities', activities: 'Activities' }

function sumOrNull(xs: (number | null | undefined)[]): number | null {
  return xs.some((x) => x == null) ? null : xs.reduce<number>((a, b) => a + (b as number), 0)
}

function RunView({ run }: { run: ImportRun }) {
  const [error, setError] = useState<ApiError | null>(null)
  const tone = run.status === 'succeeded' ? 'ok' : run.status === 'running' ? 'warn' : 'err'
  return (
    <section className="card strong" aria-label="Import progress" aria-live="polite">
      <div className="card-head">
        <h2>{run.status === 'running' ? 'Importing…' : run.status === 'succeeded' ? 'Import finished' : 'Import stopped'}</h2>
        <span className="muted small">Started {fmtDateTime(run.started_at)}{run.finished_at ? ` · finished ${fmtDateTime(run.finished_at)}` : ''}</span>
      </div>
      {run.message && <Banner kind={tone}>{run.message}</Banner>}
      {PHASES.filter(([k]) => run.progress[k]).map(([k, label]) => {
        const p = run.progress[k]!
        const pct = p.state === 'done' ? 100 : p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : p.state === 'running' ? 50 : 0
        return (
          <div className="bar-row" key={k}>
            <span>{label}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%`, background: p.state === 'done' ? 'var(--teal)' : '#2E5EAA' }} /></div>
            <span className="small">{p.state === 'done' ? `Done · ${p.done}` : p.state === 'running' ? `${p.done}${p.total ? ` of ${p.total}` : ''}` : 'Waiting'}</span>
          </div>
        )
      })}
      {Object.keys(run.counts).length > 0 && (
        <div className="table-wrap">
          <table style={{ minWidth: 520 }}>
            <thead><tr><th>Record</th><th>New</th><th>Updated</th><th>Kept (edited in CRM)</th><th>Linked / merged</th><th>Failed</th></tr></thead>
            <tbody>
              {Object.entries(run.counts).map(([k, c]) => (
                <tr key={k}><td style={{ fontWeight: 600 }}>{COUNT_LABEL[k] || k}</td><td>{c.created || 0}</td><td>{c.updated || 0}</td><td>{c.kept || 0}</td><td>{c.merged || 0}</td><td>{c.failed || 0}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {run.status !== 'running' && (
        <div className="row">
          <Link className="btn btn-dark" to="/cleanup">Open “Needs cleanup”</Link>
          <button type="button" className="btn" disabled={!run.error_count}
            onClick={() => downloadFile(`/import/hubspot/runs/${run.id}/errors.csv`, `hubspot-import-${run.id}.csv`).catch((e: ApiError) => setError(e))}>
            Download issue log ({run.error_count})
          </button>
        </div>
      )}
      <span className="muted small">Re-running is safe: records keep their HubSpot ID, so nothing is duplicated, and records someone has edited in the CRM since are kept as they are.</span>
    </section>
  )
}

export default function Import() {
  const { user } = useSession()
  const admin = user.role === 'admin'
  const status = useLoad(() => (admin ? api<ImportStatus>('/import/hubspot/status') : Promise.resolve(null)), [admin])
  const [step, setStep] = useState(0)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [conn, setConn] = useState<HubSpotTest | null>(null)
  const [summary, setSummary] = useState<HubSpotSummary | null>(null)
  const [off, setOff] = useState<Partial<Record<ImportObject, boolean>>>({})
  const [stageMap, setStageMap] = useState<Record<string, string>>({})
  const [issues, setIssues] = useState<QualityIssue[] | null>(null)
  const [run, setRun] = useState<ImportRun | null>(null)
  const { lists } = useSession()
  const configured = !!status.data?.configured

  // Poll a running import.
  useEffect(() => {
    if (run?.status !== 'running') return
    const t = window.setTimeout(() => {
      api<ImportRun>(`/import/hubspot/runs/${run.id}`).then(setRun).catch((e: ApiError) => setError(e))
    }, 1500)
    return () => window.clearTimeout(t)
  }, [run])

  // Resume showing an import that is already running.
  useEffect(() => {
    if (status.data?.last_run?.status === 'running') { setRun(status.data.last_run); setStep(4) }
  }, [status.data])

  async function call<T>(fn: () => Promise<T>, then: (v: T) => void) {
    setBusy(true)
    setError(null)
    try { then(await fn()) } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
  }
  const testConnection = () => call(() => api<HubSpotTest>('/import/hubspot/test', { method: 'POST' }), (v) => { setConn(v); void loadSummary() })
  const loadSummary = () => call(() => api<HubSpotSummary>('/import/hubspot/summary'), (s) => {
    setSummary(s)
    setStageMap((m) => ({ ...s.suggested_stage_map, ...m }))
    setStep(1)
  })
  const checkQuality = () => call(() => api<{ issues: QualityIssue[] }>('/import/hubspot/preview', { method: 'POST', body: { stage_map: stageMap } }), (r) => { setIssues(r.issues); setStep(3) })
  const startImport = () => call(() => api<ImportRun>('/import/hubspot/runs', {
    method: 'POST', body: { objects: OBJECTS.filter((o) => !off[o.key]).map((o) => o.key), stage_map: stageMap },
  }), (r) => { setRun(r); setStep(4) })

  const reachable = (i: number) => i === 0 || (i <= 2 && !!summary) || (i === 3 && !!issues) || (i === 4 && (!!issues || !!run))
  const totals = summary?.totals || {}

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import from HubSpot</h1>
          <p>Bring companies, contacts, deals and activity history into Accounts, Prospects and Opportunities. Every record keeps its HubSpot ID, so the import can be re-run during the pilot.</p>
        </div>
      </div>
      {!admin && <Banner kind="warn">Only admins can run the import. Imported records that need attention appear in <Link to="/cleanup">Needs cleanup</Link>.</Banner>}
      {admin && <>
        <ErrorBanner error={status.error || error} onClose={() => setError(null)} />
        {status.data?.last_run && !run && (
          <p className="muted small" style={{ margin: 0 }}>Last import: {status.data.last_run.status} · {fmtDateTime(status.data.last_run.started_at)}{status.data.last_run.message ? ` · ${status.data.last_run.message}` : ''}</p>
        )}

        <nav className="steps" aria-label="Import steps">
          {STEPS.map((label, i) => (
            <button key={label} type="button" aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : undefined}
              disabled={!reachable(i) || run?.status === 'running'} onClick={() => setStep(i)}>
              <span className="mono">{i < step ? '✓' : i + 1}</span> {label}
            </button>
          ))}
        </nav>

        {step === 0 && (
          <section className="card strong" aria-label="Connect HubSpot">
            <h2>Connect HubSpot (read-only)</h2>
            {status.data && (configured
              ? <Banner>HubSpot token found on the server. Test the connection to continue.</Banner>
              : <Banner kind="warn">No HubSpot token on the server yet. Follow the steps below, then reload this page.</Banner>)}
            <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li>In HubSpot: <strong>Settings › Integrations › Private apps › Create a private app</strong> (needs HubSpot super-admin).</li>
              <li>Give it read-only scopes: <span className="mono">crm.objects.companies.read</span>, <span className="mono">crm.objects.contacts.read</span>, <span className="mono">crm.objects.deals.read</span>, <span className="mono">crm.objects.owners.read</span>. For activity history, also tick the read scopes for notes, calls, meetings, tasks and emails where HubSpot offers them (their names vary by account). The next step shows anything the app still can’t read.</li>
              <li>Copy the access token and add it on Render as <span className="mono">CRM_HUBSPOT_TOKEN</span> on the API service (Environment tab). Render restarts the API.</li>
            </ol>
            <p className="muted small" style={{ margin: 0 }}>The token stays on the server and is never pasted into the browser or into chat. It can be revoked in HubSpot at any time. Private apps are available on every HubSpot plan at no extra cost.</p>
            {conn && <Banner>Connected to HubSpot portal {conn.portal_id} · {conn.owners} owners · currency {conn.currency || '—'} · {conn.time_zone || ''}</Banner>}
            <div className="row">
              <button type="button" className="btn btn-dark" disabled={!configured || busy} onClick={() => void testConnection()}>{busy ? 'Checking…' : 'Test connection & continue'}</button>
            </div>
          </section>
        )}

        {step === 1 && summary && (
          <section className="card" aria-label="Choose what to bring over">
            <h2>Choose what to bring over</h2>
            {summary.missing_scopes.length > 0 && (
              <Banner kind="warn">The private app can’t read: {summary.missing_scopes.join(', ')}. Add the missing scopes in HubSpot to include them; the rest still imports.</Banner>
            )}
            <div>
              {OBJECTS.map((o) => {
                const n = o.count(totals)
                return (
                  <label className="list-row check" key={o.key} style={{ justifyContent: 'flex-start' }}>
                    <input type="checkbox" checked={!off[o.key]} onChange={() => setOff({ ...off, [o.key]: !off[o.key] })} />
                    <span style={{ flex: '1 1 300px' }}><strong>{o.from} → {o.to}</strong><br /><span className="muted small">{o.help}</span></span>
                    <span className="mono">{n == null ? '—' : n.toLocaleString('en-US')}</span>
                  </label>
                )
              })}
            </div>
            <p className="muted small" style={{ margin: 0 }}>Out of scope, so not imported: marketing emails, workflows, sequences, forms and landing pages (spec §1).</p>
            <div className="row"><button type="button" className="btn btn-dark" onClick={() => setStep(2)}>Continue to mapping</button></div>
          </section>
        )}

        {step === 2 && summary && (
          <div className="cols">
            <section className="card col-main" aria-label="Deal stage mapping">
              <h2>HubSpot deal stage → opportunity stage</h2>
              {summary.pipelines.length === 0 && <p className="muted" style={{ margin: 0 }}>No deal pipelines found.</p>}
              {summary.pipelines.map((p) => (
                <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {summary.pipelines.length > 1 && <h3 className="small">{p.label || p.id}</h3>}
                  <div className="grid-fields">
                    {p.stages.map((s) => (
                      <SelectField key={s.id} label={`${s.label || s.id}${s.probability != null ? ` · ${Math.round(Number(s.probability) * 100)}%` : ''}`}
                        value={stageMap[s.id]} onChange={(v) => setStageMap({ ...stageMap, [s.id]: v || stageMap[s.id] })}
                        options={lists.stages.map((st) => ({ value: st.name, label: `${st.name} · ${st.probability}%` }))} />
                    ))}
                  </div>
                </div>
              ))}
              <span className="muted small">Suggested from HubSpot’s stage names and probabilities. Check each one: it decides the stage, probability and forecast of every imported deal.</span>
            </section>
            <section className="card col-side" aria-label="Status and field mapping">
              <h2>Lead status → prospect status</h2>
              <div>{Object.entries(summary.lead_status_map).map(([hs, to]) => <div className="list-row" key={hs}><span className="small">{LEAD_STATUS_LABEL[hs] || hs}</span><span>→ {to}</span></div>)}</div>
              <h2>Fields</h2>
              <div>{FIELDS.map(([hs, to]) => <div className="list-row" key={hs}><span className="mono small">{hs}</span><span className="small">{to}</span></div>)}</div>
            </section>
            <div className="row" style={{ flexBasis: '100%' }}>
              <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void checkQuality()}>{busy ? 'Reading HubSpot…' : 'Check data quality'}</button>
            </div>
          </div>
        )}

        {step === 3 && issues && (
          <section className="card" aria-label="Data quality">
            <h2>Data quality check before import</h2>
            <p className="muted" style={{ margin: 0 }}>Records that break the CRM’s rules are still imported, but they land in <Link to="/cleanup">Needs cleanup</Link> for their owner instead of being dropped or silently fixed.</p>
            <div>
              {issues.map((i) => (
                <div className="list-row" key={i.key}>
                  <span style={{ flex: '1 1 320px' }}><strong>{i.rule}</strong><br /><span className="muted small">{i.fix}</span></span>
                  <span className={`pill pill-${i.count ? i.severity : 'teal'}`}>{i.count ? i.count.toLocaleString('en-US') : 'None'}</span>
                </div>
              ))}
            </div>
            <div className="row">
              <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void startImport()}>{busy ? 'Starting…' : 'Start import'}</button>
              <span className="muted small">Bringing over: {OBJECTS.filter((o) => !off[o.key]).map((o) => o.from).join(', ') || 'nothing selected'}.</span>
            </div>
          </section>
        )}

        {step === 4 && run && <RunView run={run} />}
      </>}
    </>
  )
}
