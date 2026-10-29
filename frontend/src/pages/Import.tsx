// Import from HubSpot: connect → choose objects → map stages & fields →
// data-quality check → import. The importer itself is Phase 3; this screen
// sets up the choices and is explicit that nothing has been imported yet.
import { useState } from 'react'
import { useSession } from '../session'
import { Banner, SelectField } from '../ui'

const STEPS = ['Connect', 'Choose objects', 'Map stages & fields', 'Data quality', 'Import']

const OBJECTS: [string, string, string, string][] = [
  ['co', 'Companies', 'Accounts', 'Name, domain, country, industry, owner. Duplicates merged by domain.'],
  ['ct', 'Contacts', 'Prospects / contacts', 'Linked to accounts; contacts without a company stay unlinked.'],
  ['dl', 'Deals', 'Opportunities', 'All pipelines, open and closed, with amount and close date.'],
  ['as', 'Associations', 'Record links', 'Contact ↔ company ↔ deal.'],
  ['ac', 'Notes, calls, meetings, tasks', 'Activity history', 'Kept on the timeline; open tasks become next actions where they map.'],
  ['em', 'Logged emails', 'Activity history (minimal)', 'Subject, date and participants only; bodies are not stored.'],
  ['ow', 'Owners', 'Users', 'Matched by work email.'],
]

const DEFAULT_STAGE_MAP: Record<string, string> = {
  appointmentscheduled: 'Discovery / scoping', qualifiedtobuy: 'Qualified', presentationscheduled: 'Solution design',
  decisionmakerboughtin: 'Negotiation', contractsent: 'Verbal commitment', closedwon: 'Won', closedlost: 'Lost',
}
const LEAD_STATUS: [string, string][] = [
  ['NEW', 'New'], ['ATTEMPTED_TO_CONTACT', 'Contacted'], ['CONNECTED / IN_PROGRESS', 'Engaged'],
  ['OPEN_DEAL', 'Qualified'], ['BAD_TIMING', 'Nurture'], ['UNQUALIFIED', 'Disqualified'],
]
const FIELDS: [string, string][] = [
  ['dealname', 'Opportunity name'], ['amount', 'Estimated deal value'], ['deal_currency_code', 'Currency'],
  ['closedate', 'Expected close / won / lost date'], ['hubspot_owner_id', 'Owner'], ['closed_lost_reason', 'Lost reason (mapped to list)'],
  ['hs_object_id', 'HubSpot ID (kept for re-sync)'],
]
const QUALITY: [string, string, 'amber' | 'red'][] = [
  ['Open deals with no next step', 'Imported with next action “Review” due on import day, for the owner to set properly', 'amber'],
  ['Qualified+ deals with no amount', 'Flagged: estimated value required from Qualified', 'amber'],
  ['Closed-won deals with no amount', 'Flagged: actual contract value required', 'red'],
  ['Closed-lost deals with no reason', 'Lost reason set to “Not recorded (imported)”', 'amber'],
  ['Possible duplicate companies', 'Same domain or near-identical name: merge suggestions shown', 'red'],
  ['Risk rating', 'HubSpot has none: imported as Unassessed; Qualified+ deals flagged for review', 'amber'],
]

