import { useEffect, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode } from 'react'

/* -------------------------------------------------------------------------- */
/*  BRAND — change once if the name changes.                                  */
/* -------------------------------------------------------------------------- */
const BRAND = 'Deploi'

const FORMSPREE_ENDPOINT: string | undefined = import.meta.env.VITE_FORMSPREE_ENDPOINT

/* -------------------------------------------------------------------------- */
/*  Tiny client router — just enough for /terms and /privacy stubs.           */
/* -------------------------------------------------------------------------- */
type Route = 'home' | 'terms' | 'privacy'

function parseRoute(): Route {
  const p = window.location.pathname
  if (p === '/terms') return 'terms'
  if (p === '/privacy') return 'privacy'
  return 'home'
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parseRoute)
  useEffect(() => {
    const handler = () => setRoute(parseRoute())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])
  const nav = (r: Route) => {
    const path = r === 'home' ? '/' : `/${r}`
    window.history.pushState({}, '', path)
    setRoute(r)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  return [route, nav]
}

/* -------------------------------------------------------------------------- */
/*  App                                                                       */
/* -------------------------------------------------------------------------- */
export default function App() {
  const [route, nav] = useRoute()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 12)
    h()
    window.addEventListener('scroll', h, { passive: true })
    return () => window.removeEventListener('scroll', h)
  }, [])

  useScrollReveal()

  if (route !== 'home') {
    return (
      <LegalPage
        kind={route}
        title={route === 'terms' ? 'Terms of Service' : 'Privacy Policy'}
        nav={nav}
      />
    )
  }

  return (
    <>
      <Nav scrolled={scrolled} />
      <main>
        <Hero />
        <Problem />
        <Workers />
        <HowItWorks />
        <Managed />
        <Private />
        <UseCases />
        <Pricing />
        <FAQ />
        <WaitlistSection />
      </main>
      <Footer nav={nav} />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Scroll reveal — attach IntersectionObserver to any .reveal element        */
/* -------------------------------------------------------------------------- */
function useScrollReveal() {
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('revealed'))
      return
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed')
          io.unobserve(entry.target)
        }
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })

    let mounted = true
    const attach = () => {
      if (!mounted) return
      document.querySelectorAll('.reveal:not(.revealed)').forEach(el => io.observe(el))
    }
    attach()
    // re-attach on DOM churn (details open/close, form success state, etc.)
    const mo = new MutationObserver(attach)
    mo.observe(document.body, { childList: true, subtree: true })

    return () => {
      mounted = false
      io.disconnect()
      mo.disconnect()
    }
  }, [])
}

