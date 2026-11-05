// Custom properties (CRM review P2): fields an admin added to companies,
// contacts or deals. A card on the record page, and optional table columns.
import { useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate } from '../format'
import { ErrorBanner, SelectField, TextField } from '../ui'

export type CustomEntity = 'accounts' | 'prospects' | 'opportunities'
export interface CustomField { id: string; entity: CustomEntity; key: string; label: string; type: 'text' | 'number' | 'date' | 'select' | 'checkbox'; options: string[]; position: number; active: boolean }
export type CustomValue = string | number | boolean
type Values = Record<string, CustomValue>

export function useCustomFields(entity: CustomEntity) {
  const [fields, setFields] = useState<CustomField[]>([])
  useEffect(() => { api<CustomField[]>('/custom-fields', { params: { entity } }).then(setFields).catch(() => setFields([])) }, [entity])
  return fields
}

/** Fields plus every record's values, for table columns. */
export function useCustomColumns(entity: CustomEntity, reloadKey: unknown = null) {
  const fields = useCustomFields(entity)
  const [values, setValues] = useState<Record<string, Values>>({})
  useEffect(() => { api<Record<string, Values>>(`/custom-fields/values/${entity}`).then(setValues).catch(() => setValues({})) }, [entity, reloadKey])
  const defs = useMemo(() => fields.map((f) => ({ key: `cf_${f.key}`, label: f.label, default: false })), [fields])
  return { fields, values, defs }
}

export function showValue(f: CustomField, v: CustomValue | undefined): string {
  if (v === undefined || v === null || v === '') return '—'
  if (f.type === 'checkbox') return v ? 'Yes' : 'No'
  if (f.type === 'date') return fmtDate(String(v))
  if (f.type === 'number') return Number(v).toLocaleString()
  return String(v)
}

export function CustomFieldsCard({ entity, recordId, canEdit }: { entity: CustomEntity; recordId: string; canEdit: boolean }) {
  const fields = useCustomFields(entity)
  const [saved, setSaved] = useState<Values>({})
  const [form, setForm] = useState<Values>({})
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => {
    api<Values>(`/custom-fields/values/${entity}/${recordId}`).then((v) => { setSaved(v); setForm(v) }).catch(() => undefined)
  }, [entity, recordId])
  if (fields.length === 0) return null
  const dirty = fields.some((f) => (form[f.key] ?? '') !== (saved[f.key] ?? ''))
  const errors = error?.fieldErrors || {}
  const set = (k: string, v: CustomValue) => { setForm({ ...form, [k]: v }); setDone(false) }

  async function save() {
    setBusy(true); setError(null)
    const changed = Object.fromEntries(fields.filter((f) => (form[f.key] ?? '') !== (saved[f.key] ?? '')).map((f) => [f.key, form[f.key] ?? null]))
    try {
      const v = await api<Values>(`/custom-fields/values/${entity}/${recordId}`, { method: 'PUT', body: changed })
      setSaved(v); setForm(v); setDone(true)
    } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
  }

  return (
    <section className="card" aria-label="Custom properties">
      <div className="card-head"><h2>More properties</h2>{done && !dirty && <span className="muted small">Saved</span>}</div>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="grid-fields">
        {fields.map((f) => {
          const v = form[f.key]
          const err = errors[`custom.${f.key}`]
          if (!canEdit) return <div className="field" key={f.id}><span className="label-like">{f.label}</span><span>{showValue(f, v)}</span></div>
          if (f.type === 'checkbox') return (
            <label className="check" key={f.id} style={{ alignSelf: 'end', minHeight: 42 }}>
              <input type="checkbox" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}
            </label>
          )
          if (f.type === 'select') return <SelectField key={f.id} label={f.label} value={(v as string) ?? null} onChange={(x) => set(f.key, x ?? '')} options={f.options} placeholder="—" error={err} />
          return <TextField key={f.id} label={f.label} type={f.type === 'date' ? 'date' : 'text'} value={v === undefined ? '' : String(v)} onChange={(x) => set(f.key, x)} error={err} />
        })}
      </div>
      {canEdit && dirty && (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save properties'}</button>
          <button type="button" className="btn" onClick={() => { setForm(saved); setError(null) }}>Discard</button>
        </div>
      )}
    </section>
  )
}
