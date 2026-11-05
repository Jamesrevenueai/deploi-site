import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { PageHero, Section, Steps, Cards } from '../components/Page'

export const HOW_STEPS = [
  { title: 'Connect', body: 'Connect your store, CRM, calendar or inbox through each service’s official sign-in. Connecting a tool lets no agent act.' },
  { title: 'Discover', body: 'Deploi reads what you connected and lists real problems it found, each with the evidence it read.' },
  { title: 'Set up your team', body: 'Deploi recommends the agents for what it found. They start at drafts only.' },
  { title: 'Approve', body: 'Each decision shows exactly what will be sent, booked or changed. Approve, reject, or grant an agent limited autonomy.' },
  { title: 'Handle', body: 'Agents work each case: drafting, sending what you approved, waiting for replies, checking back on schedule.' },
  { title: 'Verify', body: 'A case closes as resolved only when a fresh read of the source confirms the outcome. A sent message is not a result.' },
  { title: 'Report', body: 'Completed Work and Business Insights show what got done, with evidence. Time saved is always labelled as an estimate.' },
]

export default function HowItWorks() {
  useSeo({ title: `How it works — ${BRAND}`, description: 'Connect, discover, set up your team, approve, handle, verify and report.' })
  return (
    <div className="page">
      <PageHero eyebrow="How it works" title="From unfinished work to verified results." lead="Every problem Deploi finds becomes one case, carried from discovery to a verified outcome, with every step on the record." />
      <Section><Steps steps={HOW_STEPS} /></Section>
      <Section title="Rules Deploi always follows" tone="alt">
        <Cards items={[
          { title: 'Only what you grant', body: 'Agents act within their own permissions. Handing work to another agent never widens what it may do.' },
          { title: 'Exact approvals', body: 'An approval covers the exact content you saw. If it changes, it needs your approval again.' },
          { title: 'Stop everything', body: 'One switch stops every agent at once.' },
        ]} />
        <div className="hero-actions"><CtaButton /></div>
      </Section>
    </div>
  )
}
