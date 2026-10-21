import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { env } from '../lib/env'
import { useSeo } from '../hooks/useSeo'

type LegalKind = 'terms' | 'privacy'
type LegalSection = { title: string; body: ReactNode }

const LEGAL_UPDATED = 'October 20, 2026'

export function termsSections(entity: string): LegalSection[] {
  return [
    {
      title: 'Who we are',
      body: <>{BRAND} is a trade name operated by <strong>{entity}</strong>, an Ohio limited liability company (d/b/a {BRAND}). By using this website or our services, you agree to these Terms.</>,
    },
    {
      title: 'What we do',
      body: <>We provide <strong>operations consulting, software implementation and managed services</strong> to small healthcare practices, including home care and disability-services agencies. We do not provide legal, tax, billing-compliance or clinical advice. We are a service provider; we are not the maker of the underlying AI models or of your scheduling or EVV systems.</>,
    },
    {
      title: 'No guarantees',
      body: <>AI is probabilistic and can make mistakes. Any savings figures we publish or discuss are <strong>estimates only</strong> and are not a guarantee of results. Our services are provided <strong>"as is"</strong>, except for the refund commitments listed below.</>,
    },
    {
      title: 'Refunds',
      body: <>The Operations Assessment is <strong>fully refundable before the first working session</strong>; after that it is non-refundable but is credited in full toward a build if you proceed within 60 days. Build projects are quoted as fixed fees and invoiced per the signed statement of work. The monthly retainer has a three-month minimum, is billed monthly in advance, and is not refundable except where required by law; after the minimum you can cancel at any time with 30 days' notice.</>,
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
      body: <>Anything we build for you is set up <strong>inside your own accounts</strong>. You own your accounts, your data, and your configurations. We access your data only to deliver the service, keep it confidential, do not sell it, and do not use it to train public models. Protected health information is handled only under a signed <Link to="/baa">Business Associate Agreement</Link>.</>,
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
      body: <>Questions about these Terms? Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</>,
    },
  ]
}

const PRIVACY: LegalSection[] = [
  {
    title: 'What we collect',
    body: <>Information you give us (name, business, work email, and details you submit through forms). Basic website usage and analytics data. When you become a client, the business data we need to run your setup.</>,
  },
  {
    title: 'How we use it',
    body: <>To respond to you, provide and improve the service, deliver the assessment, build or retainer you signed up for, and send you updates you opted into. <strong>We do not sell personal information.</strong></>,
  },
  {
    title: 'Client business data',
    body: <>Client data is confidential and processed only to deliver the service. Everything we build lives inside your own accounts, so your data stays with you. Protected health information is handled only under a signed <Link to="/baa">Business Associate Agreement</Link>. Every change is logged, and reads of client records are logged on the dashboard, report and action pages.</>,
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
    body: <>Questions about this Privacy Policy? Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</>,
  },
]

type Props = { kind: LegalKind }

export default function Legal({ kind }: Props) {
  const title = kind === 'terms' ? 'Terms of Service' : 'Privacy Policy'
  const sections = kind === 'terms' ? termsSections(env.legalEntity) : PRIVACY

  useSeo({
    title: `${title} — ${BRAND}`,
    description:
      kind === 'terms'
        ? `${BRAND} Terms of Service: the plain-English rules for using our website and services.`
        : `${BRAND} Privacy Policy: what we collect, how we use it, and how we keep client data safe.`,
  })

  return (
    <div className="page">
      <div className="container-narrow">
        <Link to="/" className="back">← Back to {BRAND}</Link>
        {!env.legalReviewed && <div className="draft-badge" role="status">Draft — pending legal review</div>}
        <h1>{title}</h1>
        <div className="legal-meta">Last updated: {LEGAL_UPDATED}</div>
        <ol className="legal-sections">
          {sections.map((s, i) => (
            <li key={s.title} className="legal-section">
              <div className="legal-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
