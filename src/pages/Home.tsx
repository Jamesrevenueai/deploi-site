import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { EarlyAccessForm } from '../components/EarlyAccessForm'
import { Cards, IntegrationStatusBadge, PageHero, Section, Steps } from '../components/Page'
import { CORE_HEADLINE, CORE_MESSAGE, CORE_SUBLINE, INTEGRATIONS, PRICING_LINE } from '../lib/site-config'

export const HOME_TITLE = `${BRAND} — ${CORE_HEADLINE} Deploi finds it, handles it, and shows you what got done.`
export const HOME_DESCRIPTION = `${CORE_MESSAGE} An AI team for small businesses: Deploi Office for follow-up and scheduling, Deploi Commerce for your store. Pilot program.`

/** The three things Deploi does, in the core message's order. */
export const PILLARS = [
  { title: 'Finds it', body: 'Deploi reads the tools you connect and lists real unfinished work: leads nobody followed up, meetings never booked, stock problems, supplier orders without a reply. Only what it actually found.' },
  { title: 'Handles it', body: 'An AI team works each problem with the permissions you grant. Every agent starts at drafts only; anything that sends, books or changes waits for your approval of the exact content.' },
  { title: 'Shows you what got done', body: 'Work counts as done only when Deploi checks the result again in the system it happened in. You see the evidence, not just a sent message.' },
]

export const PRODUCTS = [
  { key: 'office', name: 'Deploi Office', to: '/office', body: 'Lead follow-up, meeting scheduling and CRM notes for HubSpot and Google Calendar, with an agent mailbox.' },
  { key: 'commerce', name: 'Deploi Commerce', to: '/commerce', body: 'Store health, stock and supplier follow-up for Shopify and WooCommerce stores.' },
]

export const HOME_FLOW = [
  { title: 'Connect your tools', body: 'Your store, CRM, calendar or inbox, through each service’s official sign-in. Never a password typed into Deploi.' },
  { title: 'See the work Deploi found', body: 'A list of real problems in your data, and the team Deploi recommends for them.' },
  { title: 'Approve what matters', body: 'Every decision shows exactly what will be sent, booked or changed.' },
  { title: 'See what got done', body: 'Completed work with the evidence that confirmed it, and time saved clearly marked as an estimate.' },
]

export const HOME_FAQ = [
  { q: 'Is Deploi generally available?', a: 'Not yet. Deploi runs as a pilot with a small number of businesses. Integrations are marked Pilot or Planned on the Integrations page.' },
  { q: 'Can an agent act without me?', a: 'Only if you grant it, per kind of action and within limits you set. Every agent starts at drafts only, and one switch stops all of them.' },
  { q: 'What does it cost?', a: `${PRICING_LINE}.` },
  { q: 'Do you have customer results to show?', a: 'Not yet. We publish no customer quotes or results until pilot customers have verified outcomes they agree to share.' },
]

export function FAQ() {
  return (
    <dl className="faq">
      {HOME_FAQ.map(f => <div key={f.q} className="faq-item"><dt>{f.q}</dt><dd>{f.a}</dd></div>)}
    </dl>
  )
}

export default function Home() {
  useSeo({ title: HOME_TITLE, description: HOME_DESCRIPTION })
  return (
    <div className="page home-page">
      <PageHero eyebrow="An AI team for small businesses" title={<>{CORE_HEADLINE}<br /><span className="accent">{CORE_SUBLINE}</span></>}
        lead="Connect your tools. Deploi finds the follow-ups, bookings and fixes that are waiting, has its AI team handle them within the permissions you grant, and shows you what was actually done.">
        <CtaButton />
        <Link to="/how-it-works" className="btn btn-ghost">How it works</Link>
      </PageHero>

      <Section id="what" title="What Deploi does">
        <Cards items={PILLARS} />
      </Section>

      <Section id="products" title="Two suites, one team" tone="alt">
        <ul className="cards cols-2">
          {PRODUCTS.map(p => (
            <li key={p.key} className="card" data-product={p.key}>
              <div className="card-tag"><span className="status status-pilot"><span className="status-dot" aria-hidden="true" />Pilot</span></div>
              <h3>{p.name}</h3>
              <p>{p.body}</p>
              <Link to={p.to} className="card-link">About {p.name} →</Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="how" title="How it works" lead={<><Link to="/how-it-works">The full walk-through</Link> covers permissions, approvals and verification.</>}>
        <Steps steps={HOME_FLOW} />
      </Section>

      <Section id="integrations" title="Integrations, with honest status" lead={<>Nothing is marked Available until a live workflow has been tested against the real service. <Link to="/integrations">All integrations</Link>.</>} tone="alt">
        <ul className="chips" aria-label="Integrations">
          {INTEGRATIONS.map(i => <li key={i.key} className="chip"><span>{i.name}</span><IntegrationStatusBadge i={i} /></li>)}
        </ul>
      </Section>

      <Section id="pricing" title="Pricing">
        <p className="pricing-line">{PRICING_LINE}.</p>
        <p className="muted"><Link to="/pricing">See what each plan includes</Link>.</p>
      </Section>

      <Section id="faq" title="Questions" tone="alt">
        <FAQ />
      </Section>

      <Section id="early-access" title="Apply for a paid pilot" lead="Tell us about your business. We reply by email; you approve any charge before it applies.">
        <EarlyAccessForm />
      </Section>
    </div>
  )
}
