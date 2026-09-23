import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { miniAuditUrl } from '../lib/ctaUrls'
import { WaitlistSection } from '../components/WaitlistSection'
import { useSeo } from '../hooks/useSeo'

export default function Home() {
  useSeo({
    title: `${BRAND} — We deploy your AI and keep it running`,
    description:
      'AI implementation, training, and ongoing management for small businesses. Private, local, and managed for you every month.',
  })
  return (
    <>
      <Hero />
      <FourWays />
      <SavingsCalculator />
      <Problem />
      <Workers />
      <HowItWorks />
      <Founder />
      <Managed />
      <Private />
      <UseCases />
      <Pricing />
      <FAQ />
      <WaitlistSection />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero — unchanged from v2                                                  */
/* -------------------------------------------------------------------------- */
type Task = { ts: string; text: string }
type Worker = {
  id: string
  name: string
  role: string
  led: 'green' | 'blue' | 'amber'
  script: string[]
  completed: Task[]
}

const INITIAL_WORKERS: Worker[] = [
  {
    id: 'frontdesk',
    name: 'frontdesk-01',
    role: 'clinic · front desk',
    led: 'green',
    script: [
      'drafting appt confirmation → C. Reyes',
      'answering: does insurance cover ultrasound?',
      'rescheduling: Kim, S. → Thu 3:15p',
      'flagging voicemail → billing question',
    ],
    completed: [
      { ts: '09:12', text: 'booked new-patient intake · Tue 10:00a' },
      { ts: '09:14', text: 'confirmed 3 appts for tomorrow' },
    ],
  },
  {
    id: 'quotes',
    name: 'quotes-04',
    role: 'contractor · estimates',
    led: 'amber',
    script: [
      'reading new lead: kitchen remodel · Bexley',
      'pulling materials cost from vendor sheet',
      'drafting quote · $18,400 est.',
      'scheduling site visit → Fri 8:30a',
    ],
    completed: [{ ts: '09:08', text: 'sent 2 revised quotes to Hartman & Sons' }],
  },
  {
    id: 'support',
    name: 'support-02',
    role: 'e-commerce · support',
    led: 'blue',
    script: [
      'reading ticket #4092: where is my order',
      'checking Shopify: shipped Mon · tracking pulled',
      'drafting reply w/ tracking + ETA',
      'closing ticket #4091: refund confirmed',
    ],
    completed: [{ ts: '09:11', text: 'answered 6 tickets · avg 42s' }],
  },
]

function Hero() {
  const [workers, setWorkers] = useState<Worker[]>(INITIAL_WORKERS)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let round = 0
    const timer = window.setInterval(() => {
      setWorkers(prev => {
        const idx = round % prev.length
        round += 1
        return prev.map((w, i) => {
          if (i !== idx) return w
          const [head, ...rest] = w.script
          if (!head) return w
          const now = new Date()
          const hh = String(now.getHours()).padStart(2, '0')
          const mm = String(now.getMinutes()).padStart(2, '0')
          const done: Task = {
            ts: `${hh}:${mm}`,
            text: head.replace(
              /^drafting |^reading |^scheduling |^pulling |^answering: |^checking .+?: |^rescheduling: |^flagging /,
              '',
            ),
          }
          const nextScript = rest.length > 0 ? rest : [...INITIAL_WORKERS[i].script]
          const nextCompleted = [done, ...w.completed].slice(0, 3)
          return { ...w, script: nextScript, completed: nextCompleted }
        })
      })
    }, 2600)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <section id="top" className="hero-v2">
      <div className="v2-inner">
        <div className="v2-copy">
          <div className="v2-eyebrow reveal">
            <span className="pulse" aria-hidden="true"></span>
            Private AI · managed for you
          </div>
          <h1 className="reveal d1">
            We deploy your AI —<br />
            and <span className="accent">keep it running.</span>
          </h1>
          <p className="v2-sub reveal d2">
            A hands-on AI team for small businesses. We stand up AI workers on your own data,
            wired to the tools you already use — and monitor, retrain, and report on them every
            month so they keep working long after we go live.
          </p>
          <div className="v2-actions reveal d3">
            <Link to="/audit" className="v2-primary">
              Get an AI Audit
              <span className="arrow" aria-hidden="true">→</span>
            </Link>
            <div className="v2-trust">
              PRIVATE
              <span className="sep" aria-hidden="true"></span>
              LOCAL
              <span className="sep" aria-hidden="true"></span>
              MONITORED
            </div>
          </div>
        </div>

        <div className="v2-workers reveal d2" aria-hidden="true">
          {workers.map(w => <WorkerCard key={w.id} worker={w} />)}
        </div>
      </div>
    </section>
  )
}

function WorkerCard({ worker }: { worker: Worker }) {
  const ledColor =
    worker.led === 'green' ? 'var(--status-green)' :
    worker.led === 'amber' ? 'var(--status-amber)' :
    'var(--status-blue)'
  const active = worker.script[0]
  return (
    <div className="worker-card">
      <div className="worker-head">
        <div className="worker-identity">
          <span
            className="worker-led"
            style={{ '--led-color': ledColor, color: ledColor } as CSSProperties}
          />
          <span className="worker-name">{worker.name}</span>
        </div>
        <span className="worker-role">{worker.role}</span>
      </div>
      <div className="worker-tasks">
        {active && (
          <div className="task active" key={active}>
            <span className="ts">now</span>
            <span>{active}<span className="caret" aria-hidden="true"></span></span>
          </div>
        )}
        {worker.completed.map((t, i) => (
          <div className="task" key={`${t.ts}-${i}`}>
            <span className="ts">{t.ts}</span>
            <span className="check" aria-hidden="true">✓</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Four ways we help                                                         */
/* -------------------------------------------------------------------------- */
function FourWays() {
  const cards = [
    {
      to: '/plan',
      eyebrow: '01',
      title: 'Plan it',
      body: 'Figure out where AI actually pays off in your business — with a written plan you can hand to anyone.',
    },
    {
      to: '/build',
      eyebrow: '02',
      title: 'Build it',
      body: 'We set up the AI workers you need, inside the tools you already use.',
    },
    {
      to: '/train',
      eyebrow: '03',
      title: 'Train your team',
      body: 'Live cohort courses and workshops so your team can run AI themselves.',
    },
    {
      to: '/run',
      eyebrow: '04',
      title: 'Run it for me',
      body: 'Managed AI workers — monitored, retrained, and reported on every month.',
    },
  ]
  return (
    <section id="ways">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Four ways we help</span>
          <h2>Pick the door that fits.</h2>
        </div>
        <div className="ways-grid">
          {cards.map((c, i) => (
            <Link to={c.to} className={`way-card reveal d${(i % 4) + 1}`} key={c.to}>
              <div className="way-num">{c.eyebrow}</div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              <div className="way-arrow" aria-hidden="true">→</div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Savings calculator                                                        */
/* -------------------------------------------------------------------------- */
function SavingsCalculator() {
  const [hours, setHours] = useState(10)
  const [rate, setRate] = useState(25)
  const [pct, setPct] = useState(40)

  const { savedHours, savedDollars } = useMemo(() => {
    const savedHours = hours * (pct / 100)
    const savedDollars = savedHours * rate * 50
    return { savedHours, savedDollars }
  }, [hours, rate, pct])

  const fmt$ = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  return (
    <section id="calculator" className="calc">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Savings calculator</span>
          <h2>How much time could AI actually give you back?</h2>
          <p>Rough numbers. Estimate only. Move the sliders to see your own.</p>
        </div>
        <div className="calc-grid reveal d1">
          <div className="calc-inputs">
            <div className="calc-row">
              <label htmlFor="calc-hours">Hours per week on repetitive admin</label>
              <div className="calc-value">{hours} hrs</div>
              <input
                id="calc-hours"
                type="range"
                min={0}
                max={40}
                value={hours}
                onChange={e => setHours(Number(e.target.value))}
              />
            </div>
            <div className="calc-row">
              <label htmlFor="calc-rate">Hourly cost of that work</label>
              <div className="calc-value">${rate}/hr</div>
              <input
                id="calc-rate"
                type="range"
                min={15}
                max={125}
                step={5}
                value={rate}
                onChange={e => setRate(Number(e.target.value))}
              />
            </div>
            <div className="calc-row">
              <label htmlFor="calc-pct">% AI could reasonably handle</label>
              <div className="calc-value">{pct}%</div>
              <input
                id="calc-pct"
                type="range"
                min={0}
                max={100}
                value={pct}
                onChange={e => setPct(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="calc-output">
            <div className="calc-out-row">
              <div className="calc-out-label">Hours saved per week</div>
              <div className="calc-out-num">{savedHours.toFixed(1)}</div>
            </div>
            <div className="calc-out-row">
              <div className="calc-out-label">Estimated yearly savings</div>
              <div className="calc-out-num accent">{fmt$(savedDollars)}</div>
            </div>
            <div className="calc-disclaimer">Estimate only. Not a guarantee.</div>
            <a
              href={miniAuditUrl()}
              className="v2-primary calc-cta"
              target={miniAuditUrl().startsWith('#') ? undefined : '_blank'}
              rel={miniAuditUrl().startsWith('#') ? undefined : 'noopener noreferrer'}
            >
              Get your real number — book a free mini-audit
              <span className="arrow" aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Problem                                                                   */
/* -------------------------------------------------------------------------- */
function Problem() {
  return (
    <section>
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The problem</span>
          <h2>AI works. Building it &mdash; and keeping it working &mdash; doesn't.</h2>
        </div>
        <p className="problem-body reveal d1">
          Every small business owner knows they should be using AI. Almost none of them can
          actually build it. <strong>And even the ones who can, can't babysit it.</strong>{' '}
          Models drift. Data changes. New releases ship every week. The consultant who set it up
          is long gone. So the AI sits there, silently getting worse, until it's quietly turned off.
          <span className="closer">{BRAND} exists to fix both halves.</span>
        </p>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Workers                                                                   */
/* -------------------------------------------------------------------------- */
function Workers() {
  const roles = [
    {
      name: 'Front desk',
      body: 'Answers calls, texts, and website chats 24/7. Books, reschedules, and confirms appointments. Handles your top questions: hours, location, insurance, pricing. Never miss an after-hours lead again.',
    },
    {
      name: 'Inbox & lead follow-up',
      body: 'Sorts incoming email, replies to routine questions, and chases every new lead until they book or opt out. Turns "I’ll get to it later" into same-day follow-up.',
    },
    {
      name: 'Quotes & intake',
      body: 'Collects what a job needs (address, scope, photos), qualifies the request, and books a callback or estimate. Filters the tire-kickers, surfaces the real jobs.',
    },
    {
      name: 'Scheduling & reminders',
      body: 'Fills your calendar, sends reminders, and cuts no-shows with confirmations and easy rebooking.',
    },
  ]
  return (
    <section id="workers">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">The workers</span>
          <h2>What your AI workers actually do.</h2>
          <p>
            Not chatbots. Workers that handle real tasks end to end &mdash; answer, book,
            follow up &mdash; and only hand off to you when a human is actually needed.
          </p>
        </div>
        <div className="worker-tiles">
          {roles.map((r, i) => (
            <div className={`worker-tile reveal d${(i % 4) + 1}`} key={r.name}>
              <div className="worker-tile-num">{String(i + 1).padStart(2, '0')}</div>
              <h3>{r.name}</h3>
              <p>{r.body}</p>
            </div>
          ))}
        </div>
        <p className="workers-closing reveal">
          Every worker runs on <strong>your data</strong>, monitored and improved by us every month
          &mdash; so it gets sharper over time, not stale.
        </p>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  How it works                                                              */
/* -------------------------------------------------------------------------- */
function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Assess your workflows',
      body: 'We sit down with your team and map the work that eats hours. Front-desk, scheduling, quoting, support, intake. We find the pieces that AI can actually handle.',
    },
    {
      n: '02',
      title: 'Implement your AI workers',
      body: 'We build and deploy AI workers on your own data, wired to the tools you already use — your CRM, inbox, scheduler, PMS. Go-live in weeks, not quarters.',
    },
    {
      n: '03',
      title: 'We monitor, retrain & report',
      body: 'The part every other consultant skips. We watch performance, retrain on your latest data, swap in better models as they ship, and send you a report every month.',
    },
  ]
  return (
    <section>
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">How it works</span>
          <h2>Set up. Kept up.</h2>
        </div>
        <div className="steps">
          {steps.map((s, i) => (
            <div className={`step reveal d${i + 1}`} key={s.n}>
              <div className="step-num">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Founder                                                                   */
/* -------------------------------------------------------------------------- */
function Founder() {
  return (
    <section id="founder" className="founder">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Who's behind {BRAND}</span>
          <h2>Built by someone who runs a business on AI.</h2>
        </div>
        <div className="founder-grid reveal d1">
          <div className="founder-photo">
            {/* Drop /public/founder.jpg to swap the placeholder for a real photo. */}
            <div className="founder-photo-fallback" aria-hidden="true">
              <span>J</span>
            </div>
          </div>
          <div className="founder-copy">
            <div className="founder-name">James</div>
            <p>
              I run my own company, ClaimYours AI, with a team of AI employees handling real work
              every day. {BRAND} sets up the same thing for your business, and then keeps it running.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Managed pillars                                                           */
/* -------------------------------------------------------------------------- */
function Managed() {
  const pillars = [
    {
      title: 'Monitoring',
      body: 'We watch every AI worker in production — accuracy, latency, refusals, weird outputs. If it starts to slip, we know before you do.',
    },
    {
      title: 'Retraining',
      body: 'Your business changes. So does your data. We retrain on your latest examples so the AI keeps matching how you actually work today, not six months ago.',
    },
    {
      title: 'Model swapping',
      body: 'New open-source models ship every few weeks. When a better one is a clear upgrade, we swap it in — same behavior, better speed or cost or quality.',
    },
    {
      title: 'Reporting',
      body: 'A plain-English monthly report. What the AI handled, what it saved you, what we changed, and what we recommend next. No dashboard homework.',
    },
  ]
  return (
    <section>
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Managed, not delivered</span>
          <h2>Four things we do every month.</h2>
          <p>Most consultants set up and vanish. We keep the AI actually working &mdash; for the life of the engagement.</p>
        </div>
        <div className="pillars reveal d1">
          {pillars.map(p => (
            <div className="pillar" key={p.title}>
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
/*  Private by design                                                         */
/* -------------------------------------------------------------------------- */
function Private() {
  return (
    <section className="private">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Private by design</span>
          <h2>Your data stays your data.</h2>
        </div>
        <div className="private-grid">
          <div className="private-lede reveal d1">
            The AI runs <strong>locally, on your own data</strong> &mdash; not on someone else's cloud,
            not on a shared model, not on customer records piped to a third party.
            <span className="fine">
              It plugs into the tools your team already lives in and works from what you already have.
              If something sensitive doesn't need to leave your business, it doesn't.
            </span>
          </div>
          <ul className="trust-list reveal d2">
            <li>
              <IconLock />
              <div>
                <div className="label">On your data, not ours</div>
                <p>Models run locally against your files, your records, your systems. Nothing leaves without you deciding it should.</p>
              </div>
            </li>
            <li>
              <IconPlug />
              <div>
                <div className="label">Wired to what you already use</div>
                <p>Your inbox, your CRM, your scheduler, your PMS. The AI shows up where the work already happens.</p>
              </div>
            </li>
            <li>
              <IconShield />
              <div>
                <div className="label">No shared brains</div>
                <p>Your business's patterns train your business's AI &mdash; not someone else's model.</p>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Use cases                                                                 */
/* -------------------------------------------------------------------------- */
function UseCases() {
  const cases = [
    {
      role: 'Clinics',
      title: 'A front-desk AI that never misses a call',
      body: 'Books appointments, answers routine questions, and hands off cleanly when it matters — on your PMS, in your voice.',
    },
    {
      role: 'Contractors',
      title: 'Scheduling and quotes without the phone tag',
      body: 'Reads incoming leads, drafts quotes from your pricing rules, and books site visits against your real calendar.',
    },
    {
      role: 'E-commerce',
      title: 'A support inbox that clears itself',
      body: 'Reads every ticket, drafts an answer from your policies and order history, and escalates the ones that need a human.',
    },
    {
      role: 'Law offices',
      title: 'Intake that qualifies while you sleep',
      body: 'Runs new-client intake, gathers the facts you actually need, and pre-fills the matter so you start the case, not the paperwork.',
    },
  ]
  return (
    <section>
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Built for</span>
          <h2>Small businesses that need real hours back.</h2>
        </div>
        <div className="usecases">
          {cases.map((c, i) => (
            <div className={`usecase reveal d${(i % 4) + 1}`} key={c.role}>
              <div className="usecase-role">{c.role}</div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pricing — managed tier is now "Coming soon"                               */
/* -------------------------------------------------------------------------- */
function Pricing() {
  const tiers = [
    {
      name: 'Starter',
      price: '$400',
      sub: '1 AI worker',
      featured: false,
      features: [
        'Continuous monitoring',
        'Monthly reporting',
        'Model swaps as needed',
        'Email support',
      ],
    },
    {
      name: 'Growth',
      price: '$800',
      sub: 'Up to 3 AI workers',
      featured: true,
      features: [
        'Everything in Starter',
        'Active retraining on your data',
        'Biweekly reporting',
        'Priority support',
      ],
    },
    {
      name: 'Scale',
      price: '$1,200',
      sub: 'Up to 6 AI workers',
      featured: false,
      features: [
        'Full continuous monitoring',
        'Ongoing retraining + model swapping',
        'Weekly reporting',
        'Monthly strategy check-ins',
      ],
    },
  ]
  return (
    <section id="pricing">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Managed pricing</span>
          <h2>Coming soon — join the waitlist.</h2>
          <p>
            Managed AI workers launch once liability insurance is in place. Get on the waitlist to
            be first in line.
          </p>
        </div>
        <div className="tiers">
          {tiers.map((t, i) => (
            <div className={`tier reveal d${i + 1} ${t.featured ? 'featured' : ''}`} key={t.name}>
              <div className="tier-coming">Coming soon</div>
              {t.featured && <div className="tier-badge">Most chosen</div>}
              <div className="tier-name">{t.name}</div>
              <div className="tier-price">{t.price}<span className="per">/mo</span></div>
              <div className="tier-sub">{t.sub}</div>
              <ul>
                {t.features.map(f => <li key={f}>{f}</li>)}
              </ul>
              <a href="#waitlist" className="tier-cta">Join the waitlist →</a>
            </div>
          ))}
        </div>
        <div className="pricing-footnote reveal">
          Plus a one-time implementation fee per worker &mdash; <strong>Custom.</strong>
        </div>
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
      q: 'Do I need to be technical?',
      a: <>No &mdash; that&rsquo;s the whole point. We build, connect, and run your AI workers for you. You never touch a model, a prompt, or a line of code.</>,
    },
    {
      q: 'Do you need access to my systems?',
      a: <>Not for an audit. Setups are built inside your own accounts, and you own everything.</>,
    },
    {
      q: 'Is my business data safe?',
      a: <>Yes. Your workers can run on local, open models so your data stays in your own environment &mdash; it&rsquo;s never shipped off to train some public AI. We treat everything as confidential and never sell it.</>,
    },
    {
      q: 'What does it cost?',
      a: <>Fixed-price audit at <strong>$750</strong> (first 5 audits <strong>$375</strong>). Managed plans <strong>$400 / $800 / $1,200 per month</strong> are coming soon. Setup fees and other services are quoted per project.</>,
    },
    {
      q: 'How fast is it running?',
      a: <>Most first workers go live within a few weeks of kickoff. We handle setup, connect it to your tools, and test it before it ever talks to a real customer.</>,
    },
    {
      q: 'What if the AI gets something wrong?',
      a: <>AI isn&rsquo;t perfect, so we don&rsquo;t set it and forget it. We monitor it, retrain it, and swap in better models as they improve &mdash; and workers hand off to a human whenever they&rsquo;re unsure.</>,
    },
    {
      q: 'What businesses is this for?',
      a: <>Any small or mid-sized business buried in repetitive admin &mdash; home services (plumbing, HVAC, roofing, electrical), real estate, clinics, agencies, law firms, e-commerce.</>,
    },
    {
      q: 'Can I cancel?',
      a: <>Yes &mdash; month to month, cancel with 30 days&rsquo; notice. No long contracts.</>,
    },
  ]
  return (
    <section id="faq">
      <div className="container-narrow">
        <div className="section-head reveal">
          <span className="eyebrow">FAQ</span>
          <h2>Common questions.</h2>
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

/* -------------------------------------------------------------------------- */
/*  Icons                                                                     */
/* -------------------------------------------------------------------------- */
function IconLock() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
function IconPlug() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v6" />
      <path d="M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 15v6" />
    </svg>
  )
}
function IconShield() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 3v6a9 9 0 0 1-8 9 9 9 0 0 1-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}
