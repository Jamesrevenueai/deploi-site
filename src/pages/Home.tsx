import type { ReactNode } from 'react'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { BookButton } from '../components/Button'
import { ImageCard } from '../components/ImageCard'
import { BookSection } from '../components/BookSection'
import { Icon } from '../lib/icons'

export default function Home() {
  useSeo({
    title: `${BRAND} — More clients. More aides. Fewer missed visits.`,
    description:
      'Operations and technology for Medicaid home care and DODD agencies. We build and run the systems that answer your referrals, hire your aides, and protect every visit from an EVV or authorization denial.',
  })
  return (
    <div className="home">
      <Hero />
      <FourVoices />
      <ThreeDoors />
      <Menu />
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
      <div className="container hero-inner">
        <span className="eyebrow reveal">Operations &amp; technology for Medicaid home care</span>
        <h1 className="two-tone reveal">
          <span className="grey">More clients.</span><br />
          <span className="grey">More aides.</span><br />
          <span className="white">Fewer missed visits.</span>
        </h1>
        <p className="lead reveal" style={{ maxWidth: 640 }}>
          {BRAND} builds and runs the systems that answer your referrals, hire your aides, and
          protect every visit from an EVV or authorization denial. You see it all on your own
          dashboard, every morning.
        </p>
        <div className="reveal">
          <BookButton>Book a call</BookButton>
        </div>
        <div className="hero-trust reveal">
          <span>HIPAA · BAA signed before any client data</span>
          <span>Built for PASSPORT, waiver, MyCare and DODD agencies</span>
          <span>Ohio today, other states as we go</span>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Four voices                                                               */
/* -------------------------------------------------------------------------- */
function FourVoices() {
  const voices = [
    { who: 'The owner', quote: '“I found out we lost the referral when the case manager stopped calling.”' },
    { who: 'The scheduler', quote: '“Three call-offs by 7 a.m. and I’m texting aides one at a time.”' },
    { who: 'The aide', quote: '“I applied Tuesday. Nobody called me back until the following week.”' },
    { who: 'The biller', quote: '“The visit happened. The EVV didn’t match. The claim still didn’t pay.”' },
  ]
  return (
    <section id="problem" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The problem</span>
          <h2 className="two-tone">
            <span className="grey">Four people.</span><br />
            <span className="white">One leak.</span>
          </h2>
          <p className="lead">
            Every missed referral, open shift and voided claim starts the same way: nobody answered
            fast enough.
          </p>
        </div>
        <div className="voices">
          {voices.map(v => (
            <div className="voice reveal" key={v.who}>
              <div className="who">{v.who}</div>
              <p className="quote">{v.quote}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Three doors                                                               */
/* -------------------------------------------------------------------------- */
const DOOR_FACTS: [{ icon: ReactNode; label: string }, { icon: ReactNode; label: string }] = [
  { icon: <Icon.Clock />, label: 'Live in weeks' },
  { icon: <Icon.Link />, label: 'Your systems stay' },
]

function ThreeDoors() {
  const doors = [
    { tag: 'Growth', icon: <Icon.Inbox />, title: 'Win more referrals', to: '/#menu' },
    { tag: 'Staffing', icon: <Icon.Users />, title: 'Hire and keep more aides', to: '/#menu' },
    { tag: 'Operations', icon: <Icon.Shield />, title: 'Keep every visit, and get paid for it', to: '/evv' },
  ]
  return (
    <section id="what">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">What we do</span>
          <h2 className="two-tone">
            <span className="grey">Three doors.</span><br />
            <span className="white">One engine behind them.</span>
          </h2>
          <p className="lead">
            We watch your inbox, phone line, scheduler and EVV for the moments that matter, act
            within minutes, and report back every morning.
          </p>
        </div>
        <div className="card-grid three">
          {doors.map(d => (
            <div className="reveal" key={d.tag}>
              <ImageCard tag={d.tag} tagIcon={d.icon} title={d.title} facts={DOOR_FACTS} to={d.to} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Full menu                                                                 */
/* -------------------------------------------------------------------------- */
export const MENU_ITEMS: { group: 'Growth' | 'Staffing' | 'Operations' | 'Money · later'; name: string; body: string; to?: string }[] = [
  { group: 'Growth', name: 'Referral response', body: 'Minutes, not hours. Capacity confirmed, intake started.' },
  { group: 'Growth', name: 'Private-pay leads + reviews', body: 'Every inquiry answered. Every happy family asked for a review.' },
  { group: 'Growth', name: 'Referral-source nurturing', body: 'Monthly touch to the case managers and discharge planners who feed you.' },
  { group: 'Staffing', name: 'Instant hiring', body: 'Applicants texted, screened and booked while they’re still interested.' },
  { group: 'Staffing', name: 'Retention', body: 'Shift reminders, 30/60/90 check-ins, early warning before a quit.' },
  { group: 'Staffing', name: 'Credential tracking', body: 'STNA, CPR, annual training, background rechecks, flagged before they lapse.' },
  { group: 'Operations', name: 'Open-shift fill', body: 'Call-offs pushed to qualified aides, families confirmed, late alerts sent.' },
  { group: 'Operations', name: 'Authorization watch', body: 'Units used vs. authorized, expirations, re-auth reminders.' },
  { group: 'Operations', name: 'After-hours line', body: 'Calls answered and logged. On-call reached. Owner woken only when it matters.' },
  { group: 'Operations', name: 'EVV exception layer', body: 'Visits checked against EVV and the auth, fixed before they reach billing.', to: '/evv' },
  { group: 'Money · later', name: 'Denial cleanup + managed billing', body: 'Once the operations are clean, we can run the money too.' },
]

const GROUP_ICON: Record<string, ReactNode> = {
  Growth: <Icon.Inbox />,
  Staffing: <Icon.Users />,
  Operations: <Icon.Shield />,
  'Money · later': <Icon.Dollar />,
}

function Menu() {
  return (
    <section id="menu" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The full menu</span>
          <h2 className="two-tone">
            <span className="grey">Start with one leak.</span><br />
            <span className="white">Add the rest on the retainer.</span>
          </h2>
          <p className="lead">
            Eleven services, four groups, the same engine. You never buy all eleven; you buy the one
            losing you the most money this month.
          </p>
        </div>
        <div className="card-grid">
          {MENU_ITEMS.map(it => (
            <div className="reveal" key={it.name}>
              <ImageCard
                tag={it.group}
                tagIcon={GROUP_ICON[it.group]}
                tagMuted={it.group === 'Money · later'}
                title={it.name}
                body={it.body}
                to={it.to}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  How we work                                                               */
/* -------------------------------------------------------------------------- */
function HowWeWork() {
  const steps = [
    {
      n: '1',
      title: 'Assessment',
      body: 'We walk one referral and one visit from first contact to paid claim and show you, in dollars, where it leaks. Fixed fee, credited toward the build.',
    },
    {
      n: '2',
      title: 'Build',
      body: 'We build the piece that fixes the biggest leak, connected to the scheduler and EVV you already use. No rip-and-replace. Live in weeks.',
    },
    {
      n: '3',
      title: 'Run',
      body: 'We run it monthly, add the next door when you’re ready, and send a morning report: referrals answered, shifts filled, exceptions fixed, units left.',
    },
  ]
  return (
    <section id="how">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">How we work</span>
          <h2 className="two-tone">
            <span className="grey">Assess. Build.</span><br />
            <span className="white">Run.</span>
          </h2>
        </div>
        <div className="steps">
          {steps.map(s => (
            <div className="step reveal" key={s.n}>
              <div className="num" aria-hidden="true">{s.n}</div>
              <h3>{s.title}</h3>
              <p className="body">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Morning report card                                                       */
/* -------------------------------------------------------------------------- */
const LANES = [
  {
    label: 'Referrals',
    icon: <Icon.Inbox />,
    tasks: [
      { ts: 'now', text: 'new referral from Franklin Co. case manager · confirming capacity', active: true },
      { ts: '07:42', text: 'AAA referral answered · capacity confirmed in 6 min' },
      { ts: '07:15', text: 'start-of-care follow-up sent to case manager' },
    ],
  },
  {
    label: 'Staffing',
    icon: <Icon.Users />,
    tasks: [
      { ts: 'now', text: 'applicant texted back · screening 4 questions', active: true },
      { ts: '07:38', text: '2 applicants screened + booked · avg 8 min' },
      { ts: '07:05', text: '60-day check-in sent to 3 aides' },
    ],
  },
  {
    label: 'Visits',
    icon: <Icon.Shield />,
    tasks: [
      { ts: 'now', text: 'call-off: Mon 8a shift · offering to 5 qualified aides', active: true },
      { ts: '07:31', text: 'open shift filled · family confirmed' },
      { ts: '06:58', text: '3 EVV exceptions corrected before billing' },
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
        </div>
        <div className="card-grid single reveal">
          <ImageCard tag="Live" tagIcon={<Icon.Clock />} title="Your morning report" className="report-card">
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
  return (
    <section id="why">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Why {BRAND}</span>
          <h2 className="two-tone">
            <span className="grey">We know the rules</span><br />
            <span className="white">you bill under.</span>
          </h2>
        </div>
        <ul className="why-list reveal">
          <li>
            <strong>Medicaid is the starting point, not a lesson on your dime.</strong> Waiver, EVV,
            authorizations and case-manager workflows: Ohio PASSPORT, Ohio Home Care Waiver, MyCare,
            DODD and Sandata today; other states as we go.
          </li>
          <li>
            <strong>HIPAA from day one.</strong> A Business Associate Agreement is signed before we
            touch a single client record.
          </li>
          <li>
            <strong>Your systems stay.</strong> We sit on top of the scheduler, EVV and phone line
            you already pay for.
          </li>
          <li>
            <strong>A named founder answers the phone.</strong> No account manager, no ticket queue.
          </li>
        </ul>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                   */
/* -------------------------------------------------------------------------- */
function Pricing() {
  const tiers = [
    {
      step: 'Step 1',
      price: '$1,500–2,500',
      body: 'Operations Assessment. One referral and one visit traced end to end. Report with your three biggest leaks priced in dollars. Credited toward the build.',
      featured: false,
    },
    {
      step: 'Step 2',
      price: '$3,000–7,000',
      body: 'Build, per door. One service set up, connected to your systems, with a how-to guide and 30 days of fixes included.',
      featured: false,
    },
    {
      step: 'Step 3',
      price: '$500–1,500 /mo',
      body: 'Run. We run it, report every morning, and add doors as your problems show up. Three-month minimum, month-to-month after.',
      featured: true,
    },
  ]
  return (
    <section id="pricing" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Pricing</span>
          <h2 className="two-tone">
            <span className="grey">Fixed assessment.</span><br />
            <span className="white">Then setup plus a monthly retainer.</span>
          </h2>
          <p className="lead">Published ranges, so you know before the call whether we fit.</p>
        </div>
        <div className="card-grid three">
          {tiers.map(t => (
            <div className="reveal" key={t.step}>
              <ImageCard tag={t.step} tagIcon={<Icon.Tag />} title={t.price} body={t.body} featured={t.featured} />
            </div>
          ))}
        </div>
        <p className="pricing-footnote reveal">
          Every client starts with the assessment, gets one door built, and adds doors on the retainer.
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
    q: 'Do we have to change our scheduler or EVV?',
    a: <>No. We connect to what you already use. If a system can&rsquo;t connect, we tell you in the assessment, not after.</>,
  },
  {
    q: 'Is there a contract?',
    a: <>The assessment is a one-time fee. The retainer has a three-month minimum, then month-to-month.</>,
  },
  {
    q: 'How soon can we start?',
    a: <>Assessment within two weeks of booking. First build live within four to six weeks after that.</>,
  },
  {
    q: 'Who sees our client data?',
    a: <>Only what the work requires, under a signed BAA, with access logged. Staff-side services (hiring, credentials) touch no client records at all.</>,
  },
  {
    q: 'Are you only in Ohio?',
    a: <>Ohio is where we started and know deepest. Hiring and referral services work in any state today; operations services expand state by state.</>,
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
            <span className="white">you book.</span>
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
