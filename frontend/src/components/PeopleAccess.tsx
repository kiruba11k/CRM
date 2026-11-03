// Settings → People & access: who uses the CRM, their job title and role,
// and what each role is allowed to do. Anyone can look; people with the
// “Manage people and roles” permission can change it.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../api'
import { fmtDate, fmtDateTime } from '../format'
import { can, useSession } from '../session'
import { Avatar } from '../theme'
import type { Permission, RoleDef, RolesResponse, User } from '../types'
import { Banner, ErrorBanner, SelectField, TextField, useLoad } from '../ui'
import { useToast } from './Toast'

type Status = 'active' | 'pending' | 'inactive'
const statusOf = (u: User): Status => (u.active === false ? 'inactive' : u.last_seen_at ? 'active' : 'pending')
const STATUS: Record<Status, { label: string; pill: string }> = {
  active: { label: 'Active', pill: 'teal' }, pending: { label: 'Hasn’t signed in yet', pill: 'amber' }, inactive: { label: 'Deactivated', pill: 'grey' },
}

function useRun() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    setBusy(true); setError(null)
    try { const r = await fn(); if (ok) toast(ok); return r } catch (e) { setError(e as ApiError); return null } finally { setBusy(false) }
  }
  return { busy, error, setError, run }
}

// ── People ────────────────────────────────────────────────────────────

function AddPerson({ roles, onAdded, onCancel }: { roles: RoleDef[]; onAdded: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', email: '', title: '', role: 'salesperson' })
  const { busy, error, setError, run } = useRun()
  const role = roles.find((r) => r.key === f.role)
  const submit = async () => {
    const r = await run(() => api('/users', { method: 'POST', body: { ...f, title: f.title || null } }), `${f.name} added. They can sign in with their Google account now.`)
    if (r) onAdded()
  }
  return (
    <div className="person-form" aria-label="Add a person">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="grid-fields">
        <TextField label="Full name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="Priya Nair" />
        <TextField label="Work email" required type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} placeholder="priya@leadstrategus.com" />
        <TextField label="Job title" value={f.title} onChange={(v) => setF({ ...f, title: v })} placeholder="e.g. Account executive" maxLength={80} />
        <SelectField label="Role" required value={f.role} onChange={(v) => setF({ ...f, role: v || 'salesperson' })} options={roles.map((r) => ({ value: r.key, label: r.name }))} hint={role?.description} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-dark" disabled={busy || !f.name.trim() || !f.email.trim()} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add person'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <span className="muted small">No invitation email is sent: tell them to open the CRM and sign in with Google.</span>
      </div>
    </div>
  )
}

