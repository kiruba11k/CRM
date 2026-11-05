// Company record (CRM review §4.3): properties on the left; summary, quick
// actions and the timeline of everything at the company in the centre;
// associated contacts and deals (add, open, inspect inline), files, Gmail
// and history on the right.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { domainOf, fmtDate, money, moneyByCurrency, nextActionLabel, totalsByCurrency } from '../format'
import { GmailCard } from '../components/Gmail'
import { useCanEdit, useSession } from '../session'
import { ActivityCard, HistoryCard, QuickActions } from '../components/Timeline'
import EmailContacts from '../components/EmailContacts'
import Attachments from '../components/Attachments'
import QuickCreate, { type QuickType } from '../components/QuickCreate'
import { CustomFieldsCard } from '../components/CustomFields'
import { Avatar, StagePill } from '../theme'
import type { AccountDetail, FormValue, FormValues, Opportunity, Prospect } from '../types'
import { Banner, ErrorBanner, OwnerField, SelectField, StatusPill, TextField, changedFields, useLoad, withCurrent } from '../ui'

const EDITABLE = ['name', 'country', 'region', 'industry', 'company_size', 'owner_id', 'status', 'website', 'linkedin_url', 'email_domains', 'notes'] as const
const STATUS_PILL: Record<string, string> = { Target: 'blue', 'Active customer': 'teal', 'Inactive / do not pursue': 'paper' }

function Expand({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="assoc-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details for ${label}`} onClick={onToggle}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg>
    </button>
  )
}

function ContactRow({ p }: { p: Prospect }) {
  const { lists } = useSession()
  const [open, setOpen] = useState(false)
  return (
    <div className="assoc-item">
      <div className="assoc-row">
        <Avatar name={p.full_name} size={30} />
        <div className="who">
          <Link to={`/contacts/${p.id}`}>{p.full_name}</Link>
          <span className="small muted">{p.job_title || p.status}</span>
        </div>
        <Expand open={open} onToggle={() => setOpen(!open)} label={p.full_name} />
      </div>
      {open && (
        <dl className="assoc-details">
          <dt>Status</dt><dd><StatusPill status={p.status} /></dd>
          <dt>Email</dt><dd>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : '—'}</dd>
          <dt>Phone</dt><dd>{p.phone || '—'}</dd>
          <dt>Owner</dt><dd>{p.owner_name || '—'}</dd>
          <dt>Next action</dt><dd>{nextActionLabel(lists, p.next_action_code, p.next_action_other) || '—'}{p.next_action_due ? ` · ${fmtDate(p.next_action_due)}` : ''}</dd>
        </dl>
      )}
    </div>
  )
}

function DealRow({ o }: { o: Opportunity }) {
  const { lists } = useSession()
  const [open, setOpen] = useState(false)
  const won = o.stage === 'Won'
  return (
    <div className="assoc-item">
      <div className="assoc-row">
        <div className="who">
          <Link to={`/opportunities/${o.id}`}>{o.name}</Link>
          <span className="small muted">{won ? `${money(o.actual_value, o.currency)} won` : money(o.estimated_value, o.currency)}{o.on_nurture ? ' · on nurture' : ''}</span>
        </div>
        <StagePill stage={o.stage} />
        <Expand open={open} onToggle={() => setOpen(!open)} label={o.name} />
      </div>
      {open && (
        <dl className="assoc-details">
          <dt>Owner</dt><dd>{o.owner_name || '—'}</dd>
          <dt>{won ? 'Won' : o.stage === 'Lost' ? 'Lost' : 'Close date'}</dt>
          <dd>{won ? fmtDate(o.won_date) : o.stage === 'Lost' ? `${fmtDate(o.lost_date)}${o.lost_reason ? ` · ${o.lost_reason}` : ''}` : fmtDate(o.expected_close) || '—'}</dd>
          {!['Won', 'Lost'].includes(o.stage) && <><dt>Next action</dt><dd>{nextActionLabel(lists, o.next_action_code, o.next_action_other) || '—'}{o.next_action_due ? ` · ${fmtDate(o.next_action_due)}` : ''}</dd></>}
          {o.forecast_category && <><dt>Forecast</dt><dd>{o.forecast_category}</dd></>}
        </dl>
      )}
    </div>
  )
}