/* -------------------------------------------------------------------------- */
/*  Nav                                                                       */
/* -------------------------------------------------------------------------- */
function Nav({ scrolled }: { scrolled: boolean }) {
  return (
    <nav className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="nav-inner">
        <a href="#top" className="brand" aria-label={BRAND}>
          {BRAND}<span className="dot">.</span>
        </a>
        <a href="#waitlist" className="nav-cta">Join the waitlist</a>
      </div>
    </nav>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero v2 — "Obsidian & Amber" (scoped; awaiting approval)                  */
/* -------------------------------------------------------------------------- */
type Task = { ts: string; text: string }
type Worker = {
  id: string
  name: string
  role: string
  led: 'green' | 'blue' | 'amber'
  script: string[] // ordered next-tasks; head is currently-active, rest queued
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
    completed: [
      { ts: '09:08', text: 'sent 2 revised quotes to Hartman & Sons' },
    ],
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
    completed: [
      { ts: '09:11', text: 'answered 6 tickets · avg 42s' },
    ],
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
          const done: Task = { ts: `${hh}:${mm}`, text: head.replace(/^drafting |^reading |^scheduling |^pulling |^answering: |^checking .+?: |^rescheduling: |^flagging /, '') }
          const nextScript = rest.length > 0
            ? rest
            : [...INITIAL_WORKERS[i].script] // loop back
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
            <a href="#waitlist" className="v2-primary">
              Join the waitlist
              <span className="arrow" aria-hidden="true">→</span>
            </a>
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
/*  Pricing                                                                   */
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
          <span className="eyebrow">Pricing</span>
          <h2>One flat monthly fee. Cancel anytime.</h2>
          <p>Every plan includes ongoing management &mdash; that's the whole point.</p>
        </div>
        <div className="tiers">
          {tiers.map((t, i) => (
            <div className={`tier reveal d${i + 1} ${t.featured ? 'featured' : ''}`} key={t.name}>
              {t.featured && <div className="tier-badge">Most chosen</div>}
              <div className="tier-name">{t.name}</div>
              <div className="tier-price">{t.price}<span className="per">/mo</span></div>
              <div className="tier-sub">{t.sub}</div>
              <ul>
                {t.features.map(f => <li key={f}>{f}</li>)}
              </ul>
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
/*  Waitlist                                                                  */
/* -------------------------------------------------------------------------- */
function WaitlistSection() {
  return (
    <section id="waitlist" className="waitlist">
      <div className="container-narrow waitlist-card">
        <div className="section-head reveal" style={{ marginBottom: 0 }}>
          <span className="eyebrow">Waitlist</span>
          <h2>Get on the list.</h2>
          <p>
            We're onboarding a small number of businesses at a time. Leave your details and
            we'll reach out when we've got a slot that fits.
          </p>
        </div>
        <div className="reveal d1">
          <WaitlistForm />
        </div>
      </div>
    </section>
  )
}

function WaitlistForm() {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const configured = Boolean(FORMSPREE_ENDPOINT && FORMSPREE_ENDPOINT.trim())

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    const fd = new FormData(e.currentTarget)
    const payload = {
      name: String(fd.get('name') ?? '').trim(),
      business: String(fd.get('business') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      wants: String(fd.get('wants') ?? '').trim(),
      _source: BRAND + ' waitlist',
    }

    if (!payload.name || !payload.business || !payload.email) {
      setError('Please fill in name, business, and email.')
      return
    }

    if (!configured) {
      setError('Waitlist backend is not configured yet. Set VITE_FORMSPREE_ENDPOINT and redeploy.')
      return
    }

    setStatus('submitting')
    try {
      const res = await fetch(FORMSPREE_ENDPOINT!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(detail || `Request failed (${res.status})`)
      }
      setStatus('done')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
  }

  if (status === 'done') {
    return (
      <div className="confirmation">
        <div className="check" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="5 12 10 17 19 8"/>
          </svg>
        </div>
        <h3>You're on the list.</h3>
        <p>Thanks — we'll be in touch as soon as we've got a slot for you.</p>
      </div>
    )
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" autoComplete="name" required />
      </div>
      <div className="field">
        <label htmlFor="business">Business</label>
        <input id="business" name="business" type="text" autoComplete="organization" required />
      </div>
      <div className="field">
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="wants">
          What would you want AI to handle?
          <span className="optional">(optional)</span>
        </label>
        <textarea id="wants" name="wants" placeholder="e.g. front-desk phone calls, support inbox, quoting…" />
      </div>
      <button type="submit" className="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : 'Join the waitlist'}
      </button>
      {error && <div className="form-error">{error}</div>}
      {!configured && !error && (
        <div className="form-notice">
          Preview build — waitlist submissions are not yet delivered. Set{' '}
          <code>VITE_FORMSPREE_ENDPOINT</code> to enable.
        </div>
      )}
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/*  Workers — "What your AI workers actually do"                              */
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
/*  FAQ                                                                       */
/* -------------------------------------------------------------------------- */
function FAQ() {
  const faqs: { q: string; a: ReactNode }[] = [
    {
      q: 'Do I need to be technical?',
      a: <>No &mdash; that&rsquo;s the whole point. We build, connect, and run your AI workers for you. You never touch a model, a prompt, or a line of code.</>,
    },
    {
      q: 'Is my business data safe?',
      a: <>Yes. Your workers can run on local, open models so your data stays in your own environment &mdash; it&rsquo;s never shipped off to train some public AI. We treat everything as confidential and never sell it.</>,
    },
    {
      q: 'What does it cost?',
      a: <>Flat monthly pricing in three tiers &mdash; <strong>$400</strong>, <strong>$800</strong>, and <strong>$1,200/mo</strong> &mdash; depending on how many workers you run and how hands-on the management is. No surprise usage bills. A one-time setup fee per worker may apply for the build.</>,
    },
    {
      q: 'How fast is it running?',
      a: <>Most first workers go live within <span className="placeholder">[SETUP TIME]</span> of our kickoff call. We handle setup, connect it to your tools, and test it before it ever talks to a real customer.</>,
    },
    {
      q: 'What if the AI gets something wrong?',
      a: <>AI isn&rsquo;t perfect, so we don&rsquo;t set it and forget it. We monitor it, retrain it, and swap in better models as they improve &mdash; and workers hand off to a human whenever they&rsquo;re unsure. You get regular reports on exactly what it&rsquo;s doing.</>,
    },
    {
      q: 'How is this different from a chatbot?',
      a: <>A chatbot answers questions. A Deploi worker does the job &mdash; books the appointment, captures the lead, follows up &mdash; and we keep it running and improving every month. You&rsquo;re hiring an outcome, not a widget.</>,
    },
    {
      q: 'What businesses is this for?',
      a: <>Any small or mid-sized business buried in repetitive admin &mdash; dental and medical offices, home services (plumbing, HVAC, electrical), law firms, agencies, e-commerce, and more.</>,
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
          {faqs.map((f) => (
            <details className="faq-item" key={f.q}>
              <summary>
                <span className="faq-q">{f.q}</span>
                <span className="faq-chevron" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
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
/*  Footer                                                                    */
/* -------------------------------------------------------------------------- */
function Footer({ nav }: { nav: (r: Route) => void }) {
  const handle = (r: Route) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    nav(r)
  }
  const year = new Date().getFullYear()
  return (
    <footer>
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand-block">
            <div className="footer-brand">{BRAND}<span className="dot">.</span></div>
            <p className="footer-tag">
              We deploy your AI &mdash; and keep it running. Private-by-design AI workers for
              small businesses, managed for you every month.
            </p>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Product</div>
            <ul>
              <li><a href="#workers">The workers</a></li>
              <li><a href="#pricing">Pricing</a></li>
              <li><a href="#faq">FAQ</a></li>
              <li><a href="#waitlist">Join the waitlist</a></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Company</div>
            <ul>
              <li><a href="#top">About</a></li>
              <li><a href="#waitlist">Contact</a></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Legal</div>
            <ul>
              <li><a href="/terms" onClick={handle('terms')}>Terms of Service</a></li>
              <li><a href="/privacy" onClick={handle('privacy')}>Privacy Policy</a></li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="footer-copy">© {year} {BRAND} · All rights reserved</div>
          <div className="footer-status" aria-label="status">
            <span className="led" aria-hidden="true"></span>
            Workers online
          </div>
        </div>
      </div>
    </footer>
  )
}

/* -------------------------------------------------------------------------- */
/*  Legal — Terms of Service + Privacy Policy                                 */
/* -------------------------------------------------------------------------- */
type LegalKind = 'terms' | 'privacy'
type LegalSection = { title: string; body: ReactNode }

const LEGAL_UPDATED = 'September 21, 2026'

const TERMS: LegalSection[] = [
  {
    title: 'Who we are',
    body: <>{BRAND} is operated by <span className="placeholder">[LEGAL ENTITY NAME]</span>, LLC, an Ohio limited liability company. By using this website or our services, you agree to these Terms.</>,
  },
  {
    title: 'What we do',
    body: <>We provide AI implementation and ongoing managed services &mdash; we set up and run "AI workers" for your business and monitor, retrain, adjust, and report on them monthly. We are a service provider; we are not the maker of the underlying AI models.</>,
  },
  {
    title: 'No guarantees',
    body: <>AI is probabilistic and can make mistakes. Our services are provided <strong>"as is"</strong>, and we do not guarantee specific outcomes. You are responsible for reviewing AI output before relying on it for important decisions.</>,
  },
  {
    title: 'Fees',
    body: <>Managed plans are billed monthly in advance. Setup fees, where applicable, are billed once. Fees are non-refundable except where required by law. We may change pricing on 30 days' notice.</>,
  },
  {
    title: 'Your responsibilities',
    body: <>You agree to provide accurate information and any access we need to deliver the service, keep your use lawful, and comply with the terms of any third-party tools we connect on your behalf.</>,
  },
  {
    title: 'Your data',
    body: <>We access your data only to deliver the service. We keep it confidential, we do not sell it, and we do not use it to train public models without your consent. Where AI workers run locally, your data stays in your own environment. Personal data is covered by a separate Data Processing Agreement.</>,
  },
  {
    title: 'Intellectual property',
    body: <>The configurations, prompts, and workflows we build for you are licensed to you. Our own tooling, methods, and know-how remain ours.</>,
  },
  {
    title: 'Limitation of liability',
    body: <>Our total liability to you is capped at the fees you paid us in the three months preceding the claim. We are not liable for indirect, incidental, consequential, or special damages.</>,
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
    body: <>Information you give us (name, business, work email, and details you submit through forms). Basic website usage and analytics data. When you become a client, the business data we need to run your AI workers.</>,
  },
  {
    title: 'How we use it',
    body: <>To respond to you, provide and improve the service, run your AI workers, and send you updates you opted into. <strong>We do not sell personal information.</strong></>,
  },
  {
    title: 'Client business data',
    body: <>Client data is confidential and processed only to deliver the service. Where workers run locally, your data stays in your environment. Personal data is covered by a separate Data Processing Agreement.</>,
  },
  {
    title: 'Sharing',
    body: <>We share information only with service providers who help us operate (for example, email delivery, hosting) under confidentiality obligations, or where required by law.</>,
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

function LegalPage({ kind, title, nav }: { kind: LegalKind; title: string; nav: (r: Route) => void }) {
  const sections = kind === 'terms' ? TERMS : PRIVACY
  return (
    <>
      <Nav scrolled={true} />
      <main className="legal">
        <div className="container-narrow">
          <a
            href="/"
            className="back"
            onClick={(e) => { e.preventDefault(); nav('home') }}
          >← Back to {BRAND}</a>
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
      <Footer nav={nav} />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Icons                                                                     */
/* -------------------------------------------------------------------------- */
function IconLock() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2"/>
      <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
    </svg>
  )
}
function IconPlug() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v6"/>
      <path d="M15 3v6"/>
      <path d="M6 9h12v3a6 6 0 0 1-12 0z"/>
      <path d="M12 15v6"/>
    </svg>
  )
}
function IconShield() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 3v6a9 9 0 0 1-8 9 9 9 0 0 1-8-9V6z"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  )
}