function PersonRow({ u, roles, editable, self, onChanged }: { u: User; roles: RoleDef[]; editable: boolean; self: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({ name: u.name, title: u.title || '' })
  const { busy, error, setError, run } = useRun()
  const st = statusOf(u)
  const patch = async (body: Record<string, unknown>, ok: string) => {
    const r = await run(() => api(`/users/${u.id}`, { method: 'PATCH', body }), ok)
    if (r) { setEditing(false); onChanged() }
  }
  return (
    <>
      <tr className={st === 'inactive' ? 'row-dim' : undefined}>
        <td>
          <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
            <Avatar name={u.name} size={32} />
            {editing ? (
              <span className="person-edit">
                <input className="input" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </span>
            ) : (
              <span style={{ minWidth: 0 }}><strong>{u.name}</strong>{self && <span className="muted small"> (you)</span>}<br /><span className="muted small">{u.email}</span></span>
            )}
          </span>
        </td>
        <td>{editing
          ? <input className="input" aria-label="Job title" placeholder="Job title" maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          : u.title || <span className="muted">—</span>}</td>
        <td>
          {editable && st !== 'inactive' ? (
            <select className="input" aria-label={`Role for ${u.name}`} value={u.role} disabled={busy}
              onChange={(e) => void patch({ role: e.target.value }, `${u.name} is now ${roles.find((r) => r.key === e.target.value)?.name}.`)}>
              {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </select>
          ) : <span className="pill pill-paper">{u.role_name || u.role}</span>}
        </td>
        <td>
          <span className={`pill pill-${STATUS[st].pill}`}>{STATUS[st].label}</span><br />
          <span className="muted small">{st === 'active' ? `Last seen ${fmtDateTime(u.last_seen_at)}` : u.created_at ? `Added ${fmtDate(u.created_at)}` : ''}</span>
        </td>
        <td className="acts-cell">
          {editable && (editing ? (
            <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void patch({ name: f.name, title: f.title }, `${f.name} updated.`)}>Save</button>
              <button type="button" className="btn" onClick={() => { setEditing(false); setF({ name: u.name, title: u.title || '' }) }}>Cancel</button>
            </span>
          ) : (
            <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
              {!self && <button type="button" className="btn" disabled={busy}
                onClick={() => {
                  if (u.active === false) void patch({ active: true }, `${u.name} reactivated.`)
                  else if (window.confirm(`Deactivate ${u.name}? They can’t sign in any more; their records keep them as owner until you reassign them.`)) void patch({ active: false }, `${u.name} deactivated.`)
                }}>{u.active === false ? 'Reactivate' : 'Deactivate'}</button>}
            </span>
          ))}
        </td>
      </tr>
      {error && <tr><td colSpan={5}><ErrorBanner error={error} onClose={() => setError(null)} /></td></tr>}
    </>
  )
}

// ── Roles ─────────────────────────────────────────────────────────────

function NewRole({ roles, onSaved, onCancel }: { roles: RoleDef[]; onSaved: (r: RolesResponse) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', description: '', from: 'salesperson' })
  const { busy, error, setError, run } = useRun()
  const submit = async () => {
    const base = roles.find((r) => r.key === f.from)
    const r = await run(() => api<RolesResponse>('/roles', { method: 'POST', body: { name: f.name, description: f.description, permissions: base?.permissions || [] } }),
      `Role ${f.name} created. Tick what it can do below.`)
    if (r) onSaved(r)
  }
  return (
    <div className="person-form" aria-label="New role">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="grid-fields">
        <TextField label="Role name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="e.g. Business development rep" maxLength={40} />
        <TextField label="What it’s for" value={f.description} onChange={(v) => setF({ ...f, description: v })} maxLength={200} placeholder="One line people will see when choosing a role" />
        <SelectField label="Start with the access of" value={f.from} onChange={(v) => setF({ ...f, from: v || 'salesperson' })} options={roles.map((r) => ({ value: r.key, label: r.name }))} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-dark" disabled={busy || f.name.trim().length < 2} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create role'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function RoleHead({ r, roles, editable, onSaved }: { r: RoleDef; roles: RoleDef[]; editable: boolean; onSaved: (x: RolesResponse) => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [f, setF] = useState({ name: r.name, description: r.description })
  const [to, setTo] = useState(roles.find((x) => x.key !== r.key && x.key === 'salesperson')?.key || roles.find((x) => x.key !== r.key)?.key || '')
  const { busy, error, setError, run } = useRun()
  const save = async () => {
    const x = await run(() => api<RolesResponse>(`/roles/${r.key}`, { method: 'PATCH', body: f }), `Role ${f.name} saved.`)
    if (x) { setMode('view'); onSaved(x) }
  }
  const remove = async () => {
    const q = r.members ? `?reassign_to=${encodeURIComponent(to)}` : ''
    const x = await run(() => api<RolesResponse>(`/roles/${r.key}${q}`, { method: 'DELETE' }), `Role ${r.name} deleted.`)
    if (x) onSaved(x)
  }
  return (
    <th className="role-col" scope="col">
      {mode === 'edit' ? (
        <span className="role-edit">
          <input className="input" aria-label="Role name" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <textarea className="input" aria-label="Role description" value={f.description} maxLength={200} rows={3} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <span className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void save()}>Save</button>
            <button type="button" className="btn" onClick={() => { setMode('view'); setF({ name: r.name, description: r.description }) }}>Cancel</button>
          </span>
        </span>
      ) : mode === 'delete' ? (
        <span className="role-edit">
          <span className="small" style={{ fontWeight: 600 }}>Delete {r.name}?</span>
          {r.members > 0 && <>
            <span className="small" style={{ fontWeight: 400 }}>Move its {r.members} {r.members === 1 ? 'person' : 'people'} to:</span>
            <select className="input" aria-label="Move people to" value={to} onChange={(e) => setTo(e.target.value)}>
              {roles.filter((x) => x.key !== r.key).map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </select>
          </>}
          <span className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>Delete</button>
            <button type="button" className="btn" onClick={() => setMode('view')}>Cancel</button>
          </span>
        </span>
      ) : (
        <span className="role-view">
          <span className="role-name">{r.name}</span>
          <span className="muted small" style={{ fontWeight: 400 }}>{r.members} {r.members === 1 ? 'person' : 'people'}{r.system ? ' · built in' : ''}</span>
          {r.description && <span className="muted small role-desc" style={{ fontWeight: 400 }}>{r.description}</span>}
          {editable && <span className="row" style={{ gap: 4 }}>
            <button type="button" className="link-btn small" onClick={() => setMode('edit')}>Edit</button>
            {!r.system && <><span className="muted">·</span><button type="button" className="link-btn small" onClick={() => setMode('delete')}>Delete</button></>}
          </span>}
        </span>
      )}
      {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
    </th>
  )
}

function RolesMatrix({ data: saved, editable, onSaved }: { data: RolesResponse; editable: boolean; onSaved: (r: RolesResponse) => void }) {
  const { error, setError, run } = useRun()
  // Ticks change at once; a failed save puts them back.
  const [data, setData] = useState(saved)
  useEffect(() => setData(saved), [saved])
  const groups = useMemo(() => {
    const out: { group: string; perms: RolesResponse['permissions'] }[] = []
    for (const p of data.permissions) {
      const g = out.find((x) => x.group === p.group)
      if (g) g.perms.push(p); else out.push({ group: p.group, perms: [p] })
    }
    return out
  }, [data.permissions])
  const toggle = (r: RoleDef, p: Permission, on: boolean) => {
    const perms = on ? [...r.permissions, p] : r.permissions.filter((x) => x !== p)
    setData((d) => ({ ...d, roles: d.roles.map((x) => (x.key === r.key ? { ...x, permissions: perms } : x)) }))
    void run(() => api<RolesResponse>(`/roles/${r.key}`, { method: 'PATCH', body: { permissions: perms } }),
      `${r.name}: ${data.permissions.find((x) => x.key === p)?.label} ${on ? 'allowed' : 'removed'}.`).then((x) => (x ? onSaved(x) : setData(saved)))
  }
  const tick = (on: boolean) => <span className={`perm-tick${on ? ' on' : ''}`} aria-label={on ? 'Allowed' : 'Not allowed'}>{on ? '✓' : '—'}</span>
  return (
    <>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="table-wrap">
        <table className="roles-matrix" style={{ minWidth: 260 + data.roles.length * 170 }}>
          <thead><tr><th scope="col" className="perm-col">What they can do</th>{data.roles.map((r) => <RoleHead key={r.key} r={r} roles={data.roles} editable={editable} onSaved={onSaved} />)}</tr></thead>
          <tbody>
            <tr><td className="perm-col"><strong>See the shared pipeline and work their own records</strong><br /><span className="muted small">Every account, prospect and deal is visible to all; people edit the ones they own.</span></td>
              {data.roles.map((r) => <td key={r.key} className="perm-cell">{tick(true)}</td>)}</tr>
            {groups.map((g) => (
              <Fragment key={g.group}>
                <tr className="perm-group"><td colSpan={data.roles.length + 1}>{g.group}</td></tr>
                {g.perms.map((p) => (
                  <tr key={p.key}>
                    <td className="perm-col"><strong>{p.label}</strong><br /><span className="muted small">{p.detail}</span></td>
                    {data.roles.map((r) => {
                      const on = r.permissions.includes(p.key)
                      return (
                        <td key={r.key} className="perm-cell">
                          {editable && r.key !== 'admin'
                            ? <label className="perm-check"><input type="checkbox" checked={on} aria-label={`${r.name}: ${p.label}`} onChange={(e) => toggle(r, p.key, e.target.checked)} /></label>
                            : tick(on)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <span className="muted small">Changes apply straight away, the next time each person loads a page. The Admin role always has everything, and there’s always at least one active person who can manage people.</span>
    </>
  )
}

// ── Tab ───────────────────────────────────────────────────────────────

export default function PeopleAccess() {
  const { user, refreshUsers } = useSession()
  const editable = can(user, 'manage_users')
  const people = useLoad(() => api<User[]>('/users'), [])
  const roles = useLoad(() => api<RolesResponse>('/roles'), [])
  const [rolesOverride, setRolesOverride] = useState<RolesResponse | null>(null)
  const roleData = rolesOverride || roles.data
  const [adding, setAdding] = useState(false)
  const [newRole, setNewRole] = useState(false)
  const [q, setQ] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  const refresh = () => { void people.reload(); void roles.reload().then(() => setRolesOverride(null)); void refreshUsers() }
  const list = (people.data || []).filter((u) =>
    (showInactive || u.active !== false) && (!roleFilter || u.role === roleFilter) &&
    (!q || `${u.name} ${u.email} ${u.title || ''}`.toLowerCase().includes(q.toLowerCase())))
  const counts = { active: 0, pending: 0, inactive: 0 }
  for (const u of people.data || []) counts[statusOf(u)] += 1

  return (
    <>
      <section className="card" aria-label="People">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2>People</h2>
            <span className="muted small">{counts.active} active · {counts.pending} not signed in yet{counts.inactive ? ` · ${counts.inactive} deactivated` : ''}</span>
          </div>
          {editable && !adding && <button type="button" className="btn btn-dark" onClick={() => setAdding(true)}>+ Add person</button>}
        </div>
        {!editable && <Banner kind="warn">You can see who has which access. Changing it needs the “Manage people and roles” permission.</Banner>}
        <ErrorBanner error={people.error || roles.error} />
        {adding && roleData && <AddPerson roles={roleData.roles} onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); refresh() }} />}
        <div className="row people-filters" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="input" type="search" placeholder="Search name, email or title" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 240px' }} />
          <select className="input" aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">All roles</option>
            {(roleData?.roles || []).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated</label>
        </div>
        <div className="table-wrap">
          <table style={{ minWidth: 820 }}>
            <thead><tr><th>Person</th><th>Job title</th><th>Role</th><th>Status</th><th className="acts-cell">{editable ? 'Actions' : ''}</th></tr></thead>
            <tbody>
              {roleData && list.map((u) => <PersonRow key={`${u.id}-${u.role}-${u.active}-${u.name}-${u.title}`} u={u} roles={roleData.roles} editable={editable} self={u.id === user.id} onChanged={refresh} />)}
            </tbody>
          </table>
          {people.data && list.length === 0 && <div className="empty">No one matches.</div>}
        </div>
        <span className="muted small">People sign in with their leadstrategus.com Google account. Anyone from the domain who signs in without being added here joins as a Salesperson.</span>
      </section>

      <section className="card" aria-label="Roles and access">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2>Roles &amp; access</h2>
            <span className="muted small">A role is a set of permissions. Give someone a role above; change what a role can do here.</span>
          </div>
          {editable && !newRole && <button type="button" className="btn btn-outline" onClick={() => setNewRole(true)}>+ New role</button>}
        </div>
        {newRole && roleData && <NewRole roles={roleData.roles} onCancel={() => setNewRole(false)} onSaved={(r) => { setNewRole(false); setRolesOverride(r) }} />}
        {roleData && <RolesMatrix data={roleData} editable={editable} onSaved={(r) => { setRolesOverride(r); void people.reload(); void refreshUsers() }} />}
      </section>
    </>
  )
}
