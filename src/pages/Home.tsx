import { useEffect, useState, type ReactNode } from 'react'
import { BRAND } from '../lib/brand'
import { WaitlistSection } from '../components/WaitlistSection'
import { useSeo } from '../hooks/useSeo'

export default function Home() {
  useSeo({
    title: `${BRAND} — More clients. More aides. Fewer missed visits.`,
    description:
      'Operations and technology for Medicaid home care and DODD agencies. We build and run the systems that answer your referrals, hire your aides, and protect every visit from an EVV or authorization denial.',
  })
  return (
    <>
      <Hero />
      <FourVoices />
      <ThreeDoors />
      <Menu />
      <HowWeWork />
      <WhyDeploi />
      <Pricing />
      <FAQ />
      <WaitlistSection />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero + live board                                                         */
/* -------------------------------------------------------------------------- */
type Task = { ts: string; text: string }
type Lane = {
  id: string
  label: string
  script: string[]
  completed: Task[]
}

const INITIAL_LANES: Lane[] = [
  {
    id: 'referrals',
    label: 'Referrals',
    script: [
      'new referral from Franklin Co. case manager · confirming capacity',
      'intake packet sent to family · follow-up set for Thu',
      'private-pay inquiry (web form) · calling back now',
    ],
    completed: [
      { ts: '07:42', text: 'AAA referral answered · capacity confirmed in 6 min' },
      { ts: '07:15', text: 'start-of-care follow-up sent to case manager' },
    ],
  },
  {
    id: 'staffing',
    label: 'Staffing',
    script: [
      'applicant texted back · screening 4 questions',
      'interview booked · Tue 10:00a · reminder scheduled',
      'STNA renewal due in 21 days · flagged to admin',
    ],
    completed: [
      { ts: '07:38', text: '2 applicants screened + booked · avg 8 min' },
      { ts: '07:05', text: '60-day check-in sent to 3 aides' },
    ],
  },
  {
    id: 'visits',
    label: 'Visits',
    script: [
      'call-off: Mon 8a shift · offering to 5 qualified aides',
      'EVV exception: clock-out missing · fixing in window',
      'auth 82% used · re-auth reminder sent to scheduler',
    ],
    completed: [
      { ts: '07:31', text: 'open shift filled · family confirmed' },
      { ts: '06:58', text: '3 EVV exceptions corrected before billing' },
    ],
  },
]

function Hero() {
  const [lanes, setLanes] = useState<Lane[]>(INITIAL_LANES)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let round = 0
    const timer = window.setInterval(() => {
      setLanes(prev => {
        const idx = round % prev.length
        round += 1
        return prev.map((lane, i) => {
          if (i !== idx) return lane
          const [head, ...rest] = lane.script
          if (!head) return lane
          const now = new Date()
          const hh = String(now.getHours()).padStart(2, '0')
          const mm = String(now.getMinutes()).padStart(2, '0')
          const done: Task = { ts: `${hh}:${mm}`, text: head }
          const nextScript = rest.length > 0 ? rest : [...INITIAL_LANES[i].script]
          return { ...lane, script: nextScript, completed: [done, ...lane.completed].slice(0, 2) }
        })
      })
    }, 2800)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <section id="top" className="hero">
      <div className="container hero-inner">
        <div className="hero-copy">
          <span className="tag outline reveal">Operations &amp; technology for Medicaid home care</span>
          <h1 className="reveal d1">
            More clients.<br />
            More aides.<br />
            <span className="accent">Fewer missed visits.</span>
          </h1>
          <p className="hero-sub reveal d2">
            {BRAND} builds and runs the systems that answer your referrals, hire your aides, and
            protect every visit from an EVV or authorization denial. You see it all on your own
            dashboard, every morning.
          </p>
          <div className="hero-actions reveal d3">
            <a href="#waitlist" className="btn btn-primary">
              Book a 20-minute call
              <span className="arrow" aria-hidden="true">→</span>
            </a>
            <a href="#what" className="btn btn-ghost">See what we run</a>
          </div>
          <div className="hero-trust reveal d4">
            <span>HIPAA · BAA signed before any client data</span>
            <span>Built for PASSPORT, waiver, MyCare and DODD agencies</span>
            <span>Ohio today, other states as we go</span>
          </div>
        </div>

        <div className="board reveal d2" aria-hidden="true">
          <div className="board-head">
            <span>Morning report</span>
            <span className="live">Live</span>
          </div>
          {lanes.map(lane => (
            <div className="board-row" key={lane.id}>
              <div className="board-label">{lane.label}</div>
              <div className="board-tasks">
                <div className="task active" key={lane.script[0]}>
                  <span className="ts">now</span>
                  <span>{lane.script[0]}<span className="caret" /></span>
                </div>
                {lane.completed.map((t, i) => (
                  <div className="task" key={`${t.ts}-${i}`}>
                    <span className="ts">{t.ts}</span>
                    <span className="check">✓</span>
                    <span>{t.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
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
    <section id="problem">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The problem</span>
          <h2>Four people. One leak.</h2>
          <p className="lead">
            Every missed referral, open shift and voided claim starts the same way: nobody answered
            fast enough.
          </p>
        </div>
        <div className="grid4">
          {voices.map((v, i) => (
            <div className={`block voice reveal d${(i % 4) + 1}`} key={v.who}>
              <div className="num">{String(i + 1).padStart(2, '0')}</div>
              <h3>{v.who}</h3>
              <p className="body">{v.quote}</p>
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
function ThreeDoors() {
  const doors = [
    {
      tag: 'Growth',
      title: 'Win more referrals',
      points: [
        'Case-manager referrals answered in minutes, capacity confirmed',
        'Follow-up when care starts, so they refer again',
        'Private-pay inquiries called back before the next agency',
      ],
    },
    {
      tag: 'Staffing',
      title: 'Hire and keep more aides',
      points: [
        'Applicants screened and interview-booked in under 10 minutes',
        '30/60/90-day check-ins that catch a quit before it happens',
        'Credentials tracked, lapses flagged before they void a claim',
      ],
    },
    {
      tag: 'Operations',
      title: 'Keep every visit, and get paid for it',
      points: [
        'Open shifts offered to qualified aides automatically',
        'EVV exceptions fixed inside the correction window',
        'Authorization units watched so care never outruns the auth',
      ],
    },
  ]
  return (
    <section id="what" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">What we do</span>
          <h2>Three doors. One engine behind them.</h2>
          <p className="lead">
            We watch your inbox, phone line, scheduler and EVV for the moments that matter, act
            within minutes, and report back every morning.
          </p>
        </div>
        <div className="grid3">
          {doors.map((d, i) => (
            <div className={`block door reveal d${i + 1}`} key={d.tag}>
              <span className="tag">{d.tag}</span>
              <h3>{d.title}</h3>
              <ul className="list">
                {d.points.map(p => <li key={p}>{p}</li>)}
              </ul>
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
function Menu() {
  const items: { group: 'Growth' | 'Staffing' | 'Operations' | 'Money · later'; name: string; body: string }[] = [
    { group: 'Growth', name: 'Referral response', body: 'Minutes, not hours. Capacity confirmed, intake started.' },
    { group: 'Growth', name: 'Private-pay leads + reviews', body: 'Every inquiry answered. Every happy family asked for a review.' },
    { group: 'Growth', name: 'Referral-source nurturing', body: 'Monthly touch to the case managers and discharge planners who feed you.' },
    { group: 'Staffing', name: 'Instant hiring', body: 'Applicants texted, screened and booked while they’re still interested.' },
    { group: 'Staffing', name: 'Retention', body: 'Shift reminders, 30/60/90 check-ins, early warning before a quit.' },
    { group: 'Staffing', name: 'Credential tracking', body: 'STNA, CPR, annual training, background rechecks, flagged before they lapse.' },
    { group: 'Operations', name: 'Open-shift fill', body: 'Call-offs pushed to qualified aides, families confirmed, late alerts sent.' },
    { group: 'Operations', name: 'Authorization watch', body: 'Units used vs. authorized, expirations, re-auth reminders.' },
    { group: 'Operations', name: 'After-hours line', body: 'Calls answered and logged. On-call reached. Owner woken only when it matters.' },
    { group: 'Operations', name: 'EVV exception layer', body: 'Visits checked against EVV and the auth, fixed before they reach billing.' },
    { group: 'Money · later', name: 'Denial cleanup + managed billing', body: 'Once the operations are clean, we can run the money too.' },
  ]
  const tagClass = (g: string) => (g === 'Growth' ? 'tag green' : g.startsWith('Money') ? 'tag gold' : 'tag')
  return (
    <section id="menu">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The full menu</span>
          <h2>Start with one leak. Add the rest on the retainer.</h2>
          <p className="lead">
            Eleven services, four groups, the same engine. You never buy all eleven; you buy the one
            losing you the most money this month.
          </p>
        </div>
        <div className="grid4">
          {items.map((it, i) => (
            <div className={`block dark menu-item reveal d${(i % 4) + 1}`} key={it.name}>
              <span className={tagClass(it.group)}>{it.group}</span>
              <h3>{it.name}</h3>
              <p className="body">{it.body}</p>
            </div>
          ))}
          <div className="block accent menu-item cta reveal d4">
            <h3>Not sure which leak is biggest?</h3>
            <a href="#waitlist">Start with the assessment →</a>
          </div>
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
    <section id="how" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">How we work</span>
          <h2>Assess. Build. Run.</h2>
        </div>
        <div className="grid3">
          {steps.map((s, i) => (
            <div className={`block reveal d${i + 1}`} key={s.n}>
              <div className="num green">{s.n}</div>
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
/*  Why Deploi                                                                */
/* -------------------------------------------------------------------------- */
function WhyDeploi() {
  return (
    <section id="why">
      <div className="container why-grid">
        <div className="section-head reveal">
          <span className="eyebrow">Why {BRAND}</span>
          <h2>We know the rules you bill under.</h2>
        </div>
        <ul className="list reveal d1">
          <li>
            Medicaid waiver, EVV, authorizations and case-manager workflows are our starting point,
            not something we learn on your dime. Ohio PASSPORT, Ohio Home Care Waiver, MyCare, DODD
            and Sandata today; other states as we go.
          </li>
          <li>
            HIPAA from day one. A Business Associate Agreement is signed before we touch a single
            client record.
          </li>
          <li>
            Your systems stay. We sit on top of the scheduler, EVV and phone line you already pay
            for.
          </li>
          <li>A named founder answers the phone. No account manager, no ticket queue.</li>
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
      name: 'Operations Assessment',
      price: '$1,500–2,500',
      per: '',
      body: 'One referral and one visit traced end to end. Report with your three biggest leaks priced in dollars. Credited toward the build.',
      featured: false,
    },
    {
      step: 'Step 2',
      name: 'Build',
      price: '$3,000–7,000',
      per: '',
      body: 'Per door. One service set up, connected to your systems, with a how-to guide and 30 days of fixes included.',
      featured: false,
    },
    {
      step: 'Step 3',
      name: 'Run',
      price: '$500–1,500',
      per: '/mo',
      body: 'We run it, report every morning, and add doors as your problems show up. Three-month minimum, month-to-month after.',
      featured: true,
    },
  ]
  return (
    <section id="pricing" className="alt">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Pricing</span>
          <h2>Fixed assessment. Then setup plus a monthly retainer.</h2>
          <p className="lead">Published ranges, so you know before the call whether we fit.</p>
        </div>
        <div className="grid3">
          {tiers.map((t, i) => (
            <div className={`block reveal d${i + 1} ${t.featured ? 'outlined' : ''}`} key={t.name}>
              <span className={`tag ${t.featured ? 'green' : ''}`}>{t.step}</span>
              <h3>{t.name}</h3>
              <div className="price">
                {t.price}
                {t.per && <span className="per"> {t.per}</span>}
              </div>
              <p className="body">{t.body}</p>
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
function FAQ() {
  const faqs: { q: string; a: ReactNode }[] = [
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
  return (
    <section id="faq">
      <div className="container why-grid">
        <div className="section-head reveal">
          <span className="eyebrow">Questions</span>
          <h2>Before you book</h2>
        </div>
        <div className="faq-list reveal d1">
          {faqs.map(f => (
            <details className="faq-item" key={f.q}>
              <summary>
                <span className="faq-q">{f.q}</span>
                <span className="faq-chevron" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
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
