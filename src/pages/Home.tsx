import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { BookButton, bookCtaLabel } from '../components/Button'
import { ImageCard } from '../components/ImageCard'
import { art, type ArtTheme } from '../lib/art'
import { BookSection } from '../components/BookSection'
import { Icon } from '../lib/icons'
import { ServiceCard } from '../components/ServiceCard'
import { AvailabilityBadge } from '../components/AvailabilityBadge'
import { catalog, money, moneyRange, servicesByDoor, sellableServices, type DoorKey } from '../lib/catalog'

export const HOME_TITLE = `${BRAND} — Done-for-you operations for home care agencies`
export const HOME_DESCRIPTION =
  'Deploi AI sets up and runs the follow-up work small home care agencies never have time for: referral replies, applicant texts, aide check-ins, credential reminders, open-shift offers, authorization alerts and EVV exception lists. Built for home care agencies first; other small healthcare practices by conversation.'

export default function Home() {
  useSeo({ title: HOME_TITLE, description: HOME_DESCRIPTION })
  return (
    <div className="home">
      <Hero />
      <Problems />
      <ThreeDoors />
      <Services />
      <HowWeWork />
      <MorningReport />
      <WhyDeploi />
      <Pricing />
      <FAQ />
      <BookSection />
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
        <span className="eyebrow reveal">Done-for-you operations for home care agencies</span>
        <h1 className="two-tone reveal">
          <span className="grey">Referrals answered.</span><br />
          <span className="grey">Shifts covered.</span><br />
          <span className="white">Every visit checked.</span>
        </h1>
        <p className="lead reveal" style={{ maxWidth: 660 }}>
          {BRAND} sets up and runs the follow-up work a small home care agency never has time for:
          referral replies, applicant texts, aide check-ins, credential reminders, open-shift offers,
          authorization alerts and EVV exception lists. A person approves every message. You see it
          all on one morning report.
        </p>
        <div className="reveal">
          <BookButton>{bookCtaLabel()}</BookButton>
        </div>
        <div className="hero-trust reveal">
          <span>Built for home care agencies first; other small healthcare practices by conversation</span>
          <span>A BAA is signed before any patient data moves</span>
          <span>Your scheduler, EVV and billing systems stay</span>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  The problem (illustrative situations, not customer quotes)                 */
/* -------------------------------------------------------------------------- */
export const PROBLEMS: { who: string; text: string }[] = [
  { who: 'The owner', text: 'A hospital referral sat in the inbox since Friday. By Monday the discharge planner had placed the client with someone else.' },
  { who: 'The scheduler', text: 'A 6 a.m. call-off, and the open shift gets offered to aides one text at a time while the family waits.' },
  { who: 'The applicant', text: 'Applied on Tuesday. Nobody reached out until the following week, and by then she had started somewhere else.' },
  { who: 'The biller', text: 'The visit happened. The EVV record did not match the schedule, nobody corrected it in time, and the claim is on hold.' },
]

function Problems() {
  return (
    <section id="problem" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The problem</span>
          <h2 className="two-tone">
            <span className="grey">Four people.</span><br />
            <span className="white">One missed follow-up.</span>
          </h2>
          <p className="lead">
            Lost referrals, unfilled shifts, aides who quit in month two and visits that never get paid
            usually start the same way: nobody followed up fast enough.
          </p>
        </div>
        <div className="voices">
          {PROBLEMS.map(v => (
            <div className="voice reveal" key={v.who}>
              <div className="who">{v.who}</div>
              <p className="quote">{v.text}</p>
            </div>
          ))}
        </div>
        <p className="illustrative reveal">Illustrative situations, not customer quotes.</p>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Three doors                                                               */
/* -------------------------------------------------------------------------- */
const DOOR_FACTS: [{ icon: ReactNode; label: string }, { icon: ReactNode; label: string }] = [
  { icon: <Icon.Check />, label: 'Human-reviewed' },
  { icon: <Icon.Link />, label: 'Your systems stay' },
]

const DOOR_ICON: Record<DoorKey, ReactNode> = {
  growth: <Icon.Inbox />,
  staffing: <Icon.Users />,
  operations: <Icon.Shield />,
}

const DOOR_ART: Record<DoorKey, ArtTheme> = { growth: 'growth', staffing: 'staffing', operations: 'operations' }

function ThreeDoors() {
  const doors: { door: DoorKey; title: string; to: string }[] = [
    { door: 'growth', title: 'Answer referrals and get found', to: '/#menu' },
    { door: 'staffing', title: 'Hire and keep aides', to: '/#menu' },
    { door: 'operations', title: 'Cover shifts, watch authorizations, catch EVV exceptions', to: '/#menu' },
  ]
  return (
    <section id="what">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">What we do</span>
          <h2 className="two-tone">
            <span className="grey">Three doors.</span><br />
            <span className="white">One supervised engine behind them.</span>
          </h2>
          <p className="lead">
            We watch your referral inbox, applicant list, roster, credential dates, open shifts,
            authorizations and EVV exports for the moments that need a follow-up, draft the next step,
            and wait for a person to approve it. Then we report back every morning.
          </p>
        </div>
        <div className="card-grid three">
          {doors.map(d => (
            <div className="reveal" key={d.door}>
              <ImageCard tag={catalog.doors[d.door]} tagIcon={DOOR_ICON[d.door]} title={d.title} facts={DOOR_FACTS} to={d.to} art={DOOR_ART[d.door]} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Services, rendered from the catalog                                       */
/* -------------------------------------------------------------------------- */
/** Integrations shown on the public site: the systems an agency touches, not our own infrastructure. */
const PUBLIC_INTEGRATION_KINDS = ['evv', 'email', 'sms', 'payments']
export const publicIntegrations = catalog.integrations.filter(i => PUBLIC_INTEGRATION_KINDS.includes(i.kind))

export function Services() {
  const groups = servicesByDoor()
  return (
    <section id="menu" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Services</span>
          <h2 className="two-tone">
            <span className="grey">Start with the problem</span><br />
            <span className="white">costing you the most this month.</span>
          </h2>
          <p className="lead">
            {sellableServices.length} services in three groups. You never buy all of them; the assessment
            shows which one to build first and the proposal scopes exactly that.
          </p>
          <p className="availability-key">
            Each service carries an availability status.{' '}
            {(['demonstration', 'supervised_pilot', 'production_verified'] as const).map((k, i) => (
              <span key={k}>
                {i > 0 && ' '}
                <AvailabilityBadge availability={k} compact />
              </span>
            ))}
          </p>
        </div>
        {groups.map(g => (
          <div className="service-group" key={g.door}>
            <h3 className="service-group-title reveal">
              <span className="ico" aria-hidden="true">{DOOR_ICON[g.door]}</span>
              {g.label}
            </h3>
            <div className="card-grid">
              {g.services.map(s => (
                <div className="reveal" key={s.key}>
                  <ServiceCard service={s} art={DOOR_ART[g.door]} icon={DOOR_ICON[g.door]} />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="integrations reveal" id="integrations">
          <h3>Works with your systems</h3>
          <p className="muted">
            We read what your current systems already export, so nothing migrates. Compatibility means our
            import works with that system&rsquo;s export or API; it is not a partnership or an endorsement, and
            we do not show vendor logos.
          </p>
          <ul className="integration-list">
            {publicIntegrations.map(i => (
              <li key={i.key}>
                <span className="integration-name">{i.name}</span>
                <span className="integration-level">{catalog.integrationLevelLabel[i.level]}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  How we work: the six-stage journey                                        */
/* -------------------------------------------------------------------------- */
export const JOURNEY: { title: string; body: string }[] = [
  { title: 'Discovery', body: 'A conversation about which problems cost you the most and whether we fit. No fee.' },
  { title: 'Paid assessment', body: `A fixed-fee diagnostic: one referral and one visit traced end to end, a written report and a review meeting. Credited toward a build within ${catalog.pricing.assessment.creditTermDays} days.` },
  { title: 'Scoped proposal', body: 'One defined service, with the volume, support hours and responsibilities written down. The exact scope sets the final quote.' },
  { title: 'Build', body: `Configuration, supported connections, testing, training and documentation, with in-scope fixes for ${catalog.pricing.build.fixPeriodDays} days.` },
  { title: 'Supervised pilot', body: 'The service runs on your real work with every action reviewed by a person and results measured against the baseline.' },
  { title: 'Monthly management', body: `Defined workers, defined volume, defined support coverage and defined responsibilities, with an initial term of ${catalog.pricing.management.initialTermMonths} months.` },
]

export const YOU_KEEP: string[] = [
  'Approving, editing or skipping every proposed message',
  'Clinical, hiring, pay and billing decisions',
  'Corrections inside your own scheduler, EVV and billing systems',
  'Collecting SMS consent from aides and applicants',
]

export const WE_KEEP: string[] = [
  'Keeping the imports, rules and templates running',
  'Reviewing proposals during the support hours in your engagement',
  'Measuring the agreed success measures and reporting them',
  'Telling you before anything changes',
]

export function HowWeWork() {
  return (
    <section id="how">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">How we work</span>
          <h2 className="two-tone">
            <span className="grey">Six stages.</span><br />
            <span className="white">Nothing runs unsupervised.</span>
          </h2>
        </div>
        <ol className="timeline">
          {JOURNEY.map((s, i) => (
            <li className="timeline-step reveal" key={s.title}>
              <div className="num" aria-hidden="true">{i + 1}</div>
              <div className="timeline-body">
                <h3>{s.title}</h3>
                <p className="body">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="keep-grid reveal">
          <div className="keep-col">
            <h3>What stays with you</h3>
            <ul className="check-list">
              {YOU_KEEP.map(k => <li key={k}><Icon.Check />{k}</li>)}
            </ul>
          </div>
          <div className="keep-col">
            <h3>What we take care of</h3>
            <ul className="check-list">
              {WE_KEEP.map(k => <li key={k}><Icon.Check />{k}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Morning report card (illustration with synthetic data)                     */
/* -------------------------------------------------------------------------- */
const LANES = [
  {
    label: 'Referrals',
    icon: <Icon.Inbox />,
    tasks: [
      { ts: 'now', text: 'new referral in the inbox · reply drafted, waiting for approval', active: true },
      { ts: '07:42', text: 'hospital discharge referral · capacity confirmed to the case manager' },
      { ts: '07:15', text: '7-day follow-up proposed to a referring office' },
    ],
  },
  {
    label: 'Staffing',
    icon: <Icon.Users />,
    tasks: [
      { ts: 'now', text: 'applicant replied · screening questions proposed', active: true },
      { ts: '07:38', text: '2 interview slots booked after approval' },
      { ts: '07:05', text: '60-day check-ins proposed for 3 new aides · 1 reply flagged' },
    ],
  },
  {
    label: 'Visits',
    icon: <Icon.Shield />,
    tasks: [
      { ts: 'now', text: 'call-off for Mon 8a · offers proposed to 4 qualified aides', active: true },
      { ts: '07:31', text: 'authorization at 12% remaining · alert proposed to the office' },
      { ts: '06:58', text: 'EVV import: 3 exceptions listed, 9 days to the correction deadline' },
    ],
  },
]

function MorningReport() {
  return (
    <section id="report" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Every morning</span>
          <h2 className="two-tone">
            <span className="grey">One page.</span><br />
            <span className="white">Everything that moved overnight.</span>
          </h2>
          <p className="lead">
            What was proposed, what was approved, what is waiting on you, and the measures you agreed to
            track. The card below shows the layout with made-up entries.
          </p>
        </div>
        <div className="card-grid single reveal">
          <ImageCard tag="Illustration with synthetic data" tagIcon={<Icon.Clock />} title="Your morning report" className="report-card" art="glow">
            <div className="report-inner">
              <div className="icard-title">Your morning report</div>
              <div className="lanes">
                {LANES.map(lane => (
                  <div className="lane" key={lane.label}>
                    <div className="lane-label">{lane.icon}{lane.label}</div>
                    {lane.tasks.map(t => (
                      <div className={`task ${t.active ? 'active' : ''}`} key={t.text}>
                        <span className="ts">{t.ts}</span>
                        <span>{t.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="report-note">Illustration with synthetic data. Not a customer report.</div>
            </div>
          </ImageCard>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Why Deploi                                                                */
/* -------------------------------------------------------------------------- */
function WhyDeploi() {
  const points = [
    { icon: <Icon.Shield />, title: 'Home care first', body: 'Built for small home care agencies on Medicaid waiver and private pay: referral inboxes, aide rosters, open shifts, authorizations and EVV exports. Other small healthcare practices by conversation, when the work genuinely fits.' },
    { icon: <Icon.Check />, title: 'A BAA before any data', body: 'A Business Associate Agreement is signed before any patient data moves. We use only what the service needs. Every change is logged, and reads of client records are logged on the dashboard, report and action pages. Staffing services touch no client records at all.' },
    { icon: <Icon.Link />, title: 'Your systems stay', body: 'We work from the exports your scheduler, EVV and billing systems already produce. Nothing to migrate, nothing to retrain. Corrections are made in your own systems, by your people.' },
    { icon: <Icon.Users />, title: 'A named person answers', body: 'No account manager, no ticket queue. You reach the person who set it up, during the support hours written into your engagement.' },
  ]
  return (
    <section id="why">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Why {BRAND}</span>
          <h2 className="two-tone">
            <span className="grey">We know the work</span><br />
            <span className="white">a home care office does.</span>
          </h2>
        </div>
        <div className="why-grid">
          {points.map(p => (
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
/*  Pricing, from the catalog                                                 */
/* -------------------------------------------------------------------------- */
export function Pricing() {
  const p = catalog.pricing
  const tiers: { step: string; price: string; title: string; lines: string[]; note: string; art: ArtTheme; featured?: boolean; to?: string }[] = [
    {
      step: 'Step 1',
      price: moneyRange(p.assessment.min, p.assessment.max),
      title: 'Operations assessment',
      lines: p.assessment.includes,
      note: `Fixed fee, credited toward a build within ${p.assessment.creditTermDays} days.`,
      art: 'assess',
    },
    {
      step: 'Step 2',
      price: moneyRange(p.build.min, p.build.max),
      title: 'Build, per defined service scope',
      lines: p.build.includes,
      note: `In-scope fixes for ${p.build.fixPeriodDays} days after go-live.`,
      art: 'build',
    },
    {
      step: 'Step 3',
      price: `${moneyRange(p.management.min, p.management.max)} /mo`,
      title: 'Monthly management',
      lines: p.management.includes,
      note: `Initial term of ${p.management.initialTermMonths} months, then month to month. Defined workers, volume, support coverage and responsibilities.`,
      art: 'run',
      featured: true,
    },
    {
      step: 'Standalone',
      price: `${money(p.website.price)} one-time`,
      title: 'Website Improvement',
      lines: ['Up to three existing pages improved', 'One revision round', `Target: ${p.website.targetBusinessDays} business days after payment, access and content`],
      note: 'No assessment and no retainer required. Does not credit toward other services.',
      art: 'growth',
      to: '/website',
    },
  ]
  return (
    <section id="pricing" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Pricing</span>
          <h2 className="two-tone">
            <span className="grey">Published ranges.</span><br />
            <span className="white">The scope sets the quote.</span>
          </h2>
          <p className="lead">
            Three steps for operations work, plus one standalone website service. Ranges are published so you
            know before the conversation whether we fit.
          </p>
        </div>
        <div className="card-grid">
          {tiers.map(t => (
            <div className="reveal" key={t.step}>
              <ImageCard tag={t.step} tagIcon={<Icon.Tag />} title={t.price} featured={t.featured} art={t.art} to={t.to}>
                <div className="icard-bottom price-card">
                  <div className="icard-title">{t.price}</div>
                  <div className="price-title">{t.title}</div>
                  <ul className="price-lines">
                    {t.lines.map(l => <li key={l}>{l}</li>)}
                  </ul>
                  <div className="price-note">{t.note}</div>
                  {t.to && <span className="price-link">See what is included →</span>}
                </div>
              </ImageCard>
            </div>
          ))}
        </div>
        <div className="price-notes reveal">
          <p>
            <strong>The exact scope determines the final quote.</strong> The lowest price in each range does not
            include {joinList(catalog.notIncludedInLowestPrice)}.
          </p>
          <p>Five things we price separately, so a proposal is never a surprise:</p>
          <ul className="scope-list">
            {catalog.scopeConsiderations.map(c => (
              <li key={c.key}>
                <strong>{c.label}.</strong> {c.note}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

/** "a, b, c or d" */
export function joinList(items: string[], conj = 'or'): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`
}

/* -------------------------------------------------------------------------- */
/*  FAQ                                                                       */
/* -------------------------------------------------------------------------- */
export const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: 'Do we have to change our scheduler, EVV or billing system?',
    a: <>No. We work from the exports and inboxes you already have. If a system cannot give us what a service needs, we tell you in the assessment, not after.</>,
  },
  {
    q: 'Does anything get sent automatically?',
    a: <>No. Every message a worker proposes waits for a named person at your agency or at {BRAND} to approve, edit or skip it. Auto-send is off unless your engagement turns it on for a specific worker, in writing.</>,
  },
  {
    q: 'What is a supervised pilot?',
    a: <>The service runs on your real referrals, applicants, shifts or visit exports with every action reviewed by a person, for a set period, with results measured against the baseline from the assessment. The pilot ends with a decision to continue, change or stop.</>,
  },
  {
    q: 'Is there a contract?',
    a: <>The assessment is a one-time fee. Monthly management has an initial term of {catalog.pricing.management.initialTermMonths} months, then month to month. Website Improvement is a one-time {money(catalog.pricing.website.price)} with no retainer.</>,
  },
  {
    q: 'Who sees our client data?',
    a: <>Only what the specific service requires, under a signed <Link to="/baa">Business Associate Agreement</Link>. Every change is logged, and reads of client records are logged on the dashboard, report and action pages. Staffing services (applicants, check-ins, credentials) touch no client records at all.</>,
  },
  {
    q: 'Which agencies and states do you work with?',
    a: <>Home care agencies first: Medicaid waiver and private pay, keeping their current systems. Other small healthcare practices by conversation. Correction deadlines and payer rules are configured per program, payer and state, and recorded with their source.</>,
  },
]

export function FAQ() {
  return (
    <section id="faq">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Questions</span>
          <h2 className="two-tone">
            <span className="grey">Before</span><br />
            <span className="white">you reach out.</span>
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
