// Opportunity record (§2.3): every field, shown when the stage needs it.
// The server is the source of truth for validation; its field errors are
// shown next to each input.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { money, probabilityOf } from '../format'
import { useCanEdit, useSession } from '../session'
import { ActivityCard, HistoryCard } from '../components/Timeline'
import { MeetingsCard } from '../components/Meetings'
import type { Account, AccountDetail, FormValue, FormValues, Issue, OpportunityDetail, Prospect } from '../types'
import { Banner, ErrorBanner, NextActionFields, OwnerField, SelectField, TextField, WarningsBanner, changedFields, useLoad, withCurrent } from '../ui'

const EDITABLE = [
  'name', 'account_id', 'primary_contact_id', 'owner_id', 'stage', 'estimated_value', 'currency', 'expected_close', 'geography',
  'service_line', 'deal_source', 'risk_rating', 'high_risk_reason', 'risk_mitigation', 'on_nurture', 'nurture_reason', 'nurture_until',
  'nurture_owner_id', 'nurture_next_action_code', 'nurture_next_action_other', 'next_action_code', 'next_action_other', 'next_action_due',
  'proposal_due', 'delivery_lead', 'effort_estimate', 'actual_value', 'won_date', 'lost_date', 'lost_reason', 'lost_notes',
] as const
type Teams = { database_build_team: string[]; proposal_team: string[] }

