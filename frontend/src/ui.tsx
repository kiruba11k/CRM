// Small shared building blocks: form fields, banners, tabs, data loading.
import { useCallback, useEffect, useId, useState, type DependencyList, type ReactNode } from 'react'
import { ApiError } from './api'
import { useSession } from './session'
import type { FieldErrors, FormValue, FormValues, Issue } from './types'

export const str = (v: FormValue): string => (v === null || v === undefined ? '' : String(v))

export function Field({ label, required, error, hint, children, id }: {
  label: string; required?: boolean; error?: string; hint?: string; children: ReactNode; id: string
}) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label} {required && <span className="req" aria-hidden="true">*</span>}</label>
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

interface TextFieldProps {
  label: string; value: FormValue; onChange: (v: string) => void; required?: boolean; error?: string; hint?: string
  type?: 'text' | 'email' | 'date' | 'search'; maxLength?: number; placeholder?: string; multiline?: boolean
}
export function TextField({ label, value, onChange, required, error, hint, type = 'text', maxLength, placeholder, multiline }: TextFieldProps) {
  const id = useId()
  const props = { id, value: str(value), maxLength, placeholder, required, 'aria-invalid': !!error }
  return (
    <Field label={label} required={required} error={error} hint={hint} id={id}>
      {multiline
        ? <textarea {...props} onChange={(e) => onChange(e.target.value)} />
        : <input type={type} {...props} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  )
}

export type Option = string | { value: string; label: string }
interface SelectFieldProps {
  label: string; value: FormValue; onChange: (v: string | null) => void; options: Option[]
  required?: boolean; error?: string; hint?: string; placeholder?: string
}
export function SelectField({ label, value, onChange, options, required, error, hint, placeholder }: SelectFieldProps) {
  const id = useId()
  return (
    <Field label={label} required={required} error={error} hint={hint} id={id}>
      <select id={id} value={str(value)} onChange={(e) => onChange(e.target.value || null)} aria-invalid={!!error}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </Field>
  )
}

export function OwnerField({ value, onChange, error, label = 'Owner', required = true }: {
  value: FormValue; onChange: (v: string | null) => void; error?: string; label?: string; required?: boolean
}) {
  const { users } = useSession()
  return (
    <SelectField label={label} value={value} onChange={onChange} required={required} error={error} placeholder="Choose…"
      options={users.filter((u) => u.active !== false).map((u) => ({ value: u.id, label: u.name }))} />
  )
}

// §5.1/§5.2: controlled list + "Other" description (≤ 50 chars) + due date.
export function NextActionFields<F extends FormValues>({ value, onChange, errors = {}, prefix = 'next_action', withDue = true, required = true, dueLabel = 'Due date' }: {
  value: F; onChange: (v: F) => void; errors?: FieldErrors; prefix?: string; withDue?: boolean; required?: boolean; dueLabel?: string
}) {
  const { lists } = useSession()
  const code = value[`${prefix}_code`]
  const other = str(value[`${prefix}_other`])
  const set = (k: string, v: FormValue) => onChange({ ...value, [`${prefix}_${k}`]: v })
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

export function Banner({ kind = 'ok', children, onClose }: { kind?: 'ok' | 'err' | 'warn'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && <button type="button" onClick={onClose} aria-label="Dismiss">×</button>}
    </div>
  )
}

export function ErrorBanner({ error, onClose }: { error: ApiError | Error | null | undefined; onClose?: () => void }) {
  if (!error) return null
  const list = Object.values(error instanceof ApiError ? error.fieldErrors : {})
  return (
    <Banner kind="err" onClose={onClose}>
      {error.message}
      {list.length > 0 && <ul>{list.map((m, i) => <li key={i}>{m}</li>)}</ul>}
    </Banner>
  )
}

export function WarningsBanner({ warnings }: { warnings: Issue[] | null | undefined }) {
  if (!warnings?.length) return null
  return (
    <Banner kind="warn">
      Review prompts (they never change your data)
      <ul>{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
    </Banner>
  )
}

export interface TabDef<V extends string> { value: V; label: string; count?: number }
export function Tabs<V extends string>({ tabs, value, onChange, label }: { tabs: TabDef<V>[]; value: V; onChange: (v: V) => void; label: string }) {
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

export function Segmented<V extends string>({ options, value, onChange, label }: { options: { value: V; label: string }[]; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

export interface Loaded<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => Promise<void> }

// Load data with refresh; keeps the previous data while reloading.
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [state, setState] = useState<Omit<Loaded<T>, 'reload'>>({ data: null, error: null, loading: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      setState({ data: await fn(), error: null, loading: false })
    } catch (error) {
      setState((s) => ({ ...s, error: error as ApiError, loading: false }))
    }
  }, deps)
  useEffect(() => { void run() }, [run])
  return { ...state, reload: run }
}

const PROSPECT_PILL: Record<string, string> = { New: 'grey', Contacted: 'blue', Engaged: 'amber', Qualified: 'teal', Nurture: 'purple', Disqualified: 'red' }
const RISK_PILL: Record<string, string> = { Unassessed: 'grey', Low: 'teal', Medium: 'amber', High: 'red' }
export const StatusPill = ({ status }: { status: string }) => <span className={`pill pill-${PROSPECT_PILL[status] || 'grey'}`}>{status}</span>
export const RiskPill = ({ risk }: { risk: string }) => <span className={`pill pill-${RISK_PILL[risk] || 'grey'}`}>Risk: {risk}</span>

// Strip empty values before POSTing a form (the API treats absent = unset).
export function compact(form: FormValues): FormValues {
  return Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== null && v !== undefined))
}

// Fields whose value differs from the loaded record → PATCH body.
export function changedFields<R extends object>(form: FormValues, record: R, keys: readonly string[]): FormValues {
  const rec = record as Record<string, unknown>
  const out: FormValues = {}
  for (const k of keys) {
    const now = form[k] === '' ? null : form[k]
    const was = rec[k] ?? null
    if (str(now ?? null) !== str((was as FormValue) ?? null)) out[k] = now ?? null
  }
  return out
}
