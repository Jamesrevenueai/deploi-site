import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { AgentCharacter } from '../components/AgentCharacter'
import { Cards, PageHero, Section } from '../components/Page'
import { AGENTS } from '../lib/library'

export const AGENTS_TITLE = `Agent capabilities — ${BRAND}`
export const AGENTS_DESCRIPTION = 'What Deploi’s agents can do for your office and your store, and what each one needs your approval for.'

/** The Office agent templates the app creates (deploi-app/lib/office/templates.ts). */
export const OFFICE_AGENTS = [
  { title: 'Lead Follow-up', body: 'Writes a new HubSpot lead a short first email, then follows up in the same thread until they reply. Stops on reply or opt-out.', tag: 'Deploi Office' },
  { title: 'Meeting Scheduler', body: 'Finds free times in your Google Calendar, proposes them, and books the one the lead picks.', tag: 'Deploi Office' },
  { title: 'CRM Updater', body: 'Logs emails and meetings as notes in HubSpot, and moves stages only by the rules you set.', tag: 'Deploi Office' },
  { title: 'Customer Reply', body: 'Sorts incoming replies and drafts an answer. Sends only what your permission allows.', tag: 'Deploi Office' },
]

export default function Agents() {
  useSeo({ title: AGENTS_TITLE, description: AGENTS_DESCRIPTION })
  return (
    <div className="page agents-page">
      <PageHero eyebrow="Agent capabilities" title="Each agent has one job, and only the permissions you give it." lead="Every agent starts at drafts only: it reads, drafts what it would do, and waits for you. You can allow it to act on its own per kind of action, within limits. Money actions and live publishing always wait for your approval.">
        <CtaButton />
      </PageHero>
      <Section title="Deploi Office agents"><Cards items={OFFICE_AGENTS} cols={4} /></Section>
      <Section title="Deploi Commerce agents" tone="alt" lead="The agent library for stores. Pilot: tested on a synthetic store, not yet in the Shopify App Store.">
        <ul className="agent-grid" aria-label="Agents">
          {AGENTS.map(a => (
            <li key={a.key} className="agent-card" data-agent={a.key}>
              <div className="agent-card-head">
                <AgentCharacter agentKey={a.key} hue={a.character.hue} shape={a.character.shape} label={`${a.name} character`} />
                <div>
                  <h3>{a.name}</h3>
                  <p className="agent-tag">{a.tagline}</p>
                </div>
              </div>
              <p className="agent-body">{a.description}</p>
              <div className="agent-example"><span className="agent-label">Example task</span><p>&ldquo;{a.exampleTask}&rdquo;</p></div>
              <div className="agent-foot"><span className="agent-status">{a.actionTypes.some(t => t.writes) ? 'Changes wait for your approval' : 'Reads and drafts only'}</span></div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
