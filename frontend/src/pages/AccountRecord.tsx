import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { fmtDate, money, moneyByCurrency, nextActionLabel, totalsByCurrency } from '../format'
import { useCanEdit, useSession } from '../session'
import { ActivityCard, HistoryCard } from '../components/Timeline'
import type { AccountDetail, FormValue, FormValues } from '../types'
import { Banner, ErrorBanner, OwnerField, SelectField, StatusPill, Tabs, TextField, changedFields, useLoad } from '../ui'

const EDITABLE = ['name', 'country', 'region', 'industry', 'owner_id', 'status', 'website', 'linkedin_url', 'notes'] as const
type Tab = 'opps' | 'people' | 'activity'

export default function AccountRecord() {
  const { id = '' } = useParams()
  const { lists } = useSession()
  const { data, error: loadError, reload } = useLoad(() => api<AccountDetail>(`/accounts/${id}`), [id])
  const [form, setForm] = useState<FormValues | null>(null)
  const [tab, setTab] = useState<Tab>('opps')
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)
  const canEdit = useCanEdit(data?.owner_id)

  useEffect(() => { if (data) setForm(Object.fromEntries(EDITABLE.map((k) => [k, data[k] ?? null]))) }, [data])
  if (loadError) return <ErrorBanner error={loadError} />
  if (!data || !form) return <div className="loading">Loading…</div>

  const set = (k: string, v: FormValue) => setForm((f) => ({ ...(f as FormValues), [k]: v }))
  const errors = error?.fieldErrors || {}
  const open = data.opportunities.filter((o) => !['Won', 'Lost'].includes(o.stage) && !o.on_nurture)
  const openTotals = totalsByCurrency(open, (o) => o.estimated_value)
  const wonTotals = totalsByCurrency(data.opportunities.filter((o) => o.stage === 'Won'), (o) => o.actual_value)
  const existingId = error?.extra?.existing_id as string | undefined

  async function save() {
    if (!form || !data) return
    setError(null)
    setSaved(false)
    try {
      await api(`/accounts/${id}`, { method: 'PATCH', body: changedFields(form, data, EDITABLE) })
      setSaved(true)
      void reload()
    } catch (e) { setError(e as ApiError) }
  }

  return (
    <>
      <div className="muted small"><Link to="/accounts">Accounts</Link> / {data.name}</div>
      <div className="page-head">
        <div className="row"><h1>{data.name}</h1><span className="pill pill-paper">{data.status}</span></div>
        {canEdit && <button type="button" className="btn btn-primary" onClick={save}>Save</button>}
      </div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {existingId && <Banner kind="warn">That name is taken: <Link to={`/accounts/${existingId}`}>open the existing account</Link>.</Banner>}
      {saved && <Banner onClose={() => setSaved(false)}>Saved.</Banner>}
      <section className="tiles" aria-label="Account summary">
        <div className="tile"><span className="k">Open pipeline</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(openTotals)}</span><span className="s">{open.length} open, non-nurtured</span></div>
        <div className="tile"><span className="k">Won, all time</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(wonTotals)}</span><span className="s">Actual contract value</span></div>
        <div className="tile"><span className="k">Prospects / contacts</span><span className="v">{data.prospects.length}</span></div>
      </section>
      <div className="cols">
        <div className="col-main">
          <Tabs<Tab> label="Related records" value={tab} onChange={setTab} tabs={[
            { value: 'opps', label: 'Opportunities', count: data.opportunities.length },
            { value: 'people', label: 'Prospects / contacts', count: data.prospects.length },
            { value: 'activity', label: 'Activity' },
          ]} />
          {tab === 'opps' && (
            <div className="table-wrap">
              <table style={{ minWidth: 640 }}>
                <thead><tr><th>Opportunity</th><th>Stage</th><th>Value</th><th>Close / closed</th><th>Next action</th></tr></thead>
                <tbody>
                  {data.opportunities.map((o) => (
                    <tr key={o.id}>
                      <td><Link to={`/opportunities/${o.id}`} style={{ fontWeight: 600 }}>{o.name}</Link><div className="sub">{o.service_line}</div></td>
                      <td>{o.stage}{o.on_nurture && <> <span className="pill pill-purple">nurture</span></>}</td>
                      <td className="mono">{o.stage === 'Won' ? `${money(o.actual_value, o.currency)} actual` : money(o.estimated_value, o.currency)}</td>
                      <td className="muted">{o.stage === 'Won' ? `Won ${fmtDate(o.won_date)}` : o.stage === 'Lost' ? `Lost ${fmtDate(o.lost_date)}` : fmtDate(o.expected_close)}</td>
                      <td className="muted">{nextActionLabel(lists, o.next_action_code, o.next_action_other) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.opportunities.length === 0 && <div className="empty">No opportunities yet.</div>}
            </div>
          )}
          {tab === 'people' && (
            <div className="table-wrap">
              <table style={{ minWidth: 600 }}>
                <thead><tr><th>Name</th><th>Status</th><th>Contact route</th><th>Next action</th></tr></thead>
                <tbody>
                  {data.prospects.map((p) => (
                    <tr key={p.id}>
                      <td><Link to={`/prospects/${p.id}`} style={{ fontWeight: 600 }}>{p.full_name}</Link><div className="sub">{p.job_title}</div></td>
                      <td><StatusPill status={p.status} /></td>
                      <td className="muted">{[p.email, p.phone].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="muted">{nextActionLabel(lists, p.next_action_code, p.next_action_other) || '—'} {p.next_action_due && `· ${fmtDate(p.next_action_due)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.prospects.length === 0 && <div className="empty">No prospects yet.</div>}
            </div>
          )}
          {tab === 'activity' && <ActivityCard activities={data.activities} />}
        </div>
        <div className="col-side">
          <section className="card" aria-label="Account details">
            <h2>Account details</h2>
            <TextField label="Account / company name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} />
            <TextField label="Country" required value={form.country} onChange={(v) => set('country', v)} error={errors.country} />
            <TextField label="Region / city" value={form.region} onChange={(v) => set('region', v)} />
            <TextField label="Industry / segment" value={form.industry} onChange={(v) => set('industry', v)} />
            <SelectField label="Account status" value={form.status} onChange={(v) => set('status', v)} options={lists.account_statuses} />
            <OwnerField label="Account owner" required={false} value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
            <TextField label="Website" value={form.website} onChange={(v) => set('website', v)} />
            <TextField label="LinkedIn company URL" value={form.linkedin_url} onChange={(v) => set('linkedin_url', v)} />
            <TextField label="Notes" multiline value={form.notes} onChange={(v) => set('notes', v)} hint="Avoid storing unnecessary sensitive information" />
            {!canEdit && <span className="muted small">Read-only: only the owner, a manager or an admin can edit.</span>}
          </section>
          <HistoryCard history={data.history} />
        </div>
      </div>
    </>
  )
}
