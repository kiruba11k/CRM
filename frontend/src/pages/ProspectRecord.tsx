// Prospect / contact record (§2.2) with conversion to an opportunity.
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useCanEdit, useSession } from '../session'
import { ActivityCard, HistoryCard } from '../components/Timeline'
import { FollowUpStatus, MeetingsCard } from '../components/Meetings'
import { GmailCard } from '../components/Gmail'
import type { Account, FormValue, FormValues, Issue, Opportunity, ProspectDetail } from '../types'
import { Banner, ErrorBanner, NextActionFields, OwnerField, SelectField, StatusPill, TextField, WarningsBanner, changedFields, compact, useLoad, withCurrent } from '../ui'

const EDITABLE = ['full_name', 'account_id', 'job_title', 'email', 'phone', 'linkedin_url', 'owner_id', 'status', 'disqualified_reason', 'source', 'next_action_code', 'next_action_other', 'next_action_due', 'next_action_time', 'next_action_time_zone', 'next_action_in_calendar', 'notes'] as const

function ConvertPanel({ prospect, accountName, accounts, onCancel }: { prospect: ProspectDetail; accountName?: string; accounts: Account[]; onCancel: () => void }) {
  const { lists } = useSession()
  const navigate = useNavigate()
  const [form, setForm] = useState<FormValues>({
    name: accountName ? `${accountName} · ` : '', account_id: prospect.account_id, owner_id: prospect.owner_id,
    stage: 'Qualified', currency: 'USD', risk_rating: 'Unassessed',
  })
  const [error, setError] = useState<ApiError | null>(null)
  const set = (k: string, v: FormValue) => setForm((f) => ({ ...f, [k]: v }))
  const errors = error?.fieldErrors || {}
  async function save() {
    setError(null)
    try {
      const opp = await api<Opportunity>(`/prospects/${prospect.id}/convert`, { method: 'POST', body: compact(form) })
      navigate(`/opportunities/${opp.id}`)
    } catch (e) { setError(e as ApiError) }
  }
  return (
    <section className="card strong" aria-label="Create opportunity">
      <div>
        <h2>Create an opportunity from {prospect.full_name}</h2>
        <span className="muted small">{prospect.full_name} becomes the primary contact and keeps all history. Starting at Qualified needs a value and a risk rating.</span>
      </div>
      <ErrorBanner error={error} />
      <div className="grid-fields">
        <TextField label="Opportunity name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} />
        <SelectField label="Account" required value={form.account_id} onChange={(v) => set('account_id', v)} placeholder="Choose…" error={errors.account_id}
          options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
        <OwnerField value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
        <SelectField label="Stage" required value={form.stage} onChange={(v) => set('stage', v)}
          options={lists.stages.filter((s) => !['Won', 'Lost'].includes(s.name)).map((s) => ({ value: s.name, label: `${s.name} · ${s.probability}%` }))} />
        <TextField label="Estimated deal value" value={form.estimated_value} onChange={(v) => set('estimated_value', v)} error={errors.estimated_value} />
        <SelectField label="Currency" value={form.currency} onChange={(v) => set('currency', v)} options={lists.currencies} />
        <SelectField label="Risk rating" value={form.risk_rating} onChange={(v) => set('risk_rating', v)} options={lists.risk_ratings} error={errors.risk_rating} />
        {form.risk_rating === 'High' && <>
          <TextField label="High-risk reason" required value={form.high_risk_reason} onChange={(v) => set('high_risk_reason', v)} error={errors.high_risk_reason} />
          <TextField label="Mitigation / next action" required value={form.risk_mitigation} onChange={(v) => set('risk_mitigation', v)} error={errors.risk_mitigation} />
        </>}
        <NextActionFields value={form} onChange={setForm} errors={errors} />
      </div>
      <div className="row">
        <button type="button" className="btn btn-dark" onClick={save}>Create opportunity</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}

export default function ProspectRecord() {
  const { id = '' } = useParams()
  const { lists } = useSession()
  const { data, error: loadError, reload } = useLoad(() => api<ProspectDetail>(`/prospects/${id}`), [id])
  const accounts = useLoad(() => api<Account[]>('/accounts'), [])
  const [form, setForm] = useState<FormValues | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState<Issue[] | null>(null)
  const [converting, setConverting] = useState(false)
  const canEdit = useCanEdit(data?.owner_id)

  useEffect(() => {
    if (data) setForm(Object.fromEntries(EDITABLE.map((k) => [k, data[k] ?? null])))
  }, [data])
  if (loadError) return <ErrorBanner error={loadError} />
  if (!data || !form) return <div className="loading">Loading…</div>

  const set = (k: string, v: FormValue) => setForm((f) => ({ ...(f as FormValues), [k]: v }))
  const errors = error?.fieldErrors || {}
  const closed = form.status === 'Disqualified'
  const accountName = accounts.data?.find((a) => a.id === data.account_id)?.name

  async function save() {
    if (!form || !data) return
    setError(null)
    setSaved(null)
    try {
      const res = await api<{ warnings?: Issue[] }>(`/prospects/${id}`, { method: 'PATCH', body: changedFields(form, data, EDITABLE) })
      setSaved(res.warnings || [])
      void reload()
    } catch (e) { setError(e as ApiError) }
  }

  return (
    <>
      <div className="muted small"><Link to="/prospects">Prospects</Link>{data.account_id && <> / <Link to={`/accounts/${data.account_id}`}>{accountName || 'Account'}</Link></>}</div>
      <div className="page-head">
        <div className="row">
          <h1>{data.full_name}</h1>
          <StatusPill status={data.status} />
        </div>
        <div className="row">
          {canEdit && !closed && <button type="button" className="btn btn-outline" onClick={() => setConverting(true)}>Create opportunity</button>}
          {canEdit && <button type="button" className="btn btn-primary" onClick={save}>Save</button>}
        </div>
      </div>
      {!canEdit && <Banner kind="warn">You can view this prospect. Only its owner, a manager or an admin can edit it.</Banner>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {saved && <Banner onClose={() => setSaved(null)}>Saved.</Banner>}
      <WarningsBanner warnings={saved} />
      {converting && <ConvertPanel prospect={data} accountName={accountName} accounts={accounts.data || []} onCancel={() => setConverting(false)} />}
      <div className="cols">
        <div className="col-main">
          <section className="card strong" aria-label="Next action">
            <div className="card-head"><h2>Next action</h2><span className="muted small">Same list as opportunities</span></div>
            {closed ? <p className="muted" style={{ margin: 0 }}>Disqualified: no reminders.</p> : (
              <>
                <div className="grid-fields"><NextActionFields value={form} onChange={setForm} errors={errors} withCalendar /></div>
                <FollowUpStatus followUp={data.follow_up} onChange={() => void reload()} />
              </>
            )}
          </section>
          <section className="card" aria-label="Details">
            <h2>Details</h2>
            <div className="grid-fields">
              <TextField label="Full name" required value={form.full_name} onChange={(v) => set('full_name', v)} error={errors.full_name} />
              <SelectField label="Status" required value={form.status} onChange={(v) => set('status', v)} options={lists.prospect_statuses} error={errors.status} />
              {closed && <TextField label="Disqualified reason" value={form.disqualified_reason} onChange={(v) => set('disqualified_reason', v)} />}
              <SelectField label="Account" value={form.account_id} onChange={(v) => set('account_id', v)} placeholder="Not known yet"
                options={(accounts.data || []).map((a) => ({ value: a.id, label: a.name }))} />
              <OwnerField value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} required={!closed} />
              <TextField label="Job title / function" value={form.job_title} onChange={(v) => set('job_title', v)} />
              <TextField label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} error={errors.email} />
              <TextField label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
              <TextField label="LinkedIn URL" value={form.linkedin_url} onChange={(v) => set('linkedin_url', v)} />
              <SelectField label="Source" value={form.source} onChange={(v) => set('source', v)} options={withCurrent(lists.sources, form.source)} placeholder="Choose…" />
            </div>
            <TextField label="Notes" multiline value={form.notes} onChange={(v) => set('notes', v)} />
          </section>
          <ActivityCard activities={data.activities} postUrl={`/prospects/${id}/activities`} onAdded={() => void reload()} />
        </div>
        <div className="col-side">
          <section className="card" aria-label="Opportunities">
            <h2>Opportunities</h2>
            {data.opportunities.length === 0 && <p className="muted small" style={{ margin: 0 }}>None yet.</p>}
            {data.opportunities.map((o) => (
              <Link key={o.id} to={`/opportunities/${o.id}`} className="deal-card">
                <span className="title">{o.name}</span>
                <span className="small muted">{o.stage}{o.on_nurture ? ' · on nurture' : ''}</span>
              </Link>
            ))}
          </section>
          <GmailCard onChange={() => void reload()} entityType="prospect" entityId={id} canEdit={canEdit} domain={null} emails={data.email ? [data.email] : []}
            subject={`LeadStrategus × ${accountName || data.full_name}`} />
          <MeetingsCard key={`${data.follow_up?.id}-${data.follow_up?.starts_at}-${data.follow_up?.sync_status}`} entityType="prospect" entityId={id} />
          <HistoryCard history={data.history} />
        </div>
      </div>
    </>
  )
}
