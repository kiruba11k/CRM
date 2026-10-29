// §8.2 quick-create with minimal mandatory fields; optional ones under "More details".
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useSession } from '../session.jsx'
import { ErrorBanner, NextActionFields, OwnerField, SelectField, Tabs, TextField, useLoad } from '../ui.jsx'

const COUNTRIES = ['Australia', 'France', 'Germany', 'India', 'Italy', 'Portugal', 'South Korea', 'Sweden', 'UAE', 'United Kingdom', 'United States']

function useAccounts() {
  return useLoad(() => api('/accounts'), [])
}

function AccountForm({ form, set, errors }) {
  const { lists } = useSession()
  const [dupes, setDupes] = useState([])
  useEffect(() => {
    const name = (form.name || '').trim()
    if (name.length < 3) { setDupes([]); return }
    const t = setTimeout(() => api('/accounts/duplicates', { params: { name } }).then(setDupes).catch(() => setDupes([])), 300)
    return () => clearTimeout(t)
  }, [form.name])
  return (
    <>
      {dupes.length > 0 && (
        <div className="banner banner-warn" role="alert">
          <div>Possible duplicate: {dupes.map((d, i) => <span key={d.id}>{i ? ', ' : ''}<Link to={`/accounts/${d.id}`}>{d.name}</Link> ({d.country})</span>)}. Open the existing account instead of creating a second one.</div>
        </div>
      )}
      <div className="grid-fields">
        <TextField label="Account / company name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} />
        <SelectField label="Country" required value={form.country} onChange={(v) => set('country', v)} options={COUNTRIES} placeholder="Choose…" error={errors.country} />
        <OwnerField value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
        <SelectField label="Account status" value={form.status} onChange={(v) => set('status', v)} options={lists.account_statuses} />
      </div>
    </>
  )
}

function ProspectForm({ form, set, setForm, errors, accounts }) {
  const { lists } = useSession()
  return (
    <div className="grid-fields">
      <TextField label="Full name" required value={form.full_name} onChange={(v) => set('full_name', v)} error={errors.full_name} />
      <SelectField label="Account" value={form.account_id} onChange={(v) => set('account_id', v)} placeholder="Not known yet"
        options={(accounts || []).map((a) => ({ value: a.id, label: a.name }))} />
      <TextField label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} error={errors.email} hint="At least one contact route is recommended" />
      <OwnerField value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
      <SelectField label="Status" value={form.status} onChange={(v) => set('status', v)} options={lists.prospect_statuses} />
      <NextActionFields value={form} onChange={setForm} errors={errors} />
    </div>
  )
}

function OpportunityForm({ form, set, setForm, errors, accounts }) {
  const { lists } = useSession()
  const qualified = lists.stages.findIndex((s) => s.name === form.stage) >= 1
  return (
    <div className="grid-fields">
      <TextField label="Opportunity name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} hint="e.g. Norvale · LinkedIn lead generation" />
      <SelectField label="Account" required value={form.account_id} onChange={(v) => set('account_id', v)} placeholder="Choose…" error={errors.account_id}
        options={(accounts || []).map((a) => ({ value: a.id, label: a.name }))} />
      <OwnerField value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
      <SelectField label="Sales stage" required value={form.stage} onChange={(v) => set('stage', v)}
        options={lists.stages.filter((s) => !['Won', 'Lost'].includes(s.name)).map((s) => ({ value: s.name, label: `${s.name} · ${s.probability}%` }))} />
      {qualified && <>
        <TextField label="Estimated deal value" required value={form.estimated_value} onChange={(v) => set('estimated_value', v)} error={errors.estimated_value} />
        <SelectField label="Currency" required value={form.currency} onChange={(v) => set('currency', v)} options={lists.currencies} />
        <SelectField label="Risk rating" required value={form.risk_rating} onChange={(v) => set('risk_rating', v)} options={lists.risk_ratings} error={errors.risk_rating} />
      </>}
      <NextActionFields value={form} onChange={setForm} errors={errors} />
    </div>
  )
}

const DEFAULTS = {
  account: { status: 'Target' },
  prospect: { status: 'New' },
  opportunity: { stage: 'Lead identified', currency: 'USD', risk_rating: 'Unassessed' },
}
const ENDPOINT = { account: '/accounts', prospect: '/prospects', opportunity: '/opportunities' }
const RECORD_PATH = { account: '/accounts/', prospect: '/prospects/', opportunity: '/opportunities/' }

export default function QuickCreate({ type: initialType, onClose, onCreated }) {
  const { user } = useSession()
  const navigate = useNavigate()
  const [type, setType] = useState(initialType)
  const [form, setForm] = useState({ ...DEFAULTS[initialType], owner_id: user.id })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const accounts = useAccounts()
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const switchType = (t) => { setType(t); setForm({ ...DEFAULTS[t], owner_id: user.id }); setError(null) }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== null && v !== undefined))
      const created = await api(ENDPOINT[type], { method: 'POST', body })
      onCreated()
      onClose()
      navigate(RECORD_PATH[type] + created.id)
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  const errors = error?.fieldErrors || {}
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label="Quick create" onSubmit={save} noValidate>
        <div className="card-head">
          <h2 style={{ fontSize: 18 }}>Quick create</h2>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <Tabs label="Record type" value={type} onChange={switchType}
          tabs={[{ value: 'account', label: 'Account' }, { value: 'prospect', label: 'Prospect' }, { value: 'opportunity', label: 'Opportunity' }]} />
        <ErrorBanner error={error} />
        {type === 'account' && <AccountForm form={form} set={set} errors={errors} />}
        {type === 'prospect' && <ProspectForm form={form} set={set} setForm={setForm} errors={errors} accounts={accounts.data} />}
        {type === 'opportunity' && <OpportunityForm form={form} set={set} setForm={setForm} errors={errors} accounts={accounts.data} />}
        <p className="muted small" style={{ margin: 0 }}>Only the required fields are shown here. Add the rest on the record.</p>
        <div className="row">
          <button type="submit" className="btn btn-dark" disabled={saving}>{saving ? 'Creating…' : `Create ${type}`}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
