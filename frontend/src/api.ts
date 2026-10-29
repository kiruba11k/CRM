// Thin fetch wrapper for the CRM API.
// Auth: a Google ID token (Bearer) in production, or X-Dev-User in local
// dev when VITE_DEV_USER is set and the API runs with CRM_DEV_AUTH=true.
import type { FieldErrors } from './types'

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
export const DEV_USER = import.meta.env.VITE_DEV_USER || ''
const TOKEN_KEY = 'crm_id_token'

let token: string | null = null
try { token = sessionStorage.getItem(TOKEN_KEY) } catch { token = null }
let onUnauthorized: () => void = () => {}

export function setToken(t: string | null): void {
  token = t
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ }
}
export const hasToken = (): boolean => !!token || !!DEV_USER
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn }

export class ApiError extends Error {
  status: number
  fieldErrors: FieldErrors
  extra: Record<string, unknown>

  constructor(status: number, message: string, fieldErrors: FieldErrors = {}, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
    this.extra = extra
  }
}

interface RuleDetail { message?: string; errors?: { field: string; message: string }[]; [k: string]: unknown }
interface PydanticIssue { loc?: (string | number)[]; msg: string }

// FastAPI returns our {message, errors:[{field,message}]} shape, a plain
// string, or Pydantic's [{loc, msg}] list. Normalise all three.
function parseError(status: number, body: unknown): ApiError {
  const d = (body as { detail?: unknown } | null)?.detail
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const rd = d as RuleDetail
    const fields: FieldErrors = {}
    for (const e of rd.errors || []) fields[e.field] = fields[e.field] || e.message
    return new ApiError(status, rd.message || 'Something went wrong.', fields, rd)
  }
  if (Array.isArray(d)) {
    const fields: FieldErrors = {}
    for (const e of d as PydanticIssue[]) {
      const f = (e.loc || []).filter((x) => x !== 'body' && x !== 'query').join('.')
      fields[f] = fields[f] || e.msg
    }
    return new ApiError(status, 'Check the highlighted fields.', fields)
  }
  return new ApiError(status, typeof d === 'string' ? d : `Request failed (${status})`)
}

export type Params = Record<string, string | number | boolean | null | undefined>
interface RequestOpts { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; params?: Params }

// Render's free tier sleeps idle services; the first request after a nap
// can take ~30-60s while the API wakes, so allow for it before failing.
const TIMEOUT_MS = 90_000

export async function api<T = unknown>(path: string, { method = 'GET', body, params }: RequestOpts = {}): Promise<T> {
  let url = `${BASE}/api${path}`
  if (params) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    const s = qs.toString()
    if (s) url += `?${s}`
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (DEV_USER) headers['X-Dev-User'] = DEV_USER
  else if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new ApiError(0, 'Can’t reach the CRM server. It may be waking up: try again in a minute.')
  }
  if (res.status === 401) {
    setToken(null)
    onUnauthorized()
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json')
  const data: unknown = isJson ? await res.json() : await res.text()
  if (!res.ok) throw parseError(res.status, isJson ? data : { detail: data })
  return data as T
}

// CSV download needs the auth header, so fetch it and hand the browser a blob.
export async function downloadCsv(entity: 'accounts' | 'prospects' | 'opportunities' | 'history'): Promise<void> {
  const headers: Record<string, string> = DEV_USER ? { 'X-Dev-User': DEV_USER } : { Authorization: `Bearer ${token}` }
  const res = await fetch(`${BASE}/api/export/${entity}.csv`, { headers })
  if (!res.ok) throw new ApiError(res.status, res.status === 403 ? 'CSV export is for managers and admins.' : 'Export failed.')
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `crm-${entity}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
