// Cleanup → Duplicates: likely duplicate accounts and prospects, a side-by-side
// compare where you pick which values to keep, and a log of past merges.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { fmtDate, fmtDateTime, nextActionLabel } from '../format'
import { useSession } from '../session'
import type { DupCompare, DupEntity, DupList, DupPair, DupRecord, MergeEntry } from '../types'
import { Banner, ErrorBanner, Segmented, useLoad } from '../ui'
import { useToast } from './Toast'

type Choice = 'keep' | 'merge' | 'both'
const LABELS: Record<string, string> = {
  name: 'Name', full_name: 'Name', country: 'Country', region: 'Region', industry: 'Industry', owner_id: 'Owner', status: 'Status',
  website: 'Website', linkedin_url: 'LinkedIn', notes: 'Notes', account_id: 'Account', job_title: 'Job title', email: 'Email',
  phone: 'Phone', source: 'Source', next_action: 'Next action',
}
const nameOf = (r: DupRecord) => (r.name || r.full_name || '') as string
const pathOf = (e: DupEntity, id: string) => `/${e}/${id}`

function useDisplay() {
  const { lists } = useSession()
  return (f: string, r: DupRecord): string => {
    if (f === 'owner_id') return (r.owner_name as string) || '—'
    if (f === 'account_id') return (r.account_name as string) || '—'
    if (f === 'next_action') return r.next_action_code ? `${nextActionLabel(lists, r.next_action_code as string, r.next_action_other as string | null)} · ${fmtDate(r.next_action_due as string)}` : '—'
    const v = r[f]
    return v === null || v === undefined || v === '' ? '—' : String(v)
  }
}
const raw = (f: string, r: DupRecord) => (f === 'next_action' ? `${r.next_action_code}|${r.next_action_due}` : JSON.stringify(r[f] ?? null))

function MiniCard({ r, entity }: { r: DupRecord; entity: DupEntity }) {
  return (
    <div className="dup-card">
      <Link to={pathOf(entity, r.id)} className="dup-name">{nameOf(r)}</Link>
      <span className="muted small">
        {entity === 'accounts'
          ? [r.country, r.website, r.owner_name && `Owner ${r.owner_name}`].filter(Boolean).join(' · ')
          : [r.job_title, r.account_name || 'No company', r.email, r.owner_name && `Owner ${r.owner_name}`].filter(Boolean).join(' · ')}
      </span>
      <span className="small">{entity === 'accounts' ? `${r.prospects ?? 0} prospects · ${r.deals ?? 0} deals` : `${r.deals ?? 0} deals`} · added {fmtDate(r.created_at)}</span>
    </div>
  )
}

