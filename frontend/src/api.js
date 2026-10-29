// Thin fetch wrapper for the CRM API.
// Auth: a Google ID token (Bearer) in production, or X-Dev-User in local
// dev when VITE_DEV_USER is set and the API runs with CRM_DEV_AUTH=true.

const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
export const DEV_USER = import.meta.env.VITE_DEV_USER || ''
const TOKEN_KEY = 'crm_id_token'

let token = null
try { token = sessionStorage.getItem(TOKEN_KEY) } catch { token = null }
let onUnauthorized = () => {}

export function setToken(t) {
  token = t
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ }
}
export const hasToken = () => !!token || !!DEV_USER
export function setUnauthorizedHandler(fn) { onUnauthorized = fn }

export class ApiError extends Error {
  constructor(status, message, fieldErrors = {}, extra = {}) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
    this.extra = extra
  }
}

// FastAPI returns either our {message, errors:[{field,message}]} shape,
// a plain string, or Pydantic's [{loc, msg}] list. Normalise all three.
function parseError(status, body) {
  const d = body?.detail
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const fields = {}
    for (const e of d.errors || []) fields[e.field] = fields[e.field] || e.message
    return new ApiError(status, d.message || 'Something went wrong.', fields, d)
  }
  if (Array.isArray(d)) {
    const fields = {}
    for (const e of d) {
      const f = (e.loc || []).filter((x) => x !== 'body' && x !== 'query').join('.')
      fields[f] = fields[f] || e.msg
    }
    return new ApiError(status, 'Check the highlighted fields.', fields)
  }
  return new ApiError(status, typeof d === 'string' ? d : `Request failed (${status})`)
}

export async function api(path, { method = 'GET', body, params } = {}) {
  let url = `${BASE}/api${path}`
  if (params) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, v)
    const s = qs.toString()
    if (s) url += `?${s}`
  }
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (DEV_USER) headers['X-Dev-User'] = DEV_USER
  else if (token) headers.Authorization = `Bearer ${token}`
  let res
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'Can’t reach the CRM server. Check your connection and try again.')
  }
  if (res.status === 401) {
    setToken(null)
    onUnauthorized()
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json')
  const data = isJson ? await res.json() : await res.text()
  if (!res.ok) throw parseError(res.status, isJson ? data : { detail: data })
  return data
}

export const exportUrl = (entity) => `${BASE}/api/export/${entity}.csv`

// CSV download needs the auth header, so fetch it and hand the browser a blob.
export async function downloadCsv(entity) {
  const headers = DEV_USER ? { 'X-Dev-User': DEV_USER } : { Authorization: `Bearer ${token}` }
  const res = await fetch(exportUrl(entity), { headers })
  if (!res.ok) throw new ApiError(res.status, res.status === 403 ? 'CSV export is for managers and admins.' : 'Export failed.')
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `crm-${entity}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
