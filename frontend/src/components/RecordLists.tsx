// Static lists of records ("add to a list"): a shared, named set of companies,
// contacts or deals. Tables use a list as a filter; Bulk actions add to one.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { SelectField } from '../ui'
import type { BulkEntity } from './Bulk'

export interface RecordList { id: string; entity: BulkEntity; name: string; owner_id: string | null; owner_name: string | null; size: number; record_ids: string[] }

export function useRecordLists(entity: BulkEntity) {
  const [items, setItems] = useState<RecordList[]>([])
  const reload = useCallback(async () => {
    try { setItems(await api<RecordList[]>('/record-lists', { params: { entity } })) } catch { setItems([]) }
  }, [entity])
  useEffect(() => {
    void reload()
    const on = () => void reload()
    window.addEventListener('record-lists-changed', on)
    return () => window.removeEventListener('record-lists-changed', on)
  }, [reload])
  const create = async (name: string) => api<RecordList>('/record-lists', { method: 'POST', body: { entity, name } })
  return { items, reload, create }
}

/** A "List" filter for a table, with remove for the person who made it (or managers). */
export function ListFilter({ entity, value, onChange }: { entity: BulkEntity; value: string | null; onChange: (id: string | null, ids: Set<string> | null) => void }) {
  const { user } = useSession()
  const lists = useRecordLists(entity)
  const current = lists.items.find((l) => l.id === value)
  useEffect(() => { onChange(value, current ? new Set(current.record_ids) : null) }, [current?.id, current?.size]) // eslint-disable-line react-hooks/exhaustive-deps
  const canDelete = current && (current.owner_id === user?.id || user?.permissions?.includes('edit_all'))
  return (
    <div className="row" style={{ gap: 6, alignItems: 'flex-end', flexWrap: 'nowrap' }}>
      <div style={{ width: 220 }}>
        <SelectField label="List" value={value} placeholder={lists.items.length ? 'Any list' : 'No lists yet'}
          onChange={(v) => { const l = lists.items.find((x) => x.id === v); onChange(v, l ? new Set(l.record_ids) : null) }}
          options={lists.items.map((l) => ({ value: l.id, label: `${l.name} (${l.size})` }))} />
      </div>
      {canDelete && <button type="button" className="btn" title={`Delete the list “${current!.name}” (the records stay)`}
        onClick={() => { if (confirm(`Delete the list “${current!.name}”? The records themselves are not touched.`)) void api(`/record-lists/${current!.id}`, { method: 'DELETE' }).then(() => { onChange(null, null); void lists.reload() }) }}>Delete list</button>}
    </div>
  )
}
