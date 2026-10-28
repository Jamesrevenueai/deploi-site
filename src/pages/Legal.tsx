import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { env } from '../lib/env'
import { useSeo } from '../hooks/useSeo'

type LegalKind = 'terms' | 'privacy'
type LegalSection = { title: string; body: ReactNode }

const LEGAL_UPDATED = 'October 28, 2026'

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>

export function termsSections(entity: string): LegalSection[] {
  return [
    {
      title: 'Who we are',
      body: <>{BRAND} is a trade name operated by <strong>{entity}</strong>, an Ohio limited liability company (d/b/a {BRAND}). By using this website or the {BRAND} app, you agree to these Terms.</>,
    },
    {
      title: 'What Deploi AI is',
      body: <>{BRAND} is subscription software that finds supported stock and listing problems in an online store, shows the evidence, proposes a fix, makes the change you approve through the platform&rsquo;s official API, and re-reads the store to confirm the change took effect. The Shopify version is in <strong>early access</strong>. WooCommerce and Amazon Seller Central integrations are planned and are not available yet. We do not provide legal, tax or accounting advice.</>,
    },
    {
      title: 'Early access',
      body: <>Early access is limited and may change. Features may be added, changed or removed, and the service may contain errors or be unavailable at times. During early access the service is provided <strong>&ldquo;as is&rdquo;</strong>, without warranties of any kind, to the extent the law allows. We may end early access for any account with reasonable notice.</>,
    },
    {
      title: 'Your approval and your store',
      body: <>{BRAND} changes your store only after you approve the exact change it proposes. You decide what to approve and remain responsible for your store, your products, your stock counts and what you sell. Verification confirms that the setting we changed reads back as expected; it does not confirm physical stock.</>,
    },
    {
      title: 'Fees',
      body: <>{BRAND} will be offered as a subscription. Pricing will be published before general availability. You will see the price and agree to it before any charge applies.</>,
    },
    {
      title: 'Your responsibilities',
      body: <>You agree to give accurate information, to connect only stores you are authorised to manage, to keep your use lawful, and to follow the terms of the platforms you connect. Never send us passwords or API keys by email or through a form.</>,
    },
    {
      title: 'Platforms',
      body: <>{BRAND} connects to platforms through their official APIs. Shopify, WooCommerce and Amazon are trademarks of their respective owners; {BRAND} is not affiliated with or endorsed by them. Your use of each platform is governed by that platform&rsquo;s own terms.</>,
    },
    {
      title: 'Your data',
      body: <>Your store data stays yours. We use it only to provide the service, keep it confidential, do not sell it, and do not use it to train public models. The <Link to="/privacy">Privacy Policy</Link> explains what the app reads and how it is deleted.</>,
    },
    {
      title: 'Intellectual property',
      body: <>The {BRAND} software, its checks and its documentation remain ours. You may use them while your account is active and in line with these Terms.</>,
    },
    {
      title: 'Limitation of liability',
      body: <>Our total liability to you is capped at the <strong>fees you paid us in the three months preceding the claim</strong>. We are not liable for indirect, incidental, consequential or special damages, including lost sales.</>,
    },
    {
      title: 'Term and termination',
      body: <>You can stop using {BRAND} at any time by uninstalling the app. We may suspend the service for misuse or non-payment. After you uninstall, your store data is deleted as described in the <Link to="/privacy">Privacy Policy</Link>.</>,
    },
    {
      title: 'Governing law',
      body: <>These Terms are governed by the laws of the State of Ohio. Any disputes will be resolved in the state or federal courts located in Franklin County, Ohio.</>,
    },
    {
      title: 'Changes',
      body: <>We may update these Terms. Material changes will be posted here with a new &ldquo;Last updated&rdquo; date. Continued use of the service after changes are posted means you accept the updated Terms.</>,
    },
    {
      title: 'Contact',
      body: <>Questions about these Terms? Email {mail}.</>,
    },
  ]
}

export const PRIVACY: LegalSection[] = [
  {
    title: 'What this policy covers',
    body: <>This policy covers this website and the {BRAND} app, starting with the Shopify version, which is in early access.</>,
  },
  {
    title: 'What the Shopify app reads',
    body: <>Products, product variants, inventory levels and locations, plus your shop&rsquo;s name, domain and timezone. <strong>The app does not read customer or order data.</strong> It asks Shopify for permission to read products, inventory and locations, and to write products, which it needs to change a variant&rsquo;s out-of-stock setting.</>,
  },
  {
    title: 'Why it reads that data',
    body: <>To find the stock problems the app checks for, to show you the evidence (the out-of-stock setting, available quantity at each location, and product tags), to propose a fix, to re-read a variant just before changing it, and to confirm the change afterwards. The timezone is used to show times in your store&rsquo;s local time.</>,
  },
  {
    title: 'What the app changes',
    body: <>Only the change you approve: a variant&rsquo;s setting from &ldquo;Continue selling when out of stock&rdquo; to &ldquo;Stop selling when out of stock&rdquo;. The app does not change stock counts.</>,
  },
  {
    title: 'What we keep',
    body: <>The issues found in your store, the evidence for each, the fixes proposed, your approvals, the changes made and their verification results. This activity history is kept so you can see what happened and why.</>,
  },
  {
    title: 'How access tokens are protected',
    body: <>When you install the app, Shopify gives us an access token for your store. We store it <strong>encrypted at rest</strong>, and it is <strong>never shown in the browser</strong>.</>,
  },
  {
    title: 'Deletion after you uninstall',
    body: <>When you uninstall the app, Shopify sends us a <strong>shop/redact</strong> request (Shopify documents this as arriving 48 hours after uninstall). We delete your store&rsquo;s data when we receive it. You can also ask us to delete it sooner by emailing {mail}.</>,
  },
  {
    title: 'What this website collects',
    body: <>Only what you type into the early access form: your name, work email, store or company name, store URL, the platforms you sell on, an approximate number of products, and the problem you describe. We use it to review your application and reply to you. Never send passwords or API keys through the form.</>,
  },
  {
    title: 'No analytics or tracking',
    body: <>This website has no analytics, no advertising pixels and no session replay, and it does not set tracking cookies. Pages load the Inter typeface from Google Fonts, so your browser requests it from Google&rsquo;s servers.</>,
  },
  {
    title: 'Sharing',
    body: <>We do not sell personal information. We share information only with service providers who help us run the service (for example hosting, database and email delivery) under confidentiality obligations, or where the law requires it.</>,
  },
  {
    title: 'Security',
    body: <>We use reasonable administrative and technical safeguards to protect information. No system is perfectly secure.</>,
  },
  {
    title: 'Your choices',
    body: <>You can ask to see, correct or delete the information we hold about you or your store at any time by emailing {mail}.</>,
  },
  {
    title: 'Contact',
    body: <>Questions about this Privacy Policy? Email {mail}.</>,
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
        ? `${BRAND} Terms of Service: the plain-English rules for using our website and the ${BRAND} app.`
        : `${BRAND} Privacy Policy: what the Shopify app reads, why, how access tokens are protected and how store data is deleted.`,
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
