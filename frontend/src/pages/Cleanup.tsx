// "Needs cleanup": imported records that still break a CRM rule. Fixing the
// record and saving it removes it from this list.
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Duplicates from '../components/Duplicates'
import { api } from '../api'
import { can, useSession } from '../session'
import type { CleanupItem } from '../types'
import { ErrorBanner, Tabs, useLoad } from '../ui'

type Scope = 'mine' | 'all'
const KIND: Record<CleanupItem['entity'], { label: string; pill: string; path: string }> = {
  account: { label: 'Account', pill: 'grey', path: '/companies/' },
  prospect: { label: 'Prospect', pill: 'blue', path: '/contacts/' },
  opportunity: { label: 'Opportunity', pill: 'teal', path: '/opportunities/' },
}

export default function Cleanup() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'duplicates' ? 'duplicates' : 'rules'
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cleanup</h1>
          <p>{tab === 'rules'
            ? 'Imported records that break a CRM rule. Open each one, fix what’s listed and save: it leaves this list once it passes the rules.'
            : 'Accounts and prospects that look like the same company or person. Compare them, choose what to keep, and merge.'}</p>
        </div>
      </div>
      <Tabs<'rules' | 'duplicates'> label="Cleanup" value={tab} onChange={(t) => setParams(t === 'duplicates' ? { tab: t } : {}, { replace: true })}
        tabs={[{ value: 'rules', label: 'Needs cleanup' }, { value: 'duplicates', label: 'Duplicates' }]} />
      {tab === 'rules' ? <RuleBreaks /> : <Duplicates />}
    </>
  )
}

export function RuleBreaks() {
  const { user } = useSession()
  const [scope, setScope] = useState<Scope>(can(user, 'team_view') ? 'all' : 'mine')
  const { data, error, loading } = useLoad(() => api<CleanupItem[]>('/import/cleanup', { params: { scope } }), [scope])
  const rows = data || []
  return (
    <>
      <Tabs<Scope> label="Whose records" value={scope} onChange={setScope}
        tabs={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Everyone’s' }]} />
      <ErrorBanner error={error} />
      {loading && !data ? <div className="loading" data-label="Loading…">Loading…</div> : (
        <div className="table-wrap">
          <table style={{ minWidth: 860 }}>
            <thead><tr><th>Record</th><th>Account</th><th>Owner</th><th>What to fix</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const k = KIND[r.entity]
                return (
                  <tr key={`${r.entity}-${r.id}`}>
                    <td><span className={`pill pill-${k.pill}`}>{k.label}</span> <Link to={k.path + r.id} style={{ fontWeight: 600 }}>{r.name}</Link></td>
                    <td className="muted">{r.account_name || '—'}</td>
                    <td className="muted">{r.owner_name || '—'}</td>
                    <td><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.reasons.map((m) => <li key={m}>{m}</li>)}</ul></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">Nothing to clean up{scope === 'mine' ? ' for you' : ''}.</div>}
        </div>
      )}
    </>
  )
}
