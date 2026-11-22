import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { Cards, IntegrationStatusBadge, PageHero, Section } from '../components/Page'
import { INTEGRATIONS } from '../lib/site-config'

export const OFFICE_WORK = [
  { title: 'Lead follow-up', body: 'Finds leads in HubSpot nobody followed up, drafts the follow-up, and records the outcome in the CRM once it is confirmed there.' },
  { title: 'Meeting scheduling', body: 'Offers free times from your Google Calendar and books the meeting you approve. A meeting counts as booked when it is on the calendar.' },
  { title: 'CRM notes', body: 'Writes the note or stage change you allow, then reads the CRM again to confirm it landed.' },
  { title: 'Unanswered email', body: 'Lists messages in the agent mailbox that are waiting on a reply, so nothing sits unanswered.' },
]

export default function Office() {
  useSeo({ title: `Deploi Office — ${BRAND}`, description: 'Lead follow-up, scheduling and CRM notes handled by an AI team, within the permissions you grant. Pilot.' })
  const tools = INTEGRATIONS.filter(i => ['hubspot', 'google_calendar', 'deploi_email', 'quickbooks', 'outlook', 'gmail', 'pipedrive', 'salesforce'].includes(i.key))
  return (
    <div className="page">
      <PageHero eyebrow="Deploi Office · Pilot" title="The follow-ups and bookings that slip, handled." lead="Deploi Office finds the office work your team never gets to and handles it: following up leads, booking meetings and keeping the CRM current. You approve what goes out.">
        <CtaButton />
      </PageHero>
      <Section title="What it handles"><Cards items={OFFICE_WORK} cols={2} /></Section>
      <Section title="Works with" tone="alt" lead="Status as of today. Pilot means tested against test accounts and set up with you.">
        <ul className="chips">{tools.map(i => <li key={i.key} className="chip"><span>{i.name}</span><IntegrationStatusBadge i={i} /></li>)}</ul>
      </Section>
      <Section title="What you stay in control of">
        <Cards items={[
          { title: 'Drafts first', body: 'Every Office agent starts at drafts only. Sending email or booking needs your approval of that exact message or event.' },
          { title: 'Limits', body: 'When you allow an agent to send on its own, you set who it may write to and how often.' },
          { title: 'A record of everything', body: 'Each case shows what was found, what was done, and how the result was checked.' },
        ]} />
      </Section>
    </div>
  )
}
