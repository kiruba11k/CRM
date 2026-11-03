// Bulk import of accounts, prospects and deals from a CSV file:
// upload → map columns → options → review every row → import.
// Nothing is saved until the last step; managers and admins only.
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useSession } from '../session'
import { Banner, CountUp, ErrorBanner, OwnerField, Segmented, SelectField, TextField, useLoad } from '../ui'

type Entity = 'accounts' | 'prospects' | 'opportunities'
type Status = 'ready' | 'cleanup' | 'duplicate' | 'error'
interface Field { key: string; label: string; required: boolean }
interface Analysis { headers: string[]; row_count: number; sample: Record<string, string>[]; mapping: Record<string, string | null> }
interface PlanRow { row: number; status: Status; messages: string[]; label: string }
interface Plan { summary: Record<Status | 'new_accounts', number>; rows: PlanRow[]; unknown_stages?: { value: string; rows: number }[] }
interface Result { message: string; created: number; accounts_created: number; failed: number; failures: { row: number; label: string; message: string }[] }

const ENTITY_LABEL: Record<Entity, string> = { accounts: 'Accounts', prospects: 'Prospects', opportunities: 'Deals' }
const LIST_PATH: Record<Entity, string> = { accounts: '/accounts', prospects: '/prospects', opportunities: '/pipeline' }
const STEPS = ['Upload', 'Map columns', 'Options', 'Review', 'Done']
const STATUS: Record<Status, { label: string; pill: string }> = {
  ready: { label: 'Ready', pill: 'teal' }, cleanup: { label: 'Needs cleanup', pill: 'amber' },
  duplicate: { label: 'Duplicate', pill: 'grey' }, error: { label: 'Won’t import', pill: 'red' },
}
// Templates use column names the importer recognises automatically.
const TEMPLATES: Record<Entity, string[][]> = {
  accounts: [['Name', 'Country', 'Region', 'Industry', 'Status', 'Website', 'LinkedIn URL', 'Owner', 'Notes'],
    ['Norvale Pharma', 'Sweden', 'Stockholm', 'Pharmaceuticals', 'Target', 'https://norvale.example', '', 'you@leadstrategus.com', '']],
  prospects: [['First name', 'Last name', 'Email', 'Phone', 'Job title', 'LinkedIn URL', 'Company', 'Country', 'Status', 'Source', 'Owner', 'Next action', 'Next action due', 'Notes'],
    ['Elin', 'Berg', 'elin@norvale.example', '+46 8 123 456', 'VP Marketing', '', 'Norvale Pharma', 'Sweden', 'Engaged', 'Referral', 'you@leadstrategus.com', 'Call prospect', '2026-11-15', '']],
  opportunities: [['Deal name', 'Company', 'Country', 'Contact', 'Owner', 'Stage', 'Amount', 'Currency', 'Close date', 'Service line', 'Source', 'Risk', 'Next action', 'Next action due', 'Actual value', 'Won date', 'Lost reason', 'Lost date'],
    ['Norvale · LinkedIn lead generation', 'Norvale Pharma', 'Sweden', 'elin@norvale.example', 'you@leadstrategus.com', 'Qualified', '24000', 'USD', '2026-12-31', 'LinkedIn lead generation', 'Referral', 'Low', 'Schedule meeting', '2026-11-20', '', '', '', '']],
}

