// Settings → Custom properties: admins add fields to companies, contacts and
// deals. Turning a field off hides it everywhere and keeps its values.
import { useEffect, useState } from 'react'
import { ApiError, api } from '../api'
import { can, useSession } from '../session'
import { ErrorBanner, SelectField, Tabs, TextField } from '../ui'
import type { CustomEntity, CustomField } from './CustomFields'

const ENTITY_LABEL: Record<CustomEntity, string> = { accounts: 'Companies', prospects: 'Contacts', opportunities: 'Deals' }
const TYPE_LABEL: Record<CustomField['type'], string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown', checkbox: 'Checkbox' }

export default function CustomFieldsSettings() {
  const { user } = useSession()
  const admin = can(user, 'manage_settings')
  const [entity, setEntity] = useState<CustomEntity>('opportunities')
  const [fields, setFields] = useState<CustomField[]>([])
  const [label, setLabel] = useState('')
  const [type, setType] = useState<CustomField['type'] | null>('text')
  const [options, setOptions] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const load = () => api<CustomField[]>('/custom-fields', { params: { entity, include_inactive: true } }).then(setFields).catch((e) => setError(e as ApiError))
  useEffect(() => { void load() }, [entity]) // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    setError(null)
    try {
      await api('/custom-fields', { method: 'POST', body: { entity, label, type, options: options.split(/[\n,]/).map((o) => o.trim()).filter(Boolean) } })
      setLabel(''); setOptions(''); void load()
    } catch (e) { setError(e as ApiError) }
  }
  async function toggle(f: CustomField) {
    setFields(fields.map((x) => (x.id === f.id ? { ...x, active: !f.active } : x)))
    try { await api(`/custom-fields/${f.id}`, { method: 'PATCH', body: { active: !f.active } }) } catch (e) { setError(e as ApiError); void load() }
  }

  return (
    <section className="card" aria-label="Custom properties">
      <div className="card-head"><div><h2>Custom properties</h2><span className="muted small">Extra fields on records. They show under “More properties” on each record and as optional table columns.</span></div></div>
      <Tabs<CustomEntity> label="Record type" value={entity} onChange={setEntity}
        tabs={(Object.keys(ENTITY_LABEL) as CustomEntity[]).map((v) => ({ value: v, label: ENTITY_LABEL[v] }))} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {fields.length === 0 && <p className="muted small" style={{ margin: 0 }}>No custom properties on {ENTITY_LABEL[entity].toLowerCase()} yet.</p>}
      {fields.map((f) => (
        <div className="list-row" key={f.id} style={{ opacity: f.active ? 1 : 0.55 }}>
          <span style={{ flex: '1 1 260px' }}><strong>{f.label}</strong> <span className="muted small">· {TYPE_LABEL[f.type]}{f.options.length ? `: ${f.options.join(', ')}` : ''}</span></span>
          {admin ? <label className="check"><input type="checkbox" checked={f.active} onChange={() => void toggle(f)} /> {f.active ? 'In use' : 'Turned off'}</label>
            : <span className={`pill pill-${f.active ? 'teal' : 'grey'}`}>{f.active ? 'In use' : 'Off'}</span>}
        </div>
      ))}
      {admin && (
        <div className="grid-fields" style={{ alignItems: 'end' }}>
          <TextField label="New property name" value={label} onChange={(v) => setLabel(v.slice(0, 60))} placeholder="e.g. Bed count, Tender reference" error={error?.fieldErrors?.label} />
          <SelectField label="Type" value={type} onChange={(v) => setType(v as CustomField['type'] | null)} options={(Object.keys(TYPE_LABEL) as CustomField['type'][]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
          {type === 'select' && <TextField label="Options" value={options} onChange={setOptions} placeholder="Comma-separated, e.g. Tier 1, Tier 2, Tier 3" error={error?.fieldErrors?.options} />}
          <button type="button" className="btn btn-primary" disabled={!label.trim() || !type} onClick={() => void add()}>Add property</button>
        </div>
      )}
      {!admin && <span className="muted small">Only admins can add or turn off properties.</span>}
      <span className="muted small">Turning a property off hides it; the values already filled in are kept and come back if you turn it on again.</span>
    </section>
  )
}
