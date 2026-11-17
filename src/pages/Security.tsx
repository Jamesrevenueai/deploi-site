import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { PageHero, Section } from '../components/Page'

/** What is implemented today. Each line describes a control that exists in the product; nothing here is a certification. */
export const SECURITY_CONTROLS = [
  { title: 'Drafts only by default', body: 'Every agent starts unable to send, book or change anything. You grant more per kind of action, and can revoke it.' },
  { title: 'Exact-content approvals', body: 'An approval is bound to a hash of the exact content you saw; if it changes, it needs approving again.' },
  { title: 'Stop all agents', body: 'One switch pauses every agent in your business, cancels queued changes and holds unsent email.' },
  { title: 'Separated by organization', body: 'Each business’s data is isolated at the database level with row-level security; one business cannot read another’s.' },
  { title: 'Credentials encrypted at rest', body: 'Access tokens for connected services are encrypted and never shown in the browser.' },
  { title: 'Official sign-in only', body: 'Services connect through their official authorization flows. Deploi never asks for your passwords.' },
  { title: 'Audit trail', body: 'Every change, approval and agent action is recorded with who did it and when.' },
  { title: 'Browser protections', body: 'A strict content security policy, request-origin checks on every change and rate limits on the API.' },
]

export default function Security() {
  useSeo({ title: `Security — ${BRAND}`, description: 'The controls that exist in Deploi today. No certifications are claimed.' })
  return (
    <div className="page">
      <PageHero eyebrow="Security" title="What protects your business today." lead="This page lists only controls that are built and running. It is not a certification." />
      <Section>
        <ul className="cards cols-2">{SECURITY_CONTROLS.map(c => <li key={c.title} className="card"><h3>{c.title}</h3><p>{c.body}</p></li>)}</ul>
      </Section>
      <Section title="Certifications" tone="alt">
        <p className="lead" data-testid="no-certifications">{BRAND} holds no security certifications or third-party audit reports today, such as SOC 2 or ISO 27001. We will say so here if that changes.</p>
        <p className="muted pt">Found a security problem? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
      </Section>
    </div>
  )
}
