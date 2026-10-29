// Small shared building blocks: form fields, banners, tabs, data loading.
import { useCallback, useEffect, useId, useState } from 'react'
import { useSession } from './session.jsx'

export function Field({ label, required, error, hint, children, id }) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label} {required && <span className="req" aria-hidden="true">*</span>}</label>
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export function TextField({ label, value, onChange, required, error, hint, type = 'text', maxLength, placeholder, multiline }) {
  const id = useId()
  const props = { id, value: value ?? '', onChange: (e) => onChange(e.target.value), maxLength, placeholder, required, 'aria-invalid': !!error }
  return (
    <Field label={label} required={required} error={error} hint={hint} id={id}>
      {multiline ? <textarea {...props} /> : <input type={type} {...props} />}
    </Field>
  )
}

export function SelectField({ label, value, onChange, options, required, error, hint, placeholder }) {
  const id = useId()
  return (
    <Field label={label} required={required} error={error} hint={hint} id={id}>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-invalid={!!error}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </Field>
  )
}

export function OwnerField({ value, onChange, error, label = 'Owner', required = true }) {
  const { users } = useSession()
  return (
    <SelectField label={label} value={value} onChange={onChange} required={required} error={error} placeholder="Choose…"
      options={users.filter((u) => u.active).map((u) => ({ value: u.id, label: u.name }))} />
  )
}

// §5.1/§5.2: controlled list + "Other" description (≤ 50 chars) + due date.
export function NextActionFields({ value, onChange, errors = {}, prefix = 'next_action', withDue = true, required = true, dueLabel = 'Due date' }) {
  const { lists } = useSession()
  const code = value[`${prefix}_code`]
  const other = value[`${prefix}_other`] || ''
  const set = (k, v) => onChange({ ...value, [`${prefix}_${k}`]: v })
  return (
    <>
      <SelectField label="Next action" required={required} value={code} error={errors[`${prefix}_code`]}
        placeholder="Choose next action…"
        onChange={(v) => onChange({ ...value, [`${prefix}_code`]: v, [`${prefix}_other`]: v === lists.other_code ? other : null })}
        options={lists.next_actions.map((n) => ({ value: n.code, label: `${n.code} · ${n.label}` }))} />
      {code === lists.other_code && (
        <TextField label="Describe “Other”" required value={other} maxLength={lists.other_max_length}
          onChange={(v) => set('other', v.slice(0, lists.other_max_length))}
          error={errors[`${prefix}_other`]} hint={`${other.length} / ${lists.other_max_length} characters`} />
      )}
      {withDue && (
        <TextField label={dueLabel} type="date" required={required} value={value[`${prefix}_due`]} onChange={(v) => set('due', v || null)}
          error={errors[`${prefix}_due`]} />
      )}
    </>
  )
}

export function Banner({ kind = 'ok', children, onClose }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && <button type="button" onClick={onClose} aria-label="Dismiss">×</button>}
    </div>
  )
}

export function ErrorBanner({ error, onClose }) {
  if (!error) return null
  const list = Object.values(error.fieldErrors || {})
  return (
    <Banner kind="err" onClose={onClose}>
      {error.message}
      {list.length > 0 && <ul>{list.map((m, i) => <li key={i}>{m}</li>)}</ul>}
    </Banner>
  )
}

export function WarningsBanner({ warnings }) {
  if (!warnings?.length) return null
  return (
    <Banner kind="warn">
      Review prompts (they never change your data)
      <ul>{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
    </Banner>
  )
}

export function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}{t.count !== undefined && <span className="muted"> {t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

// Load data with refresh; keeps the previous data while reloading.
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      setState({ data: await fn(), error: null, loading: false })
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { run() }, [run])
  return { ...state, reload: run }
}

const PROSPECT_PILL = { New: 'grey', Contacted: 'blue', Engaged: 'amber', Qualified: 'teal', Nurture: 'purple', Disqualified: 'red' }
const RISK_PILL = { Unassessed: 'grey', Low: 'teal', Medium: 'amber', High: 'red' }
export const StatusPill = ({ status }) => <span className={`pill pill-${PROSPECT_PILL[status] || 'grey'}`}>{status}</span>
export const RiskPill = ({ risk }) => <span className={`pill pill-${RISK_PILL[risk] || 'grey'}`}>Risk: {risk}</span>