export default function AccountRecord() {
  const { id = '' } = useParams()
  const { lists } = useSession()
  const { data, error: loadError, reload } = useLoad(() => api<AccountDetail>(`/accounts/${id}`), [id])
  const [form, setForm] = useState<FormValues | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(false)
  const [quick, setQuick] = useState<QuickType | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const canEdit = useCanEdit(data?.owner_id)

  useEffect(() => { if (data) setForm(Object.fromEntries(EDITABLE.map((k) => [k, data[k] ?? null]))) }, [data])
  if (loadError) return <ErrorBanner error={loadError} />
  if (!data || !form) return <div className="loading" data-label="Loading…">Loading…</div>

  const set = (k: string, v: FormValue) => setForm((f) => ({ ...(f as FormValues), [k]: v }))
  const errors = error?.fieldErrors || {}
  const open = data.opportunities.filter((o) => !['Won', 'Lost'].includes(o.stage) && !o.on_nurture)
  const closedDeals = data.opportunities.filter((o) => ['Won', 'Lost'].includes(o.stage))
  const shownDeals = showClosed ? data.opportunities : data.opportunities.filter((o) => !['Won', 'Lost'].includes(o.stage))
  const openTotals = totalsByCurrency(open, (o) => o.estimated_value)
  const wonTotals = totalsByCurrency(data.opportunities.filter((o) => o.stage === 'Won'), (o) => o.actual_value)
  const existingId = error?.extra?.existing_id as string | undefined
  const domain = domainOf(data.website)

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
      <div className="muted small"><Link to="/companies">Companies</Link> / {data.name}</div>
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1>{data.name}</h1>
          <div className="row">
            <span className={`pill pill-${STATUS_PILL[data.status] || 'grey'}`}>{data.status}</span>
            {data.industry && <span className="muted">{data.industry}</span>}
            {data.company_size && <span className="muted">· {data.company_size} employees</span>}
            {domain && <a className="small" href={data.website?.startsWith('http') ? data.website : `https://${data.website}`} target="_blank" rel="noreferrer">{domain}</a>}
          </div>
        </div>
        {canEdit && (
          <div className="row">
            <button type="button" className="btn" onClick={() => { void reload(); setError(null) }}>Discard changes</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
          </div>
        )}
      </div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {existingId && <Banner kind="warn">That name is taken: <Link to={`/companies/${existingId}`}>open the existing company</Link>.</Banner>}
      {saved && <Banner onClose={() => setSaved(false)}>Saved.</Banner>}

      <div className="cols three">
        <div className="col-props">
          <section className="card" aria-label="Company details">
            <h2>Company details</h2>
            <div className="grid-fields">
              <TextField label="Company name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} />
              <SelectField label="Status" value={form.status} onChange={(v) => set('status', v)} options={withCurrent(lists.account_statuses, form.status)} />
              <OwnerField label="Company owner" required={false} value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
              <TextField label="Industry / segment" value={form.industry} onChange={(v) => set('industry', v)} />
              <SelectField label="Company size" value={form.company_size} onChange={(v) => set('company_size', v)} placeholder="Not known"
                options={(lists.company_sizes || []).map((s) => ({ value: s, label: `${s} employees` }))} error={errors.company_size} />
              <TextField label="Country" required value={form.country} onChange={(v) => set('country', v)} error={errors.country} />
              <TextField label="Region / city" value={form.region} onChange={(v) => set('region', v)} />
              <TextField label="Website (domain)" value={form.website} onChange={(v) => set('website', v)} />
              <TextField label="LinkedIn company URL" value={form.linkedin_url} onChange={(v) => set('linkedin_url', v)} />
              <TextField label="Other email domains" value={form.email_domains} onChange={(v) => set('email_domains', v)} placeholder="e.g. norvale-group.com"
                hint="Only if people here use an email domain other than the website's. Comma-separated. Used by Gmail auto-logging." />
            </div>
            <TextField label="Notes" multiline value={form.notes} onChange={(v) => set('notes', v)} hint="Avoid storing unnecessary sensitive information" />
            {!canEdit && <span className="muted small">Read-only: only the owner, a manager or an admin can edit.</span>}
          </section>
          <CustomFieldsCard entity="accounts" recordId={id} canEdit={canEdit} />
        </div>

        <div className="col-main">
          <section className="tiles tiles-compact" aria-label="Company summary">
            <div className="tile"><span className="k">Open pipeline</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(openTotals)}</span><span className="s">{open.length} open deal{open.length === 1 ? '' : 's'}</span></div>
            <div className="tile"><span className="k">Won, all time</span><span className="v" style={{ fontSize: 18 }}>{moneyByCurrency(wonTotals)}</span><span className="s">Actual contract value</span></div>
            <div className="tile"><span className="k">Contacts</span><span className="v">{data.prospects.length}</span><span className="s">people at this company</span></div>
          </section>
          {canEdit && (
            <QuickActions entityType="account" entityId={id}>
              <button type="button" className="btn btn-outline" onClick={() => setQuick('prospect')}>+ Add contact</button>
              <button type="button" className="btn btn-outline" onClick={() => setQuick('opportunity')}>+ Create deal</button>
            </QuickActions>
          )}
          <ActivityCard activities={data.activities} postUrl={`/accounts/${id}/activities`} onAdded={() => void reload()} showRecord />
        </div>

        <div className="col-side">
          <section className="card" aria-label="Contacts">
            <div className="card-head">
              <h2>Contacts <span className="muted" style={{ fontWeight: 500 }}>· {data.prospects.length}</span></h2>
              {canEdit && <button type="button" className="btn btn-outline" onClick={() => setQuick('prospect')}>+ Add</button>}
            </div>
            {data.prospects.length === 0 && <p className="muted small" style={{ margin: 0 }}>No contacts yet.</p>}
            {data.prospects.map((p) => <ContactRow key={p.id} p={p} />)}
          </section>
          <section className="card" aria-label="Deals">
            <div className="card-head">
              <h2>Deals <span className="muted" style={{ fontWeight: 500 }}>· {data.opportunities.length}</span></h2>
              {canEdit && <button type="button" className="btn btn-outline" onClick={() => setQuick('opportunity')}>+ Create</button>}
            </div>
            {shownDeals.length === 0 && <p className="muted small" style={{ margin: 0 }}>{data.opportunities.length ? 'No open deals.' : 'No deals yet.'}</p>}
            {shownDeals.map((o) => <DealRow key={o.id} o={o} />)}
            {closedDeals.length > 0 && (
              <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShowClosed(!showClosed)}>
                {showClosed ? 'Hide won and lost' : `Show ${closedDeals.length} won and lost`}
              </button>
            )}
          </section>
          <Attachments entityType="account" entityId={id} canEdit={canEdit} onChange={() => void reload()} />
          <EmailContacts accountId={id} onAdded={() => void reload()} />
          <GmailCard onChange={() => void reload()} entityType="account" entityId={id} canEdit={canEdit} domain={domain}
            emails={data.prospects.map((p) => p.email || '')} subject={`LeadStrategus × ${data.name}`} />
          <HistoryCard history={data.history} />
        </div>
      </div>
      {quick && <QuickCreate type={quick} stay preset={{ account_id: id, ...(quick === 'opportunity' ? { geography: data.country } : {}) }}
        onClose={() => setQuick(null)} onCreated={() => void reload()} />}
    </>
  )
}
