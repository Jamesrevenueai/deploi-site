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

export const HOME_TITLE = `${BRAND} — Find stock and listing problems. Approve the fix. See it verified.`
export const HOME_DESCRIPTION =
  'Deploi AI is subscription software that finds stock and listing problems in an online store, shows the evidence, proposes a fix, makes the change you approve through the platform’s official API, and re-reads the store to confirm it took effect. Shopify first, in early access.'

export const SHOPIFY_STATUS_LINE = 'Early access. Tested on a synthetic store; not yet in the Shopify App Store.'

export default function Home() {
  useSeo({ title: HOME_TITLE, description: HOME_DESCRIPTION })
  return (
    <div className="home">
      <Hero />
      <HowItWorks />
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
        <span className="eyebrow reveal">Stock and listing checks for online stores</span>
        <h1 className="two-tone reveal">
          <span className="grey">Find stock and listing problems.</span><br />
          <span className="grey">Approve the fix.</span><br />
          <span className="white">See it verified.</span>
        </h1>
        <p className="lead reveal" style={{ maxWidth: 680 }}>
          {BRAND} is subscription software for online stores. It finds stock and listing problems, shows you the
          evidence and proposes a fix. You approve that exact change. Deploi makes it through your platform&rsquo;s
          official API, then re-reads your store to confirm it took effect.
        </p>
        <div className="hero-ctas reveal">
          <CtaButton />
          <Link to="/#how" className="btn btn-ghost">How it works</Link>
        </div>
        <div className="hero-trust reveal">
          <span>Shopify first, in early access</span>
          <span>Nothing changes without your approval</span>
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
  { title: 'Detect', icon: <Icon.Search />, body: 'Deploi checks your store against a rule you set, using your platform’s own records.' },
  { title: 'Evidence', icon: <Icon.Doc />, body: 'Each problem comes with what was found: the setting, the stock at each location, the tags.' },
  { title: 'Proposed fix', icon: <Icon.Pencil />, body: 'Where a safe fix exists, Deploi proposes one specific change. Where it does not, it tells you what to check.' },
  { title: 'Your approval', icon: <Icon.UserCheck />, body: 'You approve that exact change. Nothing changes without it.' },
  { title: 'Change made', icon: <Icon.Refresh />, body: 'Deploi re-reads the record just before writing, refuses if anything changed, then makes the change through the official API.' },
  { title: 'Verified', icon: <Icon.Check />, body: 'A fresh read confirms the change took effect. The fix is marked Verified, or Failed or Blocked with the reason.' },
]

export function HowItWorks() {
  return (
    <section id="how" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">How it works</span>
          <h2 className="two-tone">
            <span className="grey">Six steps.</span><br />
            <span className="white">You approve before anything changes.</span>
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

export const SETUP_QUESTION = 'Should products stop selling when they run out, except the ones you mark as pre-order or backorder?'

export const CHECKS: Check[] = [
  {
    tag: 'Check 1 · Fix with your approval',
    title: 'Selling with no stock against your rule',
    summary:
      'Finds active, inventory-tracked variants that still have “Continue selling when out of stock” turned on, and proposes switching that variant to “Stop selling when out of stock”.',
    art: 'glow',
    icon: <Icon.Pencil />,
    cols: [
      {
        label: 'Evidence shown',
        items: ['The variant’s out-of-stock setting', 'Available quantity at each location', 'The product’s tags'],
      },
      {
        label: 'Skipped',
        minus: true,
        items: [
          'Products tagged pre-order, backorder or made-to-order (you can edit the tags)',
          'Products sold through selling plans, which is how pre-order and subscription apps work',
          'Gift cards, untracked inventory, drafts and products you exempt',
        ],
      },
    ],
    footnote:
      'No stock left: high priority. Still in stock: a lower-priority rule mismatch. Deploi re-reads the variant just before writing, refuses if anything changed, then confirms the change with a fresh read.',
  },
  {
    tag: 'Check 2 · Evidence and next steps',
    title: 'Oversold while set to stop selling',
    summary:
      'Finds variants set to stop selling whose available quantity is below zero at a location. Deploi shows the evidence and tells you what to check.',
    art: 'peaks',
    icon: <Icon.Alert />,
    cols: [
      {
        label: 'Evidence shown',
        items: ['The variant’s out-of-stock setting', 'Available quantity at each location'],
      },
      {
        label: 'Not changed',
        minus: true,
        items: ['Stock counts. Only a physical count or a receiving record can say what is on the shelf.'],
      },
    ],
    footnote: 'This check flags the problem and explains it. It does not write anything to your store.',
  },
]

export function ShopifyToday() {
  return (
    <section id="shopify">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The Shopify version today</span>
          <h2 className="two-tone">
            <span className="grey">Two checks.</span><br />
            <span className="white">One setup question.</span>
          </h2>
          <p className="status-line"><StatusBadge status="early_access" /> <span>{SHOPIFY_STATUS_LINE}</span></p>
        </div>
        <div className="setup-question reveal">
          <div className="setup-label">The setup question</div>
          <p>&ldquo;{SETUP_QUESTION}&rdquo;</p>
          <p className="muted">Your answer becomes the rule the first check compares your store against.</p>
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
    title: 'Your approval, for that exact change',
    body: 'Nothing changes without your approval of that exact change. Approvals expire, and they are cancelled if the store changes before the fix runs.',
  },
  {
    icon: <Icon.Refresh />,
    title: 'Checked before, verified after',
    body: 'Every change is re-checked just before it is made and verified with a fresh read afterwards.',
  },
  {
    icon: <Icon.Check />,
    title: 'A clear status for every fix',
    body: 'Each fix shows as Pending, Verified, Failed or Blocked, with the reason.',
  },
  {
    icon: <Icon.History />,
    title: 'A full activity history',
    body: 'What was found, what was approved, what changed and what the verification read back are all kept.',
  },
  {
    icon: <Icon.Shield />,
    title: 'No back-and-forth with your team',
    body: 'If someone changes a setting back, Deploi will not keep flipping it. It asks you instead.',
  },
  {
    icon: <Icon.Lock />,
    title: 'Limited access, encrypted tokens',
    body: 'Deploi reads products, inventory and locations only. It does not read customer or order data. Access tokens are encrypted.',
  },
]

export function Controls() {
  return (
    <section id="controls" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Controls</span>
          <h2 className="two-tone">
            <span className="grey">You stay in charge</span><br />
            <span className="white">of every change.</span>
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
    body: 'The two checks above. Built and tested against a synthetic test store; not yet run on a real merchant’s store and not yet listed in the Shopify App Store.',
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
    <section id="platforms">
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
    q: 'Do I need more than one platform?',
    a: <>No. One platform is enough. A Shopify store needs only Shopify, and the same will apply to WooCommerce and Amazon Seller Central once they are available. Comparing stock across channels is a possible later add-on, not part of the product today.</>,
  },
  {
    q: 'Will it change my stock counts?',
    a: <>No. The only change the Shopify version makes is the variant&rsquo;s out-of-stock setting, and only after you approve it. When a variant is oversold, Deploi shows the evidence and tells you what to check, because only a physical count or a receiving record can say what is on the shelf.</>,
  },
  {
    q: 'What does it read?',
    a: <>Products, inventory and locations, plus your shop&rsquo;s name, domain and timezone. It does not read customer or order data. The <Link to="/privacy">privacy policy</Link> has the details.</>,
  },
  {
    q: 'What happens if my store changes after I approve a fix?',
    a: <>The fix does not run. Approvals are cancelled if the store changes before the fix runs, and Deploi re-reads the record just before writing and refuses if anything changed. You see the reason next to the fix.</>,
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
    <section id="faq" className="alt">
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
    <section id="early-access">
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
