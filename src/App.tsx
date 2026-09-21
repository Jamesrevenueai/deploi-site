import { useEffect, useState, type FormEvent, type MouseEvent } from 'react'

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

  if (route !== 'home') {
    return (
      <LegalPage
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
        <HowItWorks />
        <Managed />
        <Private />
        <UseCases />
        <Pricing />
        <WaitlistSection />
      </main>
      <Footer nav={nav} />
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Nav                                                                       */
/* -------------------------------------------------------------------------- */
function Nav({ scrolled }: { scrolled: boolean }) {
  return (
    <nav className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="nav-inner">
        <a href="#top" className="brand" aria-label={BRAND}>{BRAND}</a>
        <a href="#waitlist" className="nav-cta">Waitlist</a>
      </div>
    </nav>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                      */
/* -------------------------------------------------------------------------- */
function Hero() {
  return (
    <section id="top" className="hero">
      <div className="container">
        <div className="hero-inner">
          <h1>
            We deploy your AI —<br />
            and <em>keep it running.</em>
          </h1>
          <p className="hero-sub">
            {BRAND} is a hands-on AI team for small businesses. We assess your workflows,
            stand up AI workers on your own data, and manage them every month —
            monitoring, retraining, and reporting so it keeps working long after we go live.
          </p>
          <a href="#waitlist" className="hero-cta">
            Join the waitlist
            <span className="arrow" aria-hidden="true">→</span>
          </a>
          <div className="hero-microtrust">
            <span className="dot" aria-hidden="true"></span>
            Private by design — runs on your data, connects to the tools you already use.
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
        <div className="section-head">
          <span className="eyebrow">The problem</span>
          <h2>AI works. Building it — and keeping it working — doesn't.</h2>
        </div>
        <p className="problem-body">
          Every small business owner knows they should be using AI. Almost none of them can
          actually build it. <strong>And even the ones who can, can't babysit it.</strong>{' '}
          Models drift. Data changes. New releases ship every week. The consultant who set it up
          is long gone. So the AI sits there, silently getting worse, until it's quietly turned off.
          <br /><br />
          {BRAND} exists to fix both halves.
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
        <div className="section-head">
          <span className="eyebrow">How it works</span>
          <h2>Set up. Kept up.</h2>
        </div>
        <div className="steps">
          {steps.map(s => (
            <div className="step" key={s.n}>
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
        <div className="section-head">
          <span className="eyebrow">Managed, not delivered</span>
          <h2>Four things we do every month.</h2>
          <p>Most consultants set up and vanish. We keep the AI actually working — for the life of the engagement.</p>
        </div>
        <div className="pillars">
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
        <div className="section-head">
          <span className="eyebrow">Private by design</span>
          <h2>Your data stays your data.</h2>
        </div>
        <div className="private-grid">
          <p className="private-lede">
            The AI runs <strong>locally, on your own data</strong> — not on someone else's cloud,
            not on a shared model, not on customer records piped to a third party. It plugs into
            the tools your team already lives in and works from what you already have.
            <br /><br />
            If something sensitive doesn't need to leave your business, it doesn't.
          </p>
          <ul className="trust-list">
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
                <p>Your business's patterns train your business's AI — not someone else's model.</p>
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
        <div className="section-head">
          <span className="eyebrow">Built for</span>
          <h2>Small businesses that need real hours back.</h2>
        </div>
        <div className="usecases">
          {cases.map(c => (
            <div className="usecase" key={c.role}>
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
        <div className="section-head">
          <span className="eyebrow">Pricing</span>
          <h2>One flat monthly fee. Cancel anytime.</h2>
          <p>Every plan includes ongoing management — that's the whole point.</p>
        </div>
        <div className="tiers">
          {tiers.map(t => (
            <div className={`tier ${t.featured ? 'featured' : ''}`} key={t.name}>
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
        <div className="pricing-footnote">
          Plus a one-time implementation fee per worker — <strong>Custom.</strong>
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
        <div className="section-head" style={{ marginBottom: 0 }}>
          <span className="eyebrow">Waitlist</span>
          <h2>Get on the list.</h2>
          <p>
            We're onboarding a small number of businesses at a time. Leave your details and
            we'll reach out when we've got a slot that fits.
          </p>
        </div>
        <WaitlistForm />
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
        <div className="footer-inner">
          <div className="footer-brand">{BRAND}</div>
          <div className="footer-links">
            <a href="/terms" onClick={handle('terms')}>Terms</a>
            <a href="/privacy" onClick={handle('privacy')}>Privacy</a>
          </div>
          <div className="footer-copy">© {year} {BRAND}</div>
        </div>
      </div>
    </footer>
  )
}

/* -------------------------------------------------------------------------- */
/*  Legal stub page                                                           */
/* -------------------------------------------------------------------------- */
function LegalPage({ title, nav }: { title: string; nav: (r: Route) => void }) {
  return (
    <>
      <Nav scrolled={false} />
      <main className="container legal">
        <a
          href="/"
          className="back"
          onClick={(e) => { e.preventDefault(); nav('home') }}
        >← Back to {BRAND}</a>
        <h1>{title}</h1>
        <p>
          This page is a placeholder while {BRAND} finalizes its {title.toLowerCase()}.
          Real terms will replace this before we onboard any customer.
        </p>
        <p>
          If you have any questions in the meantime, reach out through the waitlist form on the
          home page.
        </p>
        <p>
          Last updated: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.
        </p>
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
