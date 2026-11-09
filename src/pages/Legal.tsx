import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { env } from '../lib/env'
import { useSeo } from '../hooks/useSeo'

type LegalKind = 'terms' | 'privacy'
type LegalSection = { title: string; body: ReactNode }

const LEGAL_UPDATED = 'November 9, 2026'

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>

export function termsSections(entity: string): LegalSection[] {
  return [
    {
      title: 'Who we are',
      body: <>{BRAND} is a trade name operated by <strong>{entity}</strong>, an Ohio limited liability company (d/b/a {BRAND}). By using this website or the {BRAND} app, you agree to these Terms.</>,
    },
    {
      title: 'What Deploi AI is',
      body: <>{BRAND} is subscription software that finds supported stock and listing problems in an online store, shows the evidence, proposes a fix, makes the change you approve through the platform&rsquo;s official API, and re-reads the store to confirm the change took effect. It is offered as a <strong>pilot</strong>: each integration&rsquo;s status (Pilot or Planned) is shown on the Integrations page, and none is generally available yet. We do not provide legal, tax or accounting advice.</>,
    },
    {
      title: 'Early access',
      body: <>Early access is limited and may change. Features may be added, changed or removed, and the service may contain errors or be unavailable at times. During early access the service is provided <strong>&ldquo;as is&rdquo;</strong>, without warranties of any kind, to the extent the law allows. We may end early access for any account with reasonable notice.</>,
    },
    {
      title: 'Agents act on your instructions',
      body: <>{BRAND}&rsquo;s agents act only on your instructions: the jobs you switch on, the tasks you give them, and the authorization you grant each one (ask first, act then tell, or fully on its own within its limits). Anything that moves money always waits for your approval. You can pause an agent, change what it may do, or revoke it at any time, and every action is logged with its proof.</>,
    },
    {
      title: 'Your approval and your store',
      body: <>{BRAND} changes your store only as you approve or authorize: each change waits for your yes unless you have set that agent to act on its own within its limits, and anything that moves money always waits for you. You decide what to approve and remain responsible for your store, your products, your stock counts and what you sell. Verification confirms that the setting we changed reads back as expected; it does not confirm physical stock.</>,
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

const SCOPES: [string, string, string][] = [
  ['read_products', 'Products and variants: titles, prices, compare-at prices, SKUs, barcodes, tags, status and the out-of-stock setting', 'To find listing and stock problems, show you the evidence and re-read a product before and after a change'],
  ['write_products', 'The same product fields', 'To make only the changes you approve or an agent authorization you granted covers: a variant\u2019s out-of-stock setting, its price or compare-at price from your price list, and its SKU from your mapping'],
  ['read_inventory', 'Available quantity of each variant at each location', 'To find items that are out of stock, oversold or running low'],
  ['read_locations', 'Your locations\u2019 names', 'To show where stock is'],
  ['read_discounts', 'Your discounts and their dates, amounts and conditions (no customer data)', 'To let the Promo Manager agent find discounts that are expired, overlapping or set up wrong'],
  ['read_publications, write_publications (optional)', 'Which sales channels a product is published on', 'Asked for only if you turn on publication fixes; then used to publish or unpublish a product on the one channel you choose'],
]

export const PRIVACY: LegalSection[] = [
  {
    title: 'What this policy covers',
    body: <>This policy covers this website and the {BRAND} app: the Shopify app and the office tools you can connect to it. {BRAND} is operated by {env.legalEntity}.</>,
  },
  {
    title: 'What the Shopify app reads, and why',
    body: (
      <>
        <p>The app asks Shopify only for these permissions:</p>
        <table className="legal-table">
          <thead><tr><th scope="col">Permission</th><th scope="col">What it reads</th><th scope="col">Why</th></tr></thead>
          <tbody>{SCOPES.map(([s, what, why]) => <tr key={s}><td><code>{s}</code></td><td>{what}</td><td>{why}</td></tr>)}</tbody>
        </table>
        <p>It also reads your shop&rsquo;s name, domain, timezone and currency. <strong>The app does not ask for, read or store your Shopify customers, orders, fulfillments or returns</strong>, and it adds nothing to your storefront: no scripts, cookies or tracking for your shoppers. Reference files you upload (price lists, SKU mappings, channel lists) are stored with your account and used only to compare against your store.</p>
      </>
    ),
  },
  {
    title: 'What the app changes',
    body: <>Only what you approve, or what an agent&rsquo;s authorization you granted explicitly covers. Anything that moves money always waits for your approval, whatever an agent&rsquo;s setting. The app never changes stock counts, customers or orders.</>,
  },
  {
    title: 'Systems you choose to connect',
    body: <>You can connect other systems so your agents can work there too: email and calendar (Google or Microsoft, through their own sign-in), CRMs (HubSpot, Salesforce, Pipedrive, Zoho CRM), accounting (QuickBooks Online) and property management (Buildium). For each one we read only what its agents need (for example contacts, deals and activities in a CRM, invoices and their status in accounting, rentals, leases, applicants and tasks in property management), keep the access tokens or keys <strong>encrypted at rest</strong>, and act only within the permissions you grant each agent. When you connect, {BRAND} reads a summary of your business (counts and facts, such as how many items are out of stock or invoices are overdue) to set up your team; you can see what it read on the Command center. Disconnecting deletes the tokens and stops all reads and changes there.</>,
  },
  {
    title: 'Email, agent addresses and messages',
    body: <>We never ask for a mailbox password. For messages an agent drafts or sends we keep the sender, recipients, subject, body and attachments (content encrypted at rest), your approvals and the provider&rsquo;s response. An agent can have its own address on our domain; mail it sends goes through our email provider (Resend), and mail sent to it is stored encrypted so you can read it in {BRAND}. Incoming mail never changes what an agent is allowed to do; mail from unexpected senders is kept apart as quarantined.</>,
  },
  {
    title: 'Other people\u2019s information in your systems',
    body: <>The systems you connect can hold information about your own contacts, such as names and email addresses of leads, tenants, suppliers or customers in your CRM or mailbox. We process it only on your behalf, to do the work you set up, and delete it when you ask or when you remove {BRAND}.</>,
  },
  {
    title: 'Shopify privacy requests',
    body: <>The app handles all three of Shopify&rsquo;s mandatory privacy webhooks. <strong>customers/data_request</strong>: we gather everything we hold about that customer within your shop (in practice, only mail or records from systems you connected) into an encrypted export you can download in the app, and record that the request was answered. <strong>customers/redact</strong>: we delete that customer&rsquo;s messages and anonymize any other record of them, and record what was done. <strong>shop/redact</strong>: see below.</>,
  },
  {
    title: 'Deletion when you uninstall',
    body: <>When you uninstall, the app immediately stops every read, change and message for your store and deletes its access token. Shopify then sends a <strong>shop/redact</strong> request (Shopify sends it 48 hours after uninstall), and we erase your store&rsquo;s data, including its activity history, when it arrives. If you reinstall before then, nothing is erased. You can ask us to delete it sooner at {mail}.</>,
  },
  {
    title: 'AI',
    body: <>{BRAND}&rsquo;s agents run on rules and templates today. <strong>AI features are switched off, and no store or business data is sent to any AI provider.</strong> Before any AI feature is switched on, we will name the provider in this policy, send only the text a task needs, and use only a provider that does not train its models on that data. We never use your data to train models.</>,
  },
  {
    title: 'Service providers (subprocessors)',
    body: (
      <>
        <p>We do not sell personal information. These providers process data for us, under confidentiality obligations:</p>
        <ul>
          <li><strong>Vercel</strong> (application hosting and functions; United States, Washington DC region)</li>
          <li><strong>Supabase</strong> (database and sign-in; United States East)</li>
          <li><strong>Resend</strong> (sending email from agent addresses and our notifications)</li>
          <li><strong>Google Fonts</strong> (this website&rsquo;s typeface; your browser requests it from Google)</li>
          <li><strong>Twilio</strong> (text and voice updates, only if you turn them on; not live yet)</li>
          <li>The systems you connect (Shopify, Google, Microsoft, HubSpot, Salesforce, Pipedrive, Zoho, Intuit QuickBooks, Buildium) receive the requests our agents make on your behalf</li>
          <li>No AI provider (see AI above)</li>
        </ul>
        <p>We will update this list before adding a provider. Providers may process data outside your country; where the law requires it, we rely on appropriate safeguards for those transfers.</p>
      </>
    ),
  },
  {
    title: 'Where data is stored, and for how long',
    body: <>Data is stored in the United States. Your activity history (problems found, evidence, approvals, changes and their proof) is kept while the app is installed, then erased as described above. Server logs contain no access tokens, passwords or message content and are kept for up to 30 days. Backups held by our database host expire on its backup schedule. Information from this website&rsquo;s early access form is kept until you ask us to delete it.</>,
  },
  {
    title: 'How access tokens are protected',
    body: <>Store access tokens, connection keys and message content are <strong>encrypted at rest</strong>; tokens are never shown in the browser.</>,
  },
  {
    title: 'Information you give us',
    body: <>Who approved or changed what (the Shopify staff user ID or your {BRAND} sign-in email), your settings, agents and their authorizations, tasks you give agents, and any invite code you used (stored only in hashed form). If you contact support we keep the conversation.</>,
  },
  {
    title: 'This website',
    body: <>The website collects only what you type into the early access form (your name, work email, company, store URL, platforms, approximate product count and the problem you describe), to reply to you. It has no analytics, advertising pixels or session replay, and sets no tracking cookies.</>,
  },
  {
    title: 'Security',
    body: <>We use reasonable administrative and technical safeguards, including encryption at rest, per-organization access controls and audit logs of every change. No system is perfectly secure.</>,
  },
  {
    title: 'Contact',
    body: <>You can ask to see, correct or delete the information we hold about you or your store at any time at {mail}; we reply within 2 business days. Depending on where you live you may have further rights, such as objecting to processing or complaining to a data protection authority; contact us and we will help.</>,
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
        {!env.legalReviewed && <div className="draft-badge" role="status">DRAFT — pending legal review</div>}
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
