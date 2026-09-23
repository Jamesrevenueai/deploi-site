import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'

export default function AuditSample() {
  useSeo({
    title: `Sample audit report — ${BRAND}`,
    description:
      'A fictional sample AI audit report so you can see exactly what you get. Estimates only, illustrative.',
  })

  const opportunities = [
    {
      n: '01',
      title: 'Missed-call text-back',
      body: 'When a call is missed, an AI text goes out inside 60 seconds acknowledging the missed call, asking what they need, and offering a callback slot.',
      hoursSaved: '4–6 hrs / week',
      effort: 'Low',
      nextStep: 'Wire to Dialpad + Twilio SMS. 2 weeks of tuning.',
    },
    {
      n: '02',
      title: 'Quote follow-up sequence',
      body: 'Open quotes get 3 follow-ups over 10 days (day 1, 4, 9) — reminder, testimonial, gentle nudge — until reply or close.',
      hoursSaved: '3–5 hrs / week',
      effort: 'Medium',
      nextStep: 'Connect to CRM. Draft copy, review, launch.',
    },
    {
      n: '03',
      title: 'Review request automation',
      body: 'After every completed job, an AI sends a request for a Google review with a smart link based on the tech and job type.',
      hoursSaved: '1–2 hrs / week',
      effort: 'Low',
      nextStep: 'Pull completed-job feed, connect to review platform.',
    },
  ]

  const tools = ['Dialpad', 'Twilio', 'HubSpot CRM', 'Zapier', 'Google Business Profile']

  const plan = [
    { day: 'Days 1–5', body: 'Wire missed-call text-back. Go live in shadow mode.' },
    { day: 'Days 6–12', body: 'Turn text-back live. Draft + launch quote follow-up sequence.' },
    { day: 'Days 13–21', body: 'Add review-request automation. Weekly review.' },
    { day: 'Days 22–30', body: 'Handoff report. Move to ongoing management if desired.' },
  ]

  return (
    <>
      <section className="page-hero sample">
        <div className="container">
          <div className="sample-banner reveal">
            <strong>SAMPLE</strong> — Riverside Plumbing Co. is a <em>fictional</em> business.
            All figures are illustrative estimates.
          </div>
          <div className="page-eyebrow reveal d1">AI Audit — Sample report</div>
          <h1 className="reveal d1">Riverside Plumbing Co.</h1>
          <p className="page-sub reveal d2">
            Prepared by {BRAND} · Prepared for the owner · Prepared as an illustrative sample only.
          </p>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head reveal">
            <span className="eyebrow">Summary</span>
            <h2>Where AI pays back first.</h2>
          </div>
          <p className="problem-body reveal d1">
            Riverside runs a 6-person residential plumbing business in a mid-sized metro. Most
            leads come by phone. Quotes are followed up manually. Reviews are requested
            inconsistently. Three focused AI additions could take an estimated <strong>8–13
            hours a week</strong> off the office team's plate and lift quote-to-close by 10–20%.
            <span className="closer">Everything below is illustrative — your numbers will differ.</span>
          </p>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head reveal">
            <span className="eyebrow">Top 3 opportunities</span>
            <h2>Where to start.</h2>
          </div>
          <div className="sample-ops">
            {opportunities.map((o, i) => (
              <div className={`sample-op reveal d${i + 1}`} key={o.n}>
                <div className="sample-op-num">{o.n}</div>
                <h3>{o.title}</h3>
                <p>{o.body}</p>
                <div className="sample-op-meta">
                  <div><span>Hours saved (est.)</span><strong>{o.hoursSaved}</strong></div>
                  <div><span>Effort</span><strong>{o.effort}</strong></div>
                </div>
                <div className="sample-op-next"><span>Next step</span><p>{o.nextStep}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head reveal">
            <span className="eyebrow">Tools involved</span>
            <h2>What we'd plug into.</h2>
          </div>
          <ul className="sample-tools reveal d1">
            {tools.map(t => <li key={t}>{t}</li>)}
          </ul>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head reveal">
            <span className="eyebrow">30-day plan</span>
            <h2>From zero to live in a month.</h2>
          </div>
          <ol className="sample-plan reveal d1">
            {plan.map(p => (
              <li key={p.day}>
                <div className="sample-plan-day">{p.day}</div>
                <div>{p.body}</div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="mini-audit-card reveal">
            <div>
              <div className="eyebrow">Ready for your own?</div>
              <h2>Book an audit for your business.</h2>
              <p>Same format, real numbers.</p>
            </div>
            <Link to="/audit" className="v2-primary">
              Book your AI Audit
              <span className="arrow" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
