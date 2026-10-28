import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { ImageCard } from '../components/ImageCard'
import { StatusBadge, type ProductStatus } from '../components/StatusBadge'
import { EarlyAccessForm } from '../components/EarlyAccessForm'
import { art, type ArtTheme } from '../lib/art'
import { Icon } from '../lib/icons'

export const HOME_TITLE = `${BRAND} — Name an agent. Authorize what it may fix. See every change verified.`
export const HOME_DESCRIPTION =
  'Deploi AI is subscription software in which you create named AI agents that find and correct stock and listing problems in your online store: overselling settings, publication, prices and SKUs. Each agent works only within the authorization you grant, makes changes through the platform’s official API and re-reads your store to confirm them. Shopify first, in early access.'

export const SHOPIFY_STATUS_LINE = 'Early access. Tested on a synthetic store; not yet in the Shopify App Store.'

export default function Home() {
  useSeo({ title: HOME_TITLE, description: HOME_DESCRIPTION })
  return (
    <div className="home">
      <Hero />
      <HowItWorks />
      <Agents />
      <ShopifyToday />
      <Controls />
      <Platforms />
      <FAQ />
      <EarlyAccess />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                      */
/* -------------------------------------------------------------------------- */
function Hero() {
  return (
    <section id="top" className="hero">
      <div className="hero-art" style={{ backgroundImage: art('hero') }} aria-hidden="true" />
      <div className="container hero-inner">
        <span className="eyebrow reveal">AI agents for stock and listing problems</span>
        <h1 className="two-tone reveal">
          <span className="grey">Name an agent.</span><br />
          <span className="grey">Authorize what it may fix.</span><br />
          <span className="white">See every change verified.</span>
        </h1>
        <p className="lead reveal" style={{ maxWidth: 700 }}>
          {BRAND} is subscription software for online stores. You create named agents, tell each one in plain English
          what to look after, and approve exactly what it is allowed to change. Agents find overselling settings,
          publication, price and SKU problems, make the corrections you authorized through your platform&rsquo;s
          official API, and re-read your store to confirm each one took effect.
        </p>
        <div className="hero-ctas reveal">
          <CtaButton />
          <Link to="/#how" className="btn btn-ghost">How it works</Link>
        </div>
        <div className="hero-trust reveal">
          <span>Shopify first, in early access</span>
          <span>Agents act only within your authorization</span>
          <span>No customer or order data read</span>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  How it works                                                              */
/* -------------------------------------------------------------------------- */
export const FLOW: { title: string; body: string; icon: ReactNode }[] = [
  { title: 'Name and instruct', icon: <Icon.Pencil />, body: 'Create an agent, name it, and describe its task in plain English. Deploi turns it into a structured task you can read and edit.' },
  { title: 'Authorize', icon: <Icon.UserCheck />, body: 'Choose the store, the products, the corrections and fields it may change, your rules or reference files, its limits, and whether it asks before each change.' },
  { title: 'Detect with evidence', icon: <Icon.Search />, body: 'The agent compares your store with your rule or file and records the evidence for every problem it finds.' },
  { title: 'Exact change', icon: <Icon.Doc />, body: 'Each fix is one exact change: this field, from this value to that one. Anything ambiguous goes to you instead.' },
  { title: 'Checked, then made', icon: <Icon.Refresh />, body: 'Just before writing, the agent re-reads the record and re-checks its authorization. If anything changed, it stops.' },
  { title: 'Verified', icon: <Icon.Check />, body: 'A fresh read confirms the change took effect. Each change is shown as Verified, or Failed or Blocked with the reason.' },
]

export function HowItWorks() {
  return (
    <section id="how" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">How it works</span>
          <h2 className="two-tone">
            <span className="grey">Six steps.</span><br />
            <span className="white">Nothing outside what you authorized.</span>
          </h2>
        </div>
        <ol className="timeline">
          {FLOW.map((s, i) => (
            <li className="timeline-step reveal" key={s.title}>
              <div className="num" aria-hidden="true">{i + 1}</div>
              <div className="timeline-body">
                <h3>{s.title}</h3>
                <p className="body">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Agents                                                                    */
/* -------------------------------------------------------------------------- */
export const EXAMPLE_AGENT = {
  name: 'Stock Guardian',
  task: 'Every 6 hours, stop products from selling when they are out of stock, except anything tagged pre-order or backorder. Fix it automatically.',
  grants: [
    'Overselling settings on all products in your store, except products tagged pre-order or backorder',
    'May change one field: a variant’s out-of-stock setting',
    'Acts without asking, up to 25 changes per run and 100 a day',
    'Runs every 6 hours; you can pause or revoke it at any time',
  ],
}

export const APPROVAL_MODES: { title: string; body: string }[] = [
  { title: 'Review each change', body: 'The agent finds problems and proposes exact changes. Nothing is written until you approve that change.' },
  { title: 'Authorized to act within limits', body: 'You grant a standing authorization: store, products, corrections, fields, files, exceptions and limits. Changes it covers run without asking again. Anything outside it waits for you, with the reason.' },
]

export function Agents() {
  return (
    <section id="agents">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Agents</span>
          <h2 className="two-tone">
            <span className="grey">Your agents.</span><br />
            <span className="white">Your rules. Your limits.</span>
          </h2>
          <p className="lead">
            An instruction like &ldquo;fix my store&rdquo; never grants open-ended access. Deploi asks for the missing
            scope, shows you a readable summary of exactly what the agent may do, and grants nothing until you confirm it.
          </p>
        </div>
        <div className="setup-question reveal">
          <div className="setup-label">Example: {EXAMPLE_AGENT.name}</div>
          <p>&ldquo;{EXAMPLE_AGENT.task}&rdquo;</p>
          <ul className="svc-list">
            {EXAMPLE_AGENT.grants.map(g => <li key={g}>{g}</li>)}
          </ul>
        </div>
        <div className="why-grid controls-grid agents-grid">
          {APPROVAL_MODES.map(m => (
            <div className="why-item reveal" key={m.title}>
              <span className="ico" aria-hidden="true"><Icon.UserCheck /></span>
              <h3>{m.title}</h3>
              <p>{m.body}</p>
            </div>
          ))}
          <div className="why-item reveal">
            <span className="ico" aria-hidden="true"><Icon.History /></span>
            <h3>See what each agent did</h3>
            <p>Every run, every change with its before and after values, every failure and every blocked task, and why each change was covered by your authorization.</p>
          </div>
          <div className="why-item reveal">
            <span className="ico" aria-hidden="true"><Icon.Shield /></span>
            <h3>Pause, edit or revoke</h3>
            <p>Pausing or revoking stops all writes, including changes already queued. Widening what an agent may do always needs your approval again.</p>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  What the Shopify version does today                                       */
/* -------------------------------------------------------------------------- */
type Check = {
  tag: string
  title: string
  summary: string
  art: ArtTheme
  icon: ReactNode
  cols: { label: string; items: string[]; minus?: boolean }[]
  footnote: string
}

export const CHECKS: Check[] = [
  {
    tag: 'Correction 1 · Overselling settings',
    title: 'Selling with no stock against your rule',
    summary: 'Finds active, inventory-tracked variants set to keep selling when out of stock, when your rule says they should stop, and switches them to stop selling.',
    art: 'glow',
    icon: <Icon.Pencil />,
    cols: [
      { label: 'Compared with', items: ['Your rule: stop selling at zero', 'Available quantity at each location', 'The product’s tags'] },
      { label: 'Never changed', minus: true, items: ['Pre-order, backorder and made-to-order products (your tags)', 'Products sold through selling plans', 'Gift cards, untracked inventory and drafts', 'Stock counts'] },
    ],
    footnote: 'Variants already oversold while set to stop selling are reported to you with the evidence. Only a physical count or a receiving record can say what is on the shelf.',
  },
  {
    tag: 'Correction 2 · Publication',
    title: 'Published differently from your instructions',
    summary: 'Publishes, or if you allow it unpublishes, products on the one sales channel you authorize, so they match your product list or tag rule.',
    art: 'rings',
    icon: <Icon.Store />,
    cols: [
      { label: 'Compared with', items: ['Your publication list file, or “publish products tagged …”', 'Whether the product is published on that channel'] },
      { label: 'Never changed', minus: true, items: ['Product status: drafts and archived products are reported, not published', 'Products scheduled to publish later', 'Any other sales channel'] },
    ],
    footnote: 'Unpublished, draft or archived is not treated as an error on its own. Only your explicit instruction makes it one.',
  },
  {
    tag: 'Correction 3 · Prices',
    title: 'Price differs from your price list',
    summary: 'Sets a variant’s price, and if you choose its compare-at price, to the amount in your approved price list, in your store currency.',
    art: 'bars',
    icon: <Icon.Doc />,
    cols: [
      { label: 'Compared with', items: ['Your price list, matched by variant ID or a unique SKU', 'Your store currency', 'Your limit on the size of a change'] },
      { label: 'Never changed', minus: true, items: ['Rows in another currency or with conflicting prices', 'Variants on sale, if you protect them', 'Variants with fixed Markets or B2B prices', 'Prices Deploi would have to guess'] },
    ],
    footnote: 'Changes larger than your limit always wait for your approval, even for an agent authorized to act on its own.',
  },
  {
    tag: 'Correction 4 · SKUs',
    title: 'SKU missing or different from your mapping',
    summary: 'Fills in missing SKUs, and if you allow it corrects wrong ones, from your approved SKU mapping, matched by variant ID, barcode, or product handle and option.',
    art: 'rows',
    icon: <Icon.Link />,
    cols: [
      { label: 'Compared with', items: ['Your SKU mapping', 'Every other SKU and barcode in your store'] },
      { label: 'Never changed', minus: true, items: ['Ambiguous matches, such as a barcode shared by several variants', 'SKUs that would duplicate one already in use', 'Identifiers Deploi would have to make up'] },
    ],
    footnote: 'Anything ambiguous is blocked and sent to you with the rows involved.',
  },
]

export function ShopifyToday() {
  return (
    <section id="shopify" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The Shopify version today</span>
          <h2 className="two-tone">
            <span className="grey">Four corrections.</span><br />
            <span className="white">Each one against your own rule or file.</span>
          </h2>
          <p className="status-line"><StatusBadge status="early_access" /> <span>{SHOPIFY_STATUS_LINE}</span></p>
          <p className="lead">
            Price lists, SKU mappings and publication lists are CSV files you upload. They are treated as data: nothing
            written in a file can change what an agent is allowed to do. A new version of a file cancels changes based on
            the old one.
          </p>
        </div>
        <div className="card-grid">
          {CHECKS.map(c => (
            <div className="reveal" key={c.title}>
              <ImageCard tag={c.tag} tagIcon={c.icon} title={c.title} art={c.art} className="check-card">
                <div className="icard-bottom svc">
                  <div className="icard-title">{c.title}</div>
                  <p className="svc-desc">{c.summary}</p>
                  <div className="svc-cols">
                    {c.cols.map(col => (
                      <div key={col.label}>
                        <div className="svc-label">{col.label}</div>
                        <ul className={`svc-list ${col.minus ? 'svc-list-x' : ''}`}>
                          {col.items.map(i => <li key={i}>{i}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <p className="check-foot">{c.footnote}</p>
                </div>
              </ImageCard>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Controls                                                                  */
/* -------------------------------------------------------------------------- */
export const CONTROLS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Icon.UserCheck />,
    title: 'Approval or a standing authorization',
    body: 'Approve each exact change, or grant an agent a standing authorization with a defined scope and limits. Each change records the authorization version it ran under and why it qualified.',
  },
  {
    icon: <Icon.Refresh />,
    title: 'Checked before, verified after',
    body: 'Every change is re-checked just before it is made and verified with a fresh read afterwards. An accepted request alone is never reported as success.',
  },
  {
    icon: <Icon.Check />,
    title: 'A truthful status for every change',
    body: 'Awaiting approval, Queued, Running, Blocked, Failed or Verified, with the reason.',
  },
  {
    icon: <Icon.History />,
    title: 'A full record',
    body: 'Which agent, the evidence, the authorization, the before and after values, the times, the attempts and the verification read are all kept.',
  },
  {
    icon: <Icon.Shield />,
    title: 'No conflicts or loops',
    body: 'Two agents cannot be authorized for the same correction on the same products, a change runs once, and if someone changes a value back Deploi asks you instead of flipping it again.',
  },
  {
    icon: <Icon.Lock />,
    title: 'Limited access, encrypted tokens',
    body: 'Permissions are enforced in code, not by instructions to a model. Deploi does not read customer or order data, and access tokens are encrypted.',
  },
]

export function Controls() {
  return (
    <section id="controls" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Controls</span>
          <h2 className="two-tone">
            <span className="grey">Agents work for you,</span><br />
            <span className="white">inside the limits you set.</span>
          </h2>
        </div>
        <div className="why-grid controls-grid">
          {CONTROLS.map(p => (
            <div className="why-item reveal" key={p.title}>
              <span className="ico" aria-hidden="true">{p.icon}</span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Platforms                                                                 */
/* -------------------------------------------------------------------------- */
export const PLATFORM_CARDS: { name: string; status: ProductStatus; order: string; body: string; art: ArtTheme }[] = [
  {
    name: 'Shopify',
    status: 'early_access',
    order: 'First',
    body: 'Agents and the four corrections above. Built and tested against a synthetic test store; not yet run on a real merchant’s store and not yet listed in the Shopify App Store.',
    art: 'rings',
  },
  {
    name: 'WooCommerce',
    status: 'planned',
    order: 'Next',
    body: 'A similar check for products with managed stock at or below zero that still allow backorders, with the fix written through the WooCommerce REST API.',
    art: 'blocks',
  },
  {
    name: 'Amazon Seller Central',
    status: 'planned',
    order: 'After WooCommerce',
    body: 'Listing issues Amazon itself reports, and listings that are not buyable. Seller-fulfilled quantities only from a stock source you configure, never guessed.',
    art: 'grid',
  },
]

export function Platforms() {
  return (
    <section id="platforms" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Platforms</span>
          <h2 className="two-tone">
            <span className="grey">Shopify first.</span><br />
            <span className="white">One platform is all you need.</span>
          </h2>
          <p className="lead">
            Each platform works on its own. Nothing requires selling on several. Comparing stock across channels is a
            possible later add-on and is not part of the product today.
          </p>
        </div>
        <div className="card-grid three">
          {PLATFORM_CARDS.map(p => (
            <div className="reveal" key={p.name}>
              <ImageCard tag={p.order} tagIcon={<Icon.Store />} title={p.name} art={p.art} className="platform-card">
                <div className="icard-bottom svc">
                  <div className="icard-title">{p.name}</div>
                  <StatusBadge status={p.status} />
                  <p className="svc-desc">{p.body}</p>
                </div>
              </ImageCard>
            </div>
          ))}
        </div>
        <p className="platform-note reveal">
          These are integrations through each platform&rsquo;s official API, not partnerships. {BRAND} is not affiliated
          with or endorsed by Shopify, WooCommerce or Amazon.
        </p>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  FAQ                                                                       */
/* -------------------------------------------------------------------------- */
export const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: 'What can an agent change?',
    a: <>Only what you authorize, and only these four things in Shopify today: a variant&rsquo;s out-of-stock setting, whether a product is published on one sales channel you choose, a variant&rsquo;s price or compare-at price, and a variant&rsquo;s SKU. It never changes stock counts, product status, customers or orders.</>,
  },
  {
    q: 'Can an agent act without asking me?',
    a: <>Only if you grant it a standing authorization. You see a readable summary of exactly what it covers (store, products, corrections, fields, files, exceptions and limits) before you grant it. Anything outside it waits for your approval. Pausing or revoking an agent stops all writes, including queued ones.</>,
  },
  {
    q: 'What if I just tell it to “fix my store”?',
    a: <>That is not enough to grant anything. Deploi asks which corrections, which products and which rules or files to use, and it reports requests it cannot do instead of guessing.</>,
  },
  {
    q: 'Do I need more than one platform?',
    a: <>No. One platform is enough. A Shopify store needs only Shopify, and the same will apply to WooCommerce and Amazon Seller Central once they are available. Comparing stock across channels is a possible later add-on, not part of the product today.</>,
  },
  {
    q: 'What does it read?',
    a: <>Products, variants, inventory, locations, sales channel publications and fixed Markets prices, plus your shop&rsquo;s name, domain, timezone and currency, and the files you upload. It does not read customer or order data. The <Link to="/privacy">privacy policy</Link> has the details.</>,
  },
  {
    q: 'What happens if my store or my file changes before a change runs?',
    a: <>The change does not run. Deploi re-reads the record and re-checks the agent&rsquo;s authorization just before writing, and a new version of your file cancels changes based on the old one. You see the reason next to the change.</>,
  },
  {
    q: 'What does it cost?',
    a: <>{BRAND} is a subscription. Pricing will be published before general availability.</>,
  },
  {
    q: 'Is it in the Shopify App Store?',
    a: <>Not yet. The Shopify version is in early access. It has been built and tested against a synthetic test store and has not yet been run on a real merchant&rsquo;s store.</>,
  },
]

export function FAQ() {
  return (
    <section id="faq">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Questions</span>
          <h2 className="two-tone">
            <span className="grey">Straight answers</span><br />
            <span className="white">before you apply.</span>
          </h2>
        </div>
        <div className="faq-list reveal">
          {FAQS.map(f => (
            <details className="faq-item" key={f.q}>
              <summary>
                <span className="faq-q">{f.q}</span>
                <span className="faq-chevron" aria-hidden="true"><Icon.Chevron width={18} height={18} /></span>
              </summary>
              <div className="faq-a">
                <p>{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Early access                                                              */
/* -------------------------------------------------------------------------- */
export function EarlyAccess() {
  return (
    <section id="early-access" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Apply for Early Access</span>
          <h2 className="two-tone">
            <span className="grey">Access is limited.</span><br />
            <span className="white">Tell us about your store.</span>
          </h2>
          <p className="lead">
            Shopify stores come first. WooCommerce and Amazon Seller Central stores can apply now, and we will be in
            touch when those integrations are ready.
          </p>
        </div>
        <div className="book-inner reveal">
          <EarlyAccessForm />
        </div>
      </div>
    </section>
  )
}