const csvCell = (v: string | number) => (/[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
function download(name: string, rows: (string | number)[][]) {
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export function ImportTabs({ active }: { active: 'csv' | 'hubspot' }) {
  return (
    <div className="tabs" role="tablist" aria-label="Import from">
      <Link to="/import" role="tab" aria-selected={active === 'csv'} className="tab-link">CSV file</Link>
      <Link to="/import/hubspot" role="tab" aria-selected={active === 'hubspot'} className="tab-link">HubSpot</Link>
    </div>
  )
}

export default function CsvImport() {
  const { user, lists } = useSession()
  const [params] = useSearchParams()
  const can = user.role !== 'salesperson'
  const fields = useLoad(() => api<Record<Entity, Field[]>>('/import/csv/fields'), [])
  const [step, setStep] = useState(0)
  const [entity, setEntity] = useState<Entity>(() => (['accounts', 'prospects', 'opportunities'].includes(params.get('entity') || '') ? params.get('entity') as Entity : 'accounts'))
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [opts, setOpts] = useState({ day_first: true, create_missing_accounts: true, default_country: '', default_owner_id: user.id as string | null, default_currency: lists.currencies[0] || 'USD' })
  const [plan, setPlan] = useState<Plan | null>(null)
  const [stageMap, setStageMap] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => { setFile(null); setAnalysis(null); setPlan(null); setStageMap({}); setResult(null); setStep(0) }, [entity])
  const entityFields = fields.data?.[entity] || []

  async function call<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    setError(null)
    try { return await fn() } catch (e) { setError(e as ApiError); return null } finally { setBusy(false) }
  }
  async function choose(f: File | undefined) {
    if (!f) return
    if (f.size > 5 * 1024 * 1024) { setError(new Error('The file is larger than 5 MB. Split it into smaller files.')); return }
    const text = await f.text()
    const a = await call(() => api<Analysis>('/import/csv/analyze', { method: 'POST', body: { entity, text } }))
    if (!a) return
    setFile({ name: f.name, text })
    setAnalysis(a)
    setMapping(a.mapping)
    setPlan(null)
    setStep(1)
  }
  const body = () => ({ entity, text: file?.text || '', mapping, file_name: file?.name,
    options: { ...opts, default_country: opts.default_country.trim() || null, default_owner_id: opts.default_owner_id || null, stage_map: stageMap } })
  const review = async () => {
    const p = await call(() => api<Plan>('/import/csv/plan', { method: 'POST', body: body() }))
    if (p) { setPlan(p); setFilter('all'); setStep(3) }
  }
  const commit = async () => {
    const r = await call(() => api<Result>('/import/csv/commit', { method: 'POST', body: body() }))
    if (r) { setResult(r); setStep(4) }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); void choose(e.dataTransfer.files[0]) }

  const samples = (col: string | null) => (col && analysis ? analysis.sample.map((r) => r[col]).filter(Boolean).slice(0, 3) : [])
  const unused = analysis ? analysis.headers.filter((h) => !Object.values(mapping).includes(h)) : []
  const missingRequired = entityFields.filter((f) => f.required && !mapping[f.key] && !(f.key === 'country' && opts.default_country.trim()))
  const prospectNameMissing = entity === 'prospects' && !mapping.full_name && !mapping.first_name && !mapping.last_name
  const importable = plan ? plan.summary.ready + plan.summary.cleanup : 0
  const shown = useMemo(() => (plan?.rows || []).filter((r) => filter === 'all' || r.status === filter), [plan, filter])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import</h1>
          <p>Bring accounts, prospects or deals in from a spreadsheet. You map the columns and review every row before anything is saved; duplicates are skipped, never overwritten.</p>
        </div>
      </div>
      <ImportTabs active="csv" />
      {!can && <Banner kind="warn">Bulk import is for managers and admins.</Banner>}
      {can && <>
        <nav className="steps" aria-label="Import steps">
          {STEPS.map((label, i) => (
            <button key={label} type="button" aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : undefined}
              disabled={busy || i > step || step === 4} onClick={() => setStep(i)}>
              <span className="mono">{i < step ? '✓' : i + 1}</span> {label}
            </button>
          ))}
        </nav>
        <ErrorBanner error={error} onClose={() => setError(null)} />

        {step === 0 && (
          <section className="card" aria-label="Upload">
            <div className="card-head"><h2>What are you importing?</h2>
              <button type="button" className="btn" onClick={() => download(`${entity}-template.csv`, TEMPLATES[entity])}>Download {ENTITY_LABEL[entity].toLowerCase()} template</button>
            </div>
            <Segmented<Entity> label="Record type" value={entity} onChange={setEntity}
              options={[{ value: 'accounts', label: 'Accounts' }, { value: 'prospects', label: 'Prospects' }, { value: 'opportunities', label: 'Deals' }]} />
            <label className={`dropzone${dragging ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
              <strong>{busy ? 'Reading the file…' : 'Drop a CSV file here, or click to choose one'}</strong>
              <span className="muted small">Comma, semicolon or tab separated · up to 5,000 rows and 5 MB · from Excel, Google Sheets or another CRM</span>
            </label>
            <p className="muted small" style={{ margin: 0 }}>
              {entity === 'accounts' && 'Each row is one company. Name and country are required.'}
              {entity === 'prospects' && 'Each row is one person. A name is required; a company column links them to an account (missing accounts can be created).'}
              {entity === 'opportunities' && 'Each row is one deal. Deal name and company are required; stage, amount, close date and owner are recommended.'}
            </p>
          </section>
        )}

        {step === 1 && analysis && (
          <section className="card" aria-label="Map columns">
            <div className="card-head"><h2>Map columns</h2><span className="muted small">{file?.name} · {analysis.row_count} rows · {analysis.headers.length} columns</span></div>
            <p className="muted small" style={{ margin: 0 }}>Columns with familiar names are matched already. Check each one: pick the file column that holds each CRM field, or leave it unmapped.</p>
            <div className="table-wrap">
              <table style={{ minWidth: 720 }}>
                <thead><tr><th>CRM field</th><th>Column in your file</th><th>Sample values</th></tr></thead>
                <tbody>
                  {entityFields.map((f) => (
                    <tr key={f.key} className={mapping[f.key] ? 'mapped' : undefined}>
                      <td style={{ fontWeight: 600 }}>{f.label}{f.required && <span className="req" style={{ color: 'var(--red-ink)' }}> *</span>}</td>
                      <td style={{ width: 280 }}>
                        <select className="input" aria-label={`Column for ${f.label}`} value={mapping[f.key] || ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || null })}>
                          <option value="">— Not imported —</option>
                          {analysis.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                      <td className="muted small">{samples(mapping[f.key]).join(' · ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {unused.length > 0 && <p className="muted small" style={{ margin: 0 }}>Not imported: {unused.join(', ')}</p>}
            {(missingRequired.length > 0 || prospectNameMissing) && (
              <Banner kind="warn">Still to map: {[...missingRequired.map((f) => f.label), ...(prospectNameMissing ? ['Full name, or First and Last name'] : [])].join(', ')}{missingRequired.some((f) => f.key === 'country') ? ' (or set a default country in the next step)' : ''}.</Banner>
            )}
            <div className="row">
              <button type="button" className="btn btn-dark" onClick={() => setStep(2)} disabled={prospectNameMissing || missingRequired.some((f) => f.key !== 'country')}>Continue to options</button>
              <button type="button" className="btn" onClick={() => setStep(0)}>Choose another file</button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="card" aria-label="Options">
            <h2>Options</h2>
            <div className="grid-fields">
              <div className="field">
                <span className="label-like">Dates like 03/04/2026 mean</span>
                <Segmented<'d' | 'm'> label="Date order" value={opts.day_first ? 'd' : 'm'} onChange={(v) => setOpts({ ...opts, day_first: v === 'd' })}
                  options={[{ value: 'd', label: '3 April (day first)' }, { value: 'm', label: 'March 4 (month first)' }]} />
                <span className="hint">2026-04-03 and “3 Apr 2026” work either way.</span>
              </div>
              <OwnerField label="Owner when the file has none (or an unknown one)" required={false} value={opts.default_owner_id} onChange={(v) => setOpts({ ...opts, default_owner_id: v })} />
              {entity !== 'accounts' && (
                <div className="field">
                  <span className="label-like">Accounts the CRM doesn’t have yet</span>
                  <label className="check"><input type="checkbox" checked={opts.create_missing_accounts} onChange={(e) => setOpts({ ...opts, create_missing_accounts: e.target.checked })} /> Create them (once per company)</label>
                </div>
              )}
              <TextField label={entity === 'accounts' ? 'Country when a row has none' : 'Country for new accounts without one'} value={opts.default_country}
                onChange={(v) => setOpts({ ...opts, default_country: v })} placeholder="e.g. United Kingdom" />
              {entity === 'opportunities' && (
                <SelectField label="Currency when a row has none" value={opts.default_currency} onChange={(v) => setOpts({ ...opts, default_currency: v || 'USD' })} options={lists.currencies} />
              )}
            </div>
            <div className="row">
              <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void review()}>{busy ? 'Checking every row…' : 'Review rows'}</button>
              <button type="button" className="btn" onClick={() => setStep(1)}>Back to mapping</button>
            </div>
          </section>
        )}

        {step === 3 && plan && (
          <section className="card" aria-label="Review">
            <div className="card-head"><h2>Review before importing</h2><span className="muted small">{file?.name}</span></div>
            <div className="tiles">
              {(['ready', 'cleanup', 'duplicate', 'error'] as Status[]).map((s) => (
                <button key={s} type="button" className={`tile filter-tile${filter === s ? ' on' : ''}`} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? 'all' : s)}>
                  <span className="k"><span className={`pill pill-${STATUS[s].pill}`}>{STATUS[s].label}</span></span>
                  <span className="v"><CountUp value={plan.summary[s]} /></span>
                  <span className="s">{s === 'ready' ? 'Pass every rule' : s === 'cleanup' ? 'Imported, flagged in Needs cleanup' : s === 'duplicate' ? 'Already in the CRM: skipped' : 'Skipped: see the reason'}</span>
                </button>
              ))}
            </div>
            {(plan.unknown_stages || []).length > 0 && (
              <div className="card" aria-label="Unmatched stages">
                <div className="card-head"><h2>Stages we couldn’t match</h2><span className="muted small">Pick the CRM stage for each, then re-check</span></div>
                <div className="grid-fields">
                  {(plan.unknown_stages || []).map((u) => (
                    <SelectField key={u.value} label={`“${u.value}” (${u.rows} row${u.rows === 1 ? '' : 's'})`} value={stageMap[u.value] || ''} placeholder="Leave unmatched (row skipped)"
                      onChange={(v) => setStageMap((m) => { const n = { ...m }; if (v) n[u.value] = v; else delete n[u.value]; return n })}
                      options={lists.stages.map((st) => st.name)} />
                  ))}
                </div>
                <div className="row"><button type="button" className="btn" disabled={busy || Object.keys(stageMap).length === 0} onClick={() => void review()}>{busy ? 'Checking…' : 'Re-check rows'}</button></div>
              </div>
            )}
            {plan.summary.new_accounts > 0 && <Banner>{plan.summary.new_accounts} new account{plan.summary.new_accounts === 1 ? '' : 's'} will be created for companies the CRM doesn’t have yet.</Banner>}
            <div className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
              <table style={{ minWidth: 720 }}>
                <thead><tr><th>Row</th><th>Record</th><th>Result</th><th>Details</th></tr></thead>
                <tbody>
                  {shown.slice(0, 500).map((r) => (
                    <tr key={r.row}>
                      <td className="mono muted">{r.row}</td>
                      <td style={{ fontWeight: 600 }}>{r.label || '—'}</td>
                      <td><span className={`pill pill-${STATUS[r.status].pill}`}>{STATUS[r.status].label}</span></td>
                      <td className="small">{r.messages.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{r.messages.map((m) => <li key={m}>{m}</li>)}</ul> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > 500 && <div className="empty small">Showing the first 500 of {shown.length} rows.</div>}
            </div>
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy || importable === 0} onClick={() => void commit()}>
                {busy ? 'Importing…' : `Import ${importable} ${ENTITY_LABEL[entity].toLowerCase()}`}
              </button>
              <button type="button" className="btn" onClick={() => setStep(1)}>Change mapping</button>
              <span className="muted small">Duplicates and rows that won’t import are skipped.</span>
            </div>
          </section>
        )}

        {step === 4 && result && plan && (
          <section className="card strong" aria-label="Done">
            <h2>Import finished</h2>
            <Banner>{result.message}</Banner>
            <div className="row">
              <Link className="btn btn-dark" to={LIST_PATH[entity]}>Open {ENTITY_LABEL[entity]}</Link>
              {plan.summary.cleanup > 0 && <Link className="btn" to="/cleanup">Open Needs cleanup ({plan.summary.cleanup})</Link>}
              {(plan.summary.duplicate + plan.summary.error + result.failed) > 0 && (
                <button type="button" className="btn" onClick={() => download('import-report.csv', [['Row', 'Record', 'Result', 'Details'],
                  ...plan.rows.filter((r) => r.status === 'duplicate' || r.status === 'error').map((r) => [r.row, r.label, STATUS[r.status].label, r.messages.join(' | ')]),
                  ...result.failures.map((f) => [f.row, f.label, 'Failed', f.message])])}>Download report of skipped rows</button>
              )}
              <button type="button" className="btn" onClick={() => { setEntity(entity); setFile(null); setAnalysis(null); setPlan(null); setResult(null); setStep(0) }}>Import another file</button>
            </div>
          </section>
        )}
      </>}
    </>
  )
}
