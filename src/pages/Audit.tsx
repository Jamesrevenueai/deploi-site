import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { auditUrl, auditFoundingUrl, miniAuditUrl, isConfigured } from '../lib/ctaUrls'
import { OFFERS } from '../data/offers'
import { useSeo } from '../hooks/useSeo'

export default function Audit() {
  useSeo({
    title: `AI Audit — ${BRAND}`,
    description:
      'A fixed-price AI Audit for small businesses — find where AI actually saves you hours and dollars. 100% credited toward setup if you sign within 30 days.',
  })

  const foundingLeft = OFFERS.foundingAuditsLeft
  const showFounding = foundingLeft > 0
  const foundingHref = auditFoundingUrl()
  const auditHref = auditUrl()
  const miniHref = miniAuditUrl()
  const isExternal = (u: string) => !u.startsWith('#') && !u.startsWith('/')

  const included = [
    { t: 'Discovery session', d: '60–90 min walkthrough of intake, scheduling, follow-ups, invoicing, reviews, inbox.' },
    { t: 'Tool & data inventory', d: 'What you already use, what data lives where, what talks to what.' },
    { t: 'Opportunity scoring', d: 'Each opportunity ranked by hours saved, dollars saved, and effort to build.' },
    { t: 'Written report', d: 'Your top 3–5 AI opportunities, estimated hours and dollars saved, effort level, and the recommended next step.' },
    { t: 'Readout call', d: 'We walk you through the findings and answer questions.' },
  ]

  const faqs: { q: string; a: string }[] = [
    { q: 'Who is this for?', a: 'Small and mid-sized businesses drowning in repetitive admin — home services, real estate, clinics, agencies, law firms, e-commerce.' },
    { q: 'How long until I get the report?', a: 'Within 5 business days of the discovery session.' },
    { q: 'What if I don\'t sign?', a: 'You keep the report. There\'s no obligation.' },
    { q: 'Do you connect to my systems?', a: 'No. The audit is a read-only walkthrough. Nothing gets connected without your written approval.' },
    { q: 'Is my data safe?', a: 'Everything you show us stays confidential. We don\'t handle patient health information.' },
    { q: 'Refunds?', a: 'Fully refundable before the discovery session. After the session, the 5-Hour Guarantee kicks in.' },
  ]

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <div className="page-eyebrow reveal">AI Audit</div>
          <h1 className="reveal d1">
            Find out exactly where AI saves your business time and money.
          </h1>
          <p className="page-sub reveal d2">
            A fixed-price audit that pays for itself — <strong>100% credited toward setup</strong> if you sign within 30 days.
          </p>

          {showFounding && (
            <div className="founding-banner reveal d3">
              <div className="founding-eyebrow">Founding offer</div>
              <div className="founding-body">
                <strong>First 5 audits at $375 (50% off)</strong> in exchange for a testimonial and case study.
                <span className="founding-left">{foundingLeft} of 5 left.</span>
              </div>
              <a
                href={foundingHref}
                className="v2-primary"
                target={isExternal(foundingHref) ? '_blank' : undefined}
                rel={isExternal(foundingHref) ? 'noopener noreferrer' : undefined}
              >
                Claim a founding audit
                <span className="arrow" aria-hidden="true">→</span>
              </a>
              {!isConfigured.auditFounding() && (
                <div className="cta-notice">Checkout link not configured yet — button goes to the waitlist.</div>
              )}
            </div>
          )}

          <div className="audit-primary-row reveal d3">
            <div className="audit-price">
              <div className="price-num">$750</div>
              <div className="price-sub">AI Audit — regular price</div>
            </div>
            <a
              href={auditHref}
              className="v2-primary"
              target={isExternal(auditHref) ? '_blank' : undefined}
              rel={isExternal(auditHref) ? 'noopener noreferrer' : undefined}
            >
              Book your audit
              <span className="arrow" aria-hidden="true">→</span>
            </a>
            {!isConfigured.audit() && (
              <div className="cta-notice">Checkout link not configured yet — button goes to the waitlist.</div>
            )}
          </div>

          <div className="guarantee reveal d4">
            <div className="guarantee-badge">The 5-Hour Guarantee</div>
            <p>
              If your audit doesn't find at least <strong>5 hours a week</strong> of work AI can take off your plate,
              you get a <strong>full refund</strong>.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="section-head reveal">
            <span className="eyebrow">What you get</span>
            <h2>Included in your audit.</h2>
          </div>
          <ol className="included-list reveal d1">
            {included.map((it, i) => (
              <li className="included-item" key={it.t}>
                <div className="included-num">{String(i + 1).padStart(2, '0')}</div>
                <div>
                  <h3>{it.t}</h3>
                  <p>{it.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section>
        <div className="container">
          <div className="mini-audit-card reveal">
            <div>
              <div className="eyebrow">Not sure yet?</div>
              <h2>Book a free 15-minute mini-audit.</h2>
              <p>We'll show you 3 things you could automate this week. No pitch deck.</p>
            </div>
            <a
              href={miniHref}
              className="v2-primary"
              target={isExternal(miniHref) ? '_blank' : undefined}
              rel={isExternal(miniHref) ? 'noopener noreferrer' : undefined}
            >
              Book the free mini-audit
              <span className="arrow" aria-hidden="true">→</span>
            </a>
          </div>
          <div className="audit-extras reveal d1">
            <Link to="/audit/sample" className="audit-extra-link">See a sample report →</Link>
            <div className="audit-extra-note">Course members get $100 off.</div>
          </div>
        </div>
      </section>

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
                <div className="faq-a"><p>{f.a}</p></div>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
