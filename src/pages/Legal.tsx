import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'

type LegalKind = 'terms' | 'privacy'
type LegalSection = { title: string; body: ReactNode }

const LEGAL_UPDATED = 'September 22, 2026'

const TERMS: LegalSection[] = [
  {
    title: 'Who we are',
    body: <>{BRAND} is a trade name operated by <span className="placeholder">[LEGAL ENTITY NAME]</span>, LLC, an Ohio limited liability company (d/b/a {BRAND}). By using this website or our services, you agree to these Terms.</>,
  },
  {
    title: 'What we do',
    body: <>We provide AI <strong>consulting, training and implementation</strong>. We do not provide legal, tax or compliance advice. We are a service provider; we are not the maker of the underlying AI models.</>,
  },
  {
    title: 'No guarantees',
    body: <>AI is probabilistic and can make mistakes. Any savings figures we publish or discuss are <strong>estimates only</strong> and are not a guarantee of results. Our services are provided <strong>"as is"</strong>, except for the refund commitments listed below.</>,
  },
  {
    title: 'Refunds',
    body: <>The AI Audit is <strong>fully refundable before the discovery session</strong>. After the discovery session, the <strong>5-Hour Guarantee</strong> applies: if your written audit report does not find at least 5 hours a week of work AI can take off your plate, you get a full refund. The Founding Cohort Course is fully refundable <strong>before session 2</strong>. Managed subscription plans, when available, are billed monthly in advance and are not refundable except where required by law; you can cancel at any time with 30 days' notice.</>,
  },
  {
    title: 'Fees',
    body: <>Fixed-price engagements are billed on booking. Managed plans are billed monthly in advance. Setup fees, where applicable, are billed once. We may change pricing on 30 days' notice for ongoing services.</>,
  },
  {
    title: 'Your responsibilities',
    body: <>You agree to provide accurate information and any access we need to deliver the service, keep your use lawful, and comply with the terms of any third-party tools we connect on your behalf.</>,
  },
  {
    title: 'Your accounts, your data',
    body: <>Anything we build for you is set up <strong>inside your own accounts</strong> — you own your accounts, your data, and your configurations. We access your data only to deliver the service, keep it confidential, do not sell it, and do not use it to train public models without your consent. Personal data is covered by a separate Data Processing Agreement. We do not handle patient health information.</>,
  },
  {
    title: 'Intellectual property',
    body: <>The configurations, prompts, and workflows we build for you are licensed to you. Our own tooling, methods, and know-how remain ours.</>,
  },
  {
    title: 'Limitation of liability',
    body: <>Our total liability to you is capped at the <strong>fees you paid us in the three months preceding the claim</strong>. We are not liable for indirect, incidental, consequential, or special damages.</>,
  },
  {
    title: 'Term and termination',
    body: <>Either party may terminate the ongoing service on 30 days' written notice. We may suspend service for non-payment or misuse. On termination, we will return or delete your data on request.</>,
  },
  {
    title: 'Governing law',
    body: <>These Terms are governed by the laws of the State of Ohio. Any disputes will be resolved in the state or federal courts located in Franklin County, Ohio.</>,
  },
  {
    title: 'Changes',
    body: <>We may update these Terms. Material changes will be posted here with a new "Last updated" date. Continued use of the service after changes are posted means you accept the updated Terms.</>,
  },
  {
    title: 'Contact',
    body: <>Questions about these Terms? Email <span className="placeholder">[CONTACT EMAIL]</span>.</>,
  },
]

const PRIVACY: LegalSection[] = [
  {
    title: 'What we collect',
    body: <>Information you give us (name, business, work email, and details you submit through forms). Basic website usage and analytics data. When you become a client, the business data we need to run your AI setup.</>,
  },
  {
    title: 'How we use it',
    body: <>To respond to you, provide and improve the service, deliver the audit / course / setup you signed up for, and send you updates you opted into. <strong>We do not sell personal information.</strong></>,
  },
  {
    title: 'Client business data',
    body: <>Client data is confidential and processed only to deliver the service. Everything we build lives inside your own accounts, so your data stays with you. Personal data is covered by a separate Data Processing Agreement. We do not handle patient health information.</>,
  },
  {
    title: 'Sharing',
    body: <>We share information only with service providers who help us operate (for example, email delivery, hosting, payment processing) under confidentiality obligations, or where required by law.</>,
  },
  {
    title: 'Security',
    body: <>We use reasonable administrative, technical, and physical safeguards to protect information. No system is perfectly secure.</>,
  },
  {
    title: 'Your choices',
    body: <>You can unsubscribe from marketing emails at any time, and you can request access to or deletion of your information.</>,
  },
  {
    title: 'Cookies',
    body: <>We use basic cookies and analytics to understand how the site is used. You can control cookies through your browser settings.</>,
  },
  {
    title: 'Contact',
    body: <>Questions about this Privacy Policy? Email <span className="placeholder">[CONTACT EMAIL]</span>.</>,
  },
]

type Props = { kind: LegalKind }

export default function Legal({ kind }: Props) {
  const title = kind === 'terms' ? 'Terms of Service' : 'Privacy Policy'
  const sections = kind === 'terms' ? TERMS : PRIVACY

  useSeo({
    title: `${title} — ${BRAND}`,
    description:
      kind === 'terms'
        ? `${BRAND} Terms of Service — the plain-English rules for using our website and services.`
        : `${BRAND} Privacy Policy — what we collect, how we use it, and how we keep client data safe.`,
  })

  return (
    <main className="legal">
      <div className="container-narrow">
        <Link to="/" className="back">← Back to {BRAND}</Link>
        <div className="legal-draft" role="status">Draft &mdash; pending legal review.</div>
        <h1>{title}</h1>
        <div className="legal-meta">Last updated: {LEGAL_UPDATED}</div>
        <ol className="legal-sections">
          {sections.map((s, i) => (
            <li key={s.title} className="legal-section">
              <div className="legal-num">{String(i + 1).padStart(2, '0')}</div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </main>
  )
}
