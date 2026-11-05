// Data management: import, duplicates and cleanup in one place (CRM review
// §4.1 / §6), instead of separate top-level destinations.
import { useSearchParams } from 'react-router-dom'
import Duplicates from '../components/Duplicates'
import { Tabs } from '../ui'
import CsvImport from './CsvImport'
import Import from './Import'
import { RuleBreaks } from './Cleanup'

type Tab = 'import' | 'hubspot' | 'duplicates' | 'cleanup'
const TABS: { value: Tab; label: string; desc: string }[] = [
  { value: 'import', label: 'Import CSV', desc: 'Bring companies, contacts or deals in from a spreadsheet; map columns and review every row before saving.' },
  { value: 'hubspot', label: 'HubSpot import', desc: 'Re-runnable import of owners, companies, contacts, deals and activity from HubSpot.' },
  { value: 'duplicates', label: 'Duplicates', desc: 'Companies and contacts that look like the same organisation or person: compare and merge.' },
  { value: 'cleanup', label: 'Needs cleanup', desc: 'Imported records that break a CRM rule: open each, fix what is listed and save.' },
]

export default function DataManagement() {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value) || 'import'
  return (
    <>
      <div className="page-head">
        <div><h1>Data management</h1><p>{TABS.find((t) => t.value === tab)?.desc}</p></div>
      </div>
      <Tabs<Tab> label="Data management" value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} tabs={TABS.map(({ value, label }) => ({ value, label }))} />
      {tab === 'import' && <CsvImport embedded />}
      {tab === 'hubspot' && <Import embedded />}
      {tab === 'duplicates' && <Duplicates />}
      {tab === 'cleanup' && <RuleBreaks />}
    </>
  )
}