export default function Import() {
  const { lists, user } = useSession()
  const [step, setStep] = useState(0)
  const [off, setOff] = useState<Record<string, boolean>>({})
  const [stageMap, setStageMap] = useState(DEFAULT_STAGE_MAP)
  const admin = user.role === 'admin'

  const next = (label: string) => (
    <div className="row"><button type="button" className="btn btn-dark" onClick={() => setStep(step + 1)}>{label}</button></div>
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import from HubSpot</h1>
          <p>Bring companies, contacts, deals and activity history into Accounts, Prospects and Opportunities. Every record keeps its HubSpot ID, so the import can be re-run during the pilot.</p>
        </div>
      </div>
      <Banner kind="warn">The importer isn’t connected yet (Phase 3). You can review and adjust the plan below; nothing is read from HubSpot or written to the CRM from this screen.</Banner>
      {!admin && <Banner kind="warn">Only admins can run the import.</Banner>}

      <nav className="steps" aria-label="Import steps">
        {STEPS.map((label, i) => (
          <button key={label} type="button" aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : undefined} onClick={() => setStep(i)}>
            <span className="mono">{i < step ? '✓' : i + 1}</span> {label}
          </button>
        ))}
      </nav>

      {step === 0 && (
        <section className="card strong" aria-label="Connect HubSpot">
          <h2>Connect HubSpot (read-only)</h2>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li>In HubSpot: <strong>Settings › Integrations › Private apps › Create a private app</strong>.</li>
            <li>Give it read-only CRM scopes: <span className="mono">crm.objects.companies.read</span>, <span className="mono">crm.objects.contacts.read</span>, <span className="mono">crm.objects.deals.read</span>, <span className="mono">crm.objects.owners.read</span>, plus read access for notes, calls, meetings, tasks and emails.</li>
            <li>Copy the access token and add it on Render as the <span className="mono">CRM_HUBSPOT_TOKEN</span> environment variable of the API service.</li>
          </ol>
          <p className="muted small" style={{ margin: 0 }}>The token stays on the server and is never pasted into the browser or into chat. It can be revoked in HubSpot at any time. Private apps are available on every HubSpot plan at no extra cost.</p>
          <div className="row">
            <button type="button" className="btn btn-dark" disabled title="Available once the importer is deployed">Test connection</button>
            <button type="button" className="btn" onClick={() => setStep(1)}>Review the plan</button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="card" aria-label="Choose what to bring over">
          <h2>Choose what to bring over</h2>
          <div>
            {OBJECTS.map(([id, from, to, help]) => (
              <label className="list-row check" key={id} style={{ justifyContent: 'flex-start' }}>
                <input type="checkbox" checked={!off[id]} onChange={() => setOff({ ...off, [id]: !off[id] })} />
                <span><strong>{from} → {to}</strong><br /><span className="muted small">{help}</span></span>
              </label>
            ))}
          </div>
          <p className="muted small" style={{ margin: 0 }}>Out of scope, so not imported: marketing emails, workflows, sequences, forms and landing pages (spec §1). Counts appear once HubSpot is connected.</p>
          {next('Continue to mapping')}
        </section>
      )}

      {step === 2 && (
        <div className="cols">
          <section className="card col-main" aria-label="Deal stage mapping">
            <h2>HubSpot deal stage → opportunity stage</h2>
            <div className="grid-fields">
              {Object.entries(stageMap).map(([hs, to]) => (
                <SelectField key={hs} label={hs} value={to} onChange={(v) => setStageMap({ ...stageMap, [hs]: v || to })}
                  options={lists.stages.map((s) => ({ value: s.name, label: `${s.name} · ${s.probability}%` }))} />
              ))}
            </div>
            <span className="muted small">These are HubSpot’s default pipeline stages. Custom pipelines and stages are listed here after connecting.</span>
          </section>
          <section className="card col-side" aria-label="Status and field mapping">
            <h2>Lead status → prospect status</h2>
            <div>{LEAD_STATUS.map(([hs, to]) => <div className="list-row" key={hs}><span className="mono small">{hs}</span><span>→ {to}</span></div>)}</div>
            <h2>Fields</h2>
            <div>{FIELDS.map(([hs, to]) => <div className="list-row" key={hs}><span className="mono small">{hs}</span><span className="small">{to}</span></div>)}</div>
          </section>
          <div style={{ flexBasis: '100%' }}>{next('Check data quality')}</div>
        </div>
      )}

      {step === 3 && (
        <section className="card" aria-label="Data quality">
          <h2>Data quality check before import</h2>
          <p className="muted" style={{ margin: 0 }}>Records that break the CRM’s rules are still imported, but they land in a “Needs cleanup” view for their owner instead of being dropped or silently fixed.</p>
          <div>
            {QUALITY.map(([rule, fix, tone]) => (
              <div className="list-row" key={rule}>
                <span style={{ flex: '1 1 320px' }}><strong>{rule}</strong><br /><span className="muted small">{fix}</span></span>
                <span className={`pill pill-${tone}`}>Counted after connecting</span>
              </div>
            ))}
          </div>
          {next('Review import')}
        </section>
      )}

      {step === 4 && (
        <section className="card strong" aria-label="Import">
          <h2>Ready when the importer is deployed</h2>
          <p className="muted" style={{ margin: 0 }}>
            Bringing over: {OBJECTS.filter(([id]) => !off[id]).map(([, from]) => from).join(', ') || 'nothing selected'}.
          </p>
          <p className="muted small" style={{ margin: 0 }}>The import runs in order (owners, accounts, contacts, deals, links, activity), keeps every HubSpot ID so it can be re-run nightly during the pilot without duplicates, and produces a downloadable error log.</p>
          <div className="row">
            <button type="button" className="btn btn-dark" disabled title="Available once the importer is deployed">Start import</button>
            <span className="muted small">Not connected yet · Phase 3</span>
          </div>
        </section>
      )}
    </>
  )
}
