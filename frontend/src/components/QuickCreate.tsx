// §8.2 quick-create with minimal mandatory fields; the rest go on the record.
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useSession } from '../session'
import type { Account, FieldErrors, FormValue, FormValues } from '../types'
import { ErrorBanner, NextActionFields, OwnerField, SelectField, Tabs, TextField, compact, str, useLoad } from '../ui'

export type QuickType = 'account' | 'prospect' | 'opportunity'

const COUNTRIES = ['Australia', 'France', 'Germany', 'India', 'Italy', 'Portugal', 'South Korea', 'Sweden', 'UAE', 'United Kingdom', 'United States']

interface FormProps {
  form: FormValues
  set: (k: string, v: FormValue) => void
  setForm: (f: FormValues) => void
  errors: FieldErrors
  accounts: Account[]
}

function AccountForm({ form, set, errors }: FormProps) {
  const { lists } = useSession()
  const [dupes, setDupes] = useState<Pick<Account, 'id' | 'name' | 'country'>[]>([])
  const name = str(form.name).trim()
  useEffect(() => {
    if (name.length < 3) { setDupes([]); return }
    const t = setTimeout(() => {
      api<Pick<Account, 'id' | 'name' | 'country'>[]>('/accounts/duplicates', { params: { name } }).then(setDupes).catch(() => setDupes([]))
    }, 300)
    return () => clearTimeout(t)
  }, [name])
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

function ProspectForm({ form, set, setForm, errors, accounts }: FormProps) {
  const { lists } = useSession()
  return (
    <div className="grid-fields">
      <TextField label="Full name" required value={form.full_name} onChange={(v) => set('full_name', v)} error={errors.full_name} />
      <SelectField label="Account" value={form.account_id} onChange={(v) => set('account_id', v)} placeholder="Not known yet"
        options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
      <TextField label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} error={errors.email} hint="At least one contact route is recommended" />
      <OwnerField value={form.owner_id} onChange={(v) => set('owner_id', v)} error={errors.owner_id} />
      <SelectField label="Status" value={form.status} onChange={(v) => set('status', v)} options={lists.prospect_statuses} />
      <NextActionFields value={form} onChange={setForm} errors={errors} />
    </div>
  )
}

function OpportunityForm({ form, set, setForm, errors, accounts }: FormProps) {
  const { lists } = useSession()
  const qualified = lists.stages.findIndex((s) => s.name === form.stage) >= 1
  return (
    <div className="grid-fields">
      <TextField label="Opportunity name" required value={form.name} onChange={(v) => set('name', v)} error={errors.name} hint="e.g. Norvale · LinkedIn lead generation" />
      <SelectField label="Account" required value={form.account_id} onChange={(v) => set('account_id', v)} placeholder="Choose…" error={errors.account_id}
        options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
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

const DEFAULTS: Record<QuickType, FormValues> = {
  account: { status: 'Target' },
  prospect: { status: 'New' },
  opportunity: { stage: 'Lead identified', currency: 'USD', risk_rating: 'Unassessed' },
}
const ENDPOINT: Record<QuickType, string> = { account: '/accounts', prospect: '/prospects', opportunity: '/opportunities' }
const RECORD_PATH: Record<QuickType, string> = { account: '/accounts/', prospect: '/prospects/', opportunity: '/opportunities/' }

export default function QuickCreate({ type: initialType, onClose, onCreated }: { type: QuickType; onClose: () => void; onCreated: () => void }) {
  const { user } = useSession()
  const navigate = useNavigate()
  const [type, setType] = useState<QuickType>(initialType)
  const [form, setForm] = useState<FormValues>({ ...DEFAULTS[initialType], owner_id: user.id })
  const [error, setError] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)
  const accounts = useLoad(() => api<Account[]>('/accounts'), [])
  const set = (k: string, v: FormValue) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const switchType = (t: QuickType) => { setType(t); setForm({ ...DEFAULTS[t], owner_id: user.id }); setError(null) }

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const created = await api<{ id: string }>(ENDPOINT[type], { method: 'POST', body: compact(form) })
      onCreated()
      onClose()
      navigate(RECORD_PATH[type] + created.id)
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setSaving(false)
    }
  }

  const props: FormProps = { form, set, setForm, errors: error?.fieldErrors || {}, accounts: accounts.data || [] }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" role="dialog" aria-modal="true" aria-label="Quick create" onSubmit={save} noValidate>
        <div className="card-head">
          <h2 style={{ fontSize: 18 }}>Quick create</h2>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <Tabs label="Record type" value={type} onChange={switchType}
          tabs={[{ value: 'account', label: 'Account' }, { value: 'prospect', label: 'Prospect' }, { value: 'opportunity', label: 'Opportunity' }]} />
        <ErrorBanner error={error} />
        {type === 'account' && <AccountForm {...props} />}
        {type === 'prospect' && <ProspectForm {...props} />}
        {type === 'opportunity' && <OpportunityForm {...props} />}
        <p className="muted small" style={{ margin: 0 }}>Only the required fields are shown here. Add the rest on the record.</p>
        <div className="row">
          <button type="submit" className="btn btn-dark" disabled={saving}>{saving ? 'Creating…' : `Create ${type}`}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  )
}
