import { BRAND } from '../lib/brand'
import { courseUrl, isConfigured } from '../lib/ctaUrls'
import { useSeo } from '../hooks/useSeo'

export default function Course() {
  useSeo({
    title: `Founding Cohort Course — ${BRAND}`,
    description:
      'Learn to run your business with AI in 4 weeks. Live evening Zoom sessions, small cohort, recordings included. Founding price $297.',
  })

  const weeks = [
    {
      n: 'Week 1',
      title: 'Your AI assistant',
      body: 'ChatGPT, Claude, Gemini, Copilot. Prompting fundamentals. Building a library of reusable prompts you actually use.',
    },
    {
      n: 'Week 2',
      title: 'Automate the busywork',
      body: 'Zapier and Make. Connecting forms, email, your CRM, and spreadsheets. Building your first 3 automations live.',
    },
    {
      n: 'Week 3',
      title: 'Customers & marketing',
      body: 'AI chat and support, AI meeting notes, Canva, email follow-up. Show up more, do less.',
    },
    {
      n: 'Week 4',
      title: 'Money & operations',
      body: 'QuickBooks AI, AI scheduling, how to measure the hours you\'re saving, and when to bring in managed AI workers.',
    },
  ]

  const href = courseUrl()
  const external = !href.startsWith('#') && !href.startsWith('/')

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <div className="page-eyebrow reveal">Founding Cohort Course</div>
          <h1 className="reveal d1">
            Learn to run your business with AI — <span className="accent">in 4 weeks, live.</span>
          </h1>
          <p className="page-sub reveal d2">
            4 weekly live evening Zoom sessions, small cohort, recordings included.
          </p>

          <div className="audit-primary-row reveal d3">
            <div className="audit-price">
              <div className="price-num">$297</div>
              <div className="price-sub">Founding price</div>
            </div>
            <a
              href={href}
              className="v2-primary"
              target={external ? '_blank' : undefined}
              rel={external ? 'noopener noreferrer' : undefined}
            >
              Join the founding cohort
              <span className="arrow" aria-hidden="true">→</span>
            </a>
            {!isConfigured.course() && (
              <div className="cta-notice">Checkout link not configured yet — button goes to the waitlist.</div>
            )}
          </div>

          <div className="course-perks reveal d4">
            <div><strong>Course members get $100 off</strong> an AI Audit.</div>
            <div>Full refund before session 2.</div>
          </div>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head reveal">
            <span className="eyebrow">What you'll learn</span>
            <h2>Four weeks. Four themes.</h2>
          </div>
          <div className="course-weeks">
            {weeks.map((w, i) => (
              <div className={`course-week reveal d${(i % 4) + 1}`} key={w.n}>
                <div className="course-week-num">{w.n}</div>
                <h3>{w.title}</h3>
                <p>{w.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