function Compare({ entity, pair, onDone, onCancel }: { entity: DupEntity; pair: DupPair; onDone: (msg: string) => void; onCancel: () => void }) {
  const show = useDisplay()
  const data = useLoad(() => api<DupCompare>(`/duplicates/${entity}/compare`, { params: { a: pair.a.id, b: pair.b.id } }), [entity, pair.a.id, pair.b.id])
  // Keep the record with more linked to it (or the older one) by default.
  const weight = (r: DupRecord) => ((r.deals as number) || 0) * 10 + ((r.prospects as number) || 0) * 5 + ((r.activity as number) || 0)
  const [keepSide, setKeepSide] = useState<'a' | 'b' | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  if (data.error) return <ErrorBanner error={data.error} />
  if (!data.data) return <div className="loading" data-label="Loading…">Loading…</div>
  const d = data.data
  const side = keepSide || (weight(d.b) > weight(d.a) || (weight(d.b) === weight(d.a) && d.b.created_at < d.a.created_at) ? 'b' : 'a')
  const keep = d[side], other = d[side === 'a' ? 'b' : 'a']
  // The value the kept record will end up with, given defaults.
  const pickOf = (f: string): Choice => choices[f] || (show(f, keep) === '—' && show(f, other) !== '—' ? 'merge' : 'keep')
  const differing = d.fields.filter((f) => raw(f, keep) !== raw(f, other))
  const same = d.fields.filter((f) => !differing.includes(f))
  const merge = async () => {
    setBusy(true); setError(null)
    try {
      const body = { keep_id: keep.id, merge_id: other.id, choices: Object.fromEntries(differing.map((f) => [f, pickOf(f)])) }
      const r = await api<{ moved: Record<string, number> }>(`/duplicates/${entity}/merge`, { method: 'POST', body })
      const bits = Object.entries(r.moved).filter(([k, v]) => v && ['prospects', 'deals', 'activities', 'meetings', 'emails'].includes(k)).map(([k, v]) => `${v} ${k}`)
      onDone(`Merged “${nameOf(other)}” into “${nameOf(keep)}”.${bits.length ? ` Moved ${bits.join(', ')}.` : ''}`)
    } catch (e) { setError(e as ApiError) } finally { setBusy(false) }
  }
  const moving = entity === 'accounts' ? `${other.prospects ?? 0} prospects, ${other.deals ?? 0} deals` : `${other.deals ?? 0} deals`
  return (
    <div className="dup-compare">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="table-wrap">
        <table className="dup-table">
          <thead><tr><th>Field</th>
            {(['a', 'b'] as const).map((s) => (
              <th key={s}>
                <label className="dup-keep"><input type="radio" name="keep" checked={side === s} onChange={() => { setKeepSide(s); setChoices({}) }} />
                  {side === s ? <span className="pill pill-teal">Keep</span> : <span className="pill pill-red">Merge &amp; remove</span>} {nameOf(d[s])}</label>
              </th>
            ))}
          </tr></thead>
          <tbody>
            {differing.map((f) => {
              const pick = pickOf(f)
              return (
                <tr key={f} className="dup-diff">
                  <td><strong>{LABELS[f] || f}</strong></td>
                  {(['a', 'b'] as const).map((s) => {
                    const mine: Choice = d[s].id === keep.id ? 'keep' : 'merge'
                    return (
                      <td key={s}>
                        <label className={`dup-val${pick === mine || pick === 'both' ? ' on' : ''}`}>
                          <input type="radio" name={`f-${f}`} checked={pick === mine} onChange={() => setChoices({ ...choices, [f]: mine })} />
                          <span>{show(f, d[s])}</span>
                        </label>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {differing.includes('notes') && (
              <tr><td /><td colSpan={2}><label className="check small"><input type="checkbox" checked={pickOf('notes') === 'both'} onChange={(e) => setChoices({ ...choices, notes: e.target.checked ? 'both' : 'keep' })} /> Keep both sets of notes</label></td></tr>
            )}
            {same.length > 0 && <tr><td colSpan={3} className="muted small">Same on both: {same.map((f) => LABELS[f] || f).join(', ')}</td></tr>}
          </tbody>
        </table>
      </div>
      <Banner kind="warn">
        “{nameOf(other)}” will be removed. Its {moving}, activity, meetings, linked emails and change history move to “{nameOf(keep)}”. The merge is logged with a copy of the removed record.
      </Banner>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void merge()}>{busy ? 'Merging…' : `Merge into “${nameOf(keep)}”`}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export default function Duplicates() {
  const toast = useToast()
  const [entity, setEntity] = useState<DupEntity>('accounts')
  const list = useLoad(() => api<DupList>(`/duplicates/${entity}`), [entity])
  const merges = useLoad(() => api<MergeEntry[]>('/duplicates/merges'), [])
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const pairs = useMemo(() => list.data?.pairs || [], [list.data])
  const key = (p: DupPair) => `${p.a.id}-${p.b.id}`
  const dismiss = async (p: DupPair) => {
    try {
      await api(`/duplicates/${entity}/dismiss`, { method: 'POST', body: { a: p.a.id, b: p.b.id } })
      toast('Marked as not duplicates. They won’t be suggested again.')
      void list.reload()
    } catch (e) { setError(e as ApiError) }
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <Segmented<DupEntity> label="Record type" value={entity} onChange={(v) => { setEntity(v); setOpen(null) }}
          options={[{ value: 'accounts', label: 'Accounts' }, { value: 'prospects', label: 'Prospects' }]} />
        {list.data && <span className="muted small">{list.data.count} possible duplicate{list.data.count === 1 ? '' : 's'} · strongest first</span>}
      </div>
      <ErrorBanner error={list.error || error} onClose={() => setError(null)} />
      {list.data && !list.data.can_merge && pairs.length > 0 && <Banner kind="warn">You can review these. Merging or dismissing needs the “Edit and reassign anyone’s records” permission.</Banner>}
      {list.loading && !list.data && <div className="loading" data-label="Looking for duplicates…">Looking for duplicates…</div>}
      {list.data && pairs.length === 0 && <div className="card"><div className="empty">No likely duplicate {entity} found. Nice and tidy.</div></div>}
      <div className="dup-list">
        {pairs.map((p) => (
          <section className="card dup-pair" key={key(p)} aria-label={`${nameOf(p.a)} and ${nameOf(p.b)}`}>
            <div className="dup-head">
              <span className={`dup-score ${p.score >= 90 ? 'high' : p.score >= 75 ? 'mid' : 'low'}`}>{p.score >= 90 ? 'Very likely' : p.score >= 75 ? 'Likely' : 'Possible'}</span>
              {p.reasons.map((r) => <span key={r} className="pill pill-paper">{r}</span>)}
            </div>
            <div className="dup-cards"><MiniCard r={p.a} entity={entity} /><span className="dup-vs" aria-hidden="true">⇄</span><MiniCard r={p.b} entity={entity} /></div>
            {open === key(p)
              ? <Compare entity={entity} pair={p} onCancel={() => setOpen(null)} onDone={(m) => { toast(m); setOpen(null); void list.reload(); void merges.reload() }} />
              : list.data?.can_merge && (
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-dark" onClick={() => setOpen(key(p))}>Compare &amp; merge</button>
                  <button type="button" className="btn" onClick={() => void dismiss(p)}>Not duplicates</button>
                </div>
              )}
          </section>
        ))}
      </div>
      {(merges.data || []).length > 0 && (
        <section className="card" aria-label="Recent merges">
          <h2>Recent merges</h2>
          {(merges.data || []).map((m) => (
            <div className="list-row" key={m.id}>
              <span style={{ flex: '1 1 320px' }}>
                <strong>{m.merged_name}</strong> → <Link to={`/${m.entity_type}s/${m.kept_id}`}>{m.kept_name}</Link>
                <br /><span className="muted small">{m.entity_type === 'account' ? 'Account' : 'Prospect'} · {m.merged_by || 'someone'} · {fmtDateTime(m.merged_at)}</span>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  )
}
