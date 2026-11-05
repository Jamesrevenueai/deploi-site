import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { IntegrationStatusBadge, PageHero, Section } from '../components/Page'
import { INTEGRATIONS, LIVE_VERIFIED, STATUS_WORDS, shownStatus, type IntegrationStatus } from '../lib/site-config'

const ORDER: IntegrationStatus[] = ['available', 'pilot', 'planned']

export default function Integrations() {
  useSeo({ title: `Integrations — ${BRAND}`, description: 'Every integration with its honest status: Available, Pilot or Planned.' })
  return (
    <div className="page">
      <PageHero eyebrow="Integrations" title="What Deploi connects to, and how far along each one is." lead="Nothing is called Available until a live workflow has been tested against the real service. Integrations are not partnerships." />
      <Section>
        <dl className="status-legend">
          {ORDER.map(s => <div key={s}><dt><span className={`status status-${s}`}><span className="status-dot" aria-hidden="true" />{STATUS_WORDS[s].label}</span></dt><dd>{STATUS_WORDS[s].meaning}{s === 'available' && LIVE_VERIFIED.length === 0 ? ' None yet.' : ''}</dd></div>)}
        </dl>
        <div className="table-wrap">
          <table className="int-table">
            <caption className="sr-only">Integrations and their status</caption>
            <thead><tr><th scope="col">Integration</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">What Deploi uses it for</th></tr></thead>
            <tbody>
              {[...INTEGRATIONS].sort((a, b) => ORDER.indexOf(shownStatus(a)) - ORDER.indexOf(shownStatus(b))).map(i => (
                <tr key={i.key} data-integration={i.key}><th scope="row">{i.name}</th><td>{i.group}</td><td><IntegrationStatusBadge i={i} /></td><td>{i.use}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}