function TeamPicker({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const { users } = useSession()
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</legend>
      <div className="row" style={{ gap: 4 }}>
        {users.filter((u) => u.active !== false).map((u) => (
          <label key={u.id} className="check" style={{ minHeight: 32 }}>
            <input type="checkbox" checked={value.includes(u.id)}
              onChange={() => onChange(value.includes(u.id) ? value.filter((x) => x !== u.id) : [...value, u.id])} />{u.name}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

const teamIds = (d: OpportunityDetail): Teams => ({ database_build_team: d.database_build_team.map((u) => u.id), proposal_team: d.proposal_team.map((u) => u.id) })
const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join()

export default function OpportunityRecord() {
  const { id = '' } = useParams()
  const { lists } = useSession()
  const { data, error: loadError, reload } = useLoad(() => api<OpportunityDetail>(`/opportunities/${id}`), [id])
  const accounts = useLoad(() => api<Account[]>('/accounts'), [])
  const [form, setForm] = useState<FormValues | null>(null)
  const [teams, setTeams] = useState<Teams>({ database_build_team: [], proposal_team: [] })
  const [contacts, setContacts] = useState<Prospect[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState<Issue[] | null>(null)
  const [more, setMore] = useState(false)
  const canEdit = useCanEdit(data?.owner_id)
  const accountId = form?.account_id as string | null | undefined

  useEffect(() => {
    if (!data) return
    setForm(Object.fromEntries(EDITABLE.map((k) => [k, data[k] ?? null])))
    setTeams(teamIds(data))
  }, [data])
  useEffect(() => {
    if (!accountId) return
    api<AccountDetail>(`/accounts/${accountId}`).then((a) => setContacts(a.prospects)).catch(() => setContacts([]))
  }, [accountId])

  if (loadError) return <ErrorBanner error={loadError} />
  if (!data || !form) return <div className="loading">Loading…</div>

  const set = (k: string, v: FormValue) => setForm((f) => ({ ...(f as FormValues), [k]: v }))
  const errors = error?.fieldErrors || {}
  const stage = String(form.stage)
  const idx = lists.stages.findIndex((s) => s.name === stage)
  const isWon = stage === 'Won'
  const isLost = stage === 'Lost'
  const closed = isWon || isLost
  const nurtured = !!form.on_nurture && !closed
  const qualifiedPlus = idx >= 1 && !isLost
  const prob = probabilityOf(lists, stage)
  const account = accounts.data?.find((a) => a.id === data.account_id)
  const primary = contacts.find((p) => p.id === data.primary_contact_id)

  async function save() {
    if (!form || !data) return
    setError(null)
    setSaved(null)
    const patch: FormValues = changedFields(form, data, EDITABLE)
    const orig = teamIds(data)
    if (!sameSet(teams.database_build_team, orig.database_build_team)) patch.database_build_team = teams.database_build_team
    if (!sameSet(teams.proposal_team, orig.proposal_team)) patch.proposal_team = teams.proposal_team
    try {
      const res = await api<{ warnings?: Issue[] }>(`/opportunities/${id}`, { method: 'PATCH', body: patch })
      setSaved(res.warnings || [])
      void reload()
    } catch (e) { setError(e as ApiError) }
  }

  return (
    <>
      <div className="muted small"><Link to="/pipeline">Pipeline</Link> / {account ? <Link to={`/accounts/${account.id}`}>{account.name}</Link> : 'Account'}</div>
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h1>{data.name}</h1>
          <div className="row">
            <span className="pill" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>{data.stage} · {data.probability}%</span>
            <span className="mono" style={{ fontWeight: 600, fontSize: 16 }}>{money(data.estimated_value, data.currency)}</span>
            <span className="muted">weighted {money(data.weighted_value, data.currency)}</span>
            {data.on_nurture && <span className="pill pill-purple">On nurture: excluded from active forecast</span>}
          </div>
        </div>
        {canEdit && (
          <div className="row">
            <button type="button" className="btn" onClick={() => { void reload(); setError(null) }}>Discard changes</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save</button>
          </div>
        )}
      </div>
      {!canEdit && <Banner kind="warn">You can view this opportunity. Only its owner, a manager or an admin can edit it.</Banner>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {saved && <Banner onClose={() => setSaved(null)}>Saved. Changes to stage, risk, nurture and value are kept in the history.</Banner>}
      <WarningsBanner warnings={saved || data.warnings} />

      <div className="cols">
        <div className="col-main">
          <section className="card strong" aria-label="Next action">
            <div className="card-head"><h2>Next action</h2><span className="muted small">Same 18-option list as prospects</span></div>
            {closed ? <p className="muted" style={{ margin: 0 }}>Closed: open-deal reminders have stopped.</p>
              : nurtured ? <p className="muted" style={{ margin: 0 }}>On nurture: routine reminders are paused. The nurture next action below drives the revisit reminder.</p>
              : <div className="grid-fields"><NextActionFields value={form} onChange={setForm} errors={errors} /></div>}
          </section>

          <section className="card" aria-label="Opportunity">
            <div className="card-head"><h2>Opportunity</h2><span className="muted small">Required fields depend on the stage</span></div>
            <div className="grid-fields">
              <TextField label="Opportunity name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} />
              <SelectField label="Account" required value={form.account_id} onChange={(v) => set('account_id', v)} error={errors.account_id}
                options={(accounts.data || []).map((a) => ({ value: a.id, label: a.name }))} />
              <SelectField label="Primary contact" value={form.primary_contact_id} onChange={(v) => set('primary_contact_id', v)} placeholder="None yet"
                hint="Recommended by Qualified" options={contacts.map((p) => ({ value: p.id, label: p.full_name }))} />
              <OwnerField label="Owner / salesperson" value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
              <SelectField label="Sales stage" required value={form.stage} onChange={(v) => set('stage', v)} error={errors.stage}
                options={lists.stages.map((s) => ({ value: s.name, label: `${s.name} · ${s.probability}%` }))} />
              <TextField label="Estimated deal value" required={qualifiedPlus} value={form.estimated_value} onChange={(v) => set('estimated_value', v)}
                error={errors.estimated_value} hint={`Weighted at ${prob}%: kept separate from actual contract value`} />
              <SelectField label="Currency" required value={form.currency} onChange={(v) => set('currency', v)} options={withCurrent(lists.currencies, form.currency)} error={errors.currency} />
              <TextField label="Expected close date" type="date" required={idx >= 3 && !closed} value={form.expected_close} onChange={(v) => set('expected_close', v || null)} error={errors.expected_close} />
              <TextField label="Geography" required value={form.geography} onChange={(v) => set('geography', v)} error={errors.geography} hint="Defaults from the account" />
              <SelectField label="Risk rating" required={qualifiedPlus} value={form.risk_rating} onChange={(v) => set('risk_rating', v)} options={lists.risk_ratings} error={errors.risk_rating} />
              {form.risk_rating === 'High' && <>
                <TextField label="High-risk reason" required value={form.high_risk_reason} onChange={(v) => set('high_risk_reason', v)} error={errors.high_risk_reason} />
                <TextField label="Mitigation / next action" required value={form.risk_mitigation} onChange={(v) => set('risk_mitigation', v)} error={errors.risk_mitigation} />
              </>}
              {(stage === 'Proposal submitted' || !!form.proposal_due) && (
                <TextField label="Proposal due date" type="date" required={stage === 'Proposal submitted'} value={form.proposal_due} onChange={(v) => set('proposal_due', v || null)} error={errors.proposal_due} />
              )}
            </div>
          </section>

          <section className="card" aria-label="Nurture" style={{ borderColor: nurtured ? '#C9B6E4' : undefined }}>
            <div className="card-head"><h2>Nurture</h2><span className="muted small">Separate from the prospect status “Nurture”</span></div>
            <div className="grid-fields">
              <SelectField label="Put on Nurture?" required value={form.on_nurture ? 'Yes' : 'No'} onChange={(v) => set('on_nurture', v === 'Yes')} options={['No', 'Yes']}
                error={errors.on_nurture} hint={closed ? 'Not available for Won or Lost' : 'Flag only: stage and history are kept'} />
              {!!form.on_nurture && !closed && <>
                <SelectField label="Nurture reason" required value={form.nurture_reason} onChange={(v) => set('nurture_reason', v)} options={withCurrent(lists.nurture_reasons, form.nurture_reason)} placeholder="Choose…" error={errors.nurture_reason} />
                <TextField label="Nurture until (revisit)" type="date" required value={form.nurture_until} onChange={(v) => set('nurture_until', v || null)} error={errors.nurture_until} />
                <OwnerField label="Nurture owner" required={false} value={form.nurture_owner_id} onChange={(v) => set('nurture_owner_id', v)} />
                <NextActionFields value={form} onChange={setForm} errors={errors} prefix="nurture_next_action" withDue={false} />
              </>}
            </div>
          </section>

          {isWon && (
            <section className="card" aria-label="Closed won" style={{ borderColor: '#A9D9CC' }}>
              <h2>Closed won</h2>
              <div className="grid-fields">
                <TextField label="Actual contract value" required value={form.actual_value} onChange={(v) => set('actual_value', v)} error={errors.actual_value} />
                <TextField label="Won date" type="date" required value={form.won_date} onChange={(v) => set('won_date', v || null)} error={errors.won_date} />
              </div>
            </section>
          )}
          {isLost && (
            <section className="card" aria-label="Closed lost" style={{ borderColor: '#E8A08F' }}>
              <h2>Closed lost</h2>
              <div className="grid-fields">
                <SelectField label="Lost reason" required value={form.lost_reason} onChange={(v) => set('lost_reason', v)} options={withCurrent(lists.lost_reasons, form.lost_reason)} placeholder="Choose…" error={errors.lost_reason} />
                <TextField label="Lost notes" value={form.lost_notes} onChange={(v) => set('lost_notes', v)} />
                <TextField label="Lost date" type="date" required value={form.lost_date} onChange={(v) => set('lost_date', v || null)} error={errors.lost_date} />
              </div>
            </section>
          )}

          <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? '− Hide more details' : '+ More details: service line, source, teams, delivery'}
          </button>
          {more && (
            <section className="card" aria-label="More details">
              <div className="grid-fields">
                <SelectField label="Service line / project type" value={form.service_line} onChange={(v) => set('service_line', v)} options={withCurrent(lists.service_lines, form.service_line)} placeholder="Choose…" error={errors.service_line} />
                <SelectField label="Deal source" value={form.deal_source} onChange={(v) => set('deal_source', v)} options={withCurrent(lists.sources, form.deal_source)} placeholder="Choose…" />
                <TextField label="Delivery lead" value={form.delivery_lead} onChange={(v) => set('delivery_lead', v)} />
                <TextField label="Effort estimate" value={form.effort_estimate} onChange={(v) => set('effort_estimate', v)} />
              </div>
              <TeamPicker label="Internal proposal team" value={teams.proposal_team} onChange={(v) => setTeams({ ...teams, proposal_team: v })} />
              <TeamPicker label="Internal database-build team" value={teams.database_build_team} onChange={(v) => setTeams({ ...teams, database_build_team: v })} />
            </section>
          )}
          <ActivityCard activities={data.activities} postUrl={`/opportunities/${id}/activities`} onAdded={() => void reload()} />
        </div>

        <div className="col-side">
          <section className="card" aria-label="Contacts">
            <h2>Contacts at {account?.name || 'this account'}</h2>
            {contacts.length === 0 && <p className="muted small" style={{ margin: 0 }}>No prospects linked to this account yet.</p>}
            {contacts.map((p) => (
              <Link key={p.id} to={`/prospects/${p.id}`} className="deal-card">
                <span className="title">{p.full_name}{p.id === data.primary_contact_id ? ' · primary' : ''}</span>
                <span className="small muted">{p.job_title || p.status}</span>
              </Link>
            ))}
          </section>
          <section className="card" aria-label="Gmail">
            <h2>Gmail</h2>
            <span className="muted small">Opens Gmail in context. Emails are not copied into the CRM.</span>
            {account?.website && <a href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(account.website)}`} target="_blank" rel="noreferrer">Search Gmail for {account.website}</a>}
            {primary?.email && (
              <a href={`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(primary.email)}`} target="_blank" rel="noreferrer">Compose to {primary.full_name}</a>
            )}
          </section>
          <MeetingsCard entityType="opportunity" entityId={id} />
          <HistoryCard history={data.history} />
        </div>
      </div>
    </>
  )
}
