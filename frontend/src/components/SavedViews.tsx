// Saved views bar for list pages: one click to apply a named set of filters
// and sort. Views are private unless shared; each person can make one their
// default for the page. ?view=<id> in the URL opens a view (shareable link).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import type { SavedView, SavedViewPage } from '../types'
import { ErrorBanner, useLoad } from '../ui'
import { useToast } from './Toast'

type Filters = Record<string, unknown>

function same(a: Filters, b: object, defaults: object): boolean {
  const B = b as Filters, D = defaults as Filters
  return Object.keys(D).every((k) => JSON.stringify(a[k] ?? D[k]) === JSON.stringify(B[k] ?? D[k]))
}

export default function SavedViews<T extends object>({ page, value, defaults, onApply }: {
  page: SavedViewPage; value: T; defaults: T; onApply: (f: T) => void
}) {
  const toast = useToast()
  const list = useLoad(() => api<SavedView[]>('/saved-views', { params: { page } }), [page])
  const views = useMemo(() => list.data || [], [list.data])
  const [params, setParams] = useSearchParams()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [saving, setSaving] = useState<null | 'new' | 'rename'>(null)
  const [name, setName] = useState('')
  const [share, setShare] = useState(false)
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const started = useRef(false)

  const active = views.find((v) => v.id === activeId) || null
  const pick = (v: SavedView | null) => {
    setActiveId(v?.id || null)
    setMenu(false); setSaving(null)
    onApply(v ? { ...defaults, ...(v.filters as Partial<T>) } : defaults)
    const next = new URLSearchParams(params)
    if (v) next.set('view', v.id); else next.delete('view')
    setParams(next, { replace: true })
  }

  // Open the view in the link, else the person's default, once.
  useEffect(() => {
    if (started.current || !list.data) return
    started.current = true
    const fromUrl = params.get('view')
    const v = (fromUrl && views.find((x) => x.id === fromUrl)) || views.find((x) => x.is_default)
    if (v) pick(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data])

  const changed = active ? !same(active.filters, value, defaults) : !same({}, value, defaults)

  const run = async <R,>(fn: () => Promise<R>, ok?: string): Promise<R | null> => {
    setError(null)
    try { const r = await fn(); if (ok) toast(ok); return r } catch (e) { setError(e as ApiError); return null }
  }
  const saveNew = async () => {
    const v = await run(() => api<SavedView>('/saved-views', { method: 'POST', body: { page, name, filters: value, shared: share } }), `View “${name}” saved.`)
    if (v) { await list.reload(); setActiveId(v.id); setSaving(null); const next = new URLSearchParams(params); next.set('view', v.id); setParams(next, { replace: true }) }
  }
  const patch = async (body: Record<string, unknown>, ok: string) => {
    if (!active) return
    const v = await run(() => api<SavedView>(`/saved-views/${active.id}`, { method: 'PATCH', body }), ok)
    if (v) { await list.reload(); setSaving(null); setMenu(false) }
  }
  const setDefault = async (on: boolean) => {
    if (!active) return
    const r = await run(() => api('/saved-views/default', { method: 'PUT', body: { page, view_id: on ? active.id : null } }),
      on ? `“${active.name}” now opens by default.` : 'Default view removed.')
    if (r) { await list.reload(); setMenu(false) }
  }
  const remove = async () => {
    if (!active || !window.confirm(`Delete the view “${active.name}”?${active.shared ? ' It’s shared, so it disappears for everyone.' : ''}`)) return
    const r = await run(() => api(`/saved-views/${active.id}`, { method: 'DELETE' }), `View “${active.name}” deleted.`)
    if (r) { await list.reload(); pick(null) }
  }
  const copyLink = () => {
    if (!active) return
    const url = `${window.location.origin}${window.location.pathname}?view=${active.id}`
    void navigator.clipboard?.writeText(url).then(() => toast(active.shared ? 'Link copied.' : 'Link copied. Share the view so others can open it.'))
    setMenu(false)
  }

  return (
    <div className="saved-views" aria-label="Saved views">
      <ErrorBanner error={error || list.error} onClose={() => setError(null)} />
      <div className="sv-row">
        <span className="sv-label">Views</span>
        <button type="button" className={`sv-chip${!active && !changed ? ' on' : ''}`} aria-pressed={!active && !changed} onClick={() => pick(null)}>Default</button>
        {views.map((v) => (
          <span key={v.id} className={`sv-chip-wrap${active?.id === v.id ? ' on' : ''}`}>
            <button type="button" className={`sv-chip${active?.id === v.id ? ' on' : ''}`} aria-pressed={active?.id === v.id} onClick={() => pick(v)}
              title={v.mine ? (v.shared ? 'Your view · shared with the team' : 'Your view · only you see it') : `Shared by ${v.owner_name}`}>
              {v.is_default && <span aria-label="Your default" className="sv-star">★</span>}
              {v.name}
              {v.shared && <span className="sv-tag">{v.mine ? 'shared' : v.owner_name.split(' ')[0]}</span>}
              {active?.id === v.id && changed && <span className="sv-dot" aria-label="Changed" />}
            </button>
            {active?.id === v.id && (
              <button type="button" className="sv-more" aria-label={`More options for ${v.name}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>⋯</button>
            )}
          </span>
        ))}
        <span className="sv-spacer" />
        {changed && !saving && <>
          {active?.mine && <button type="button" className="btn btn-outline sv-btn" onClick={() => void patch({ filters: value }, `View “${active.name}” updated.`)}>Update “{active.name}”</button>}
          <button type="button" className="btn btn-dark sv-btn" onClick={() => { setSaving('new'); setName(''); setShare(false) }}>{active ? 'Save as new view' : 'Save view'}</button>
        </>}
      </div>

      {menu && active && (
        <div className="sv-menu" role="menu">
          {active.mine && <button type="button" role="menuitem" onClick={() => { setSaving('rename'); setName(active.name); setMenu(false) }}>Rename</button>}
          {active.mine && <button type="button" role="menuitem" onClick={() => void patch({ shared: !active.shared }, active.shared ? 'Only you can see this view now.' : 'View shared with the team.')}>{active.shared ? 'Stop sharing' : 'Share with the team'}</button>}
          <button type="button" role="menuitem" onClick={() => void setDefault(!active.is_default)}>{active.is_default ? 'Stop opening by default' : 'Open this view by default'}</button>
          <button type="button" role="menuitem" onClick={copyLink}>Copy link</button>
          {active.mine && <button type="button" role="menuitem" className="danger" onClick={() => void remove()}>Delete view</button>}
          {!active.mine && <span className="muted small" style={{ padding: '4px 10px' }}>Shared by {active.owner_name}. Change the filters and “Save as new view” to make your own copy.</span>}
        </div>
      )}

      {saving && (
        <form className="sv-save" onSubmit={(e) => { e.preventDefault(); void (saving === 'new' ? saveNew() : patch({ name }, `Renamed to “${name}”.`)) }}>
          <input className="input" autoFocus maxLength={60} placeholder="Name this view, e.g. UK engaged prospects" aria-label="View name" value={name} onChange={(e) => setName(e.target.value)} />
          {saving === 'new' && <label className="check"><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with the team</label>}
          <button type="submit" className="btn btn-dark" disabled={!name.trim()}>{saving === 'new' ? 'Save' : 'Rename'}</button>
          <button type="button" className="btn" onClick={() => setSaving(null)}>Cancel</button>
        </form>
      )}
    </div>
  )
}
