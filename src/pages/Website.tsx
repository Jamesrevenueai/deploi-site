import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { WebsiteForm } from '../components/WebsiteForm'
import { AvailabilityBadge } from '../components/AvailabilityBadge'
import { Icon } from '../lib/icons'
import { catalog, money, websiteService } from '../lib/catalog'

/** The delivery process in the customer's words. Internal status keys are in the app, not here. */
export const WEBSITE_STEPS: { title: string; body: string }[] = [
  { title: 'Inquiry', body: 'You send the request below. No payment, no commitment.' },
  { title: 'Scope confirmed', body: 'We reply within one business day with the pages and changes we understood, in writing, and ask anything we are unsure about.' },
  { title: 'Accepted', body: 'You confirm the scope. Anything outside it is quoted separately or left for later.' },
  { title: 'Payment confirmed', body: `You pay the one-time ${money(catalog.pricing.website.price)}. Work does not start before payment is confirmed.` },
  { title: 'Access received', body: 'We arrange editor access through your platform’s own sharing or a method you approve. Never a password typed into a form or sent by email.' },
  { title: 'Improving', body: 'We note a backup or rollback first, then make the changes, staged or previewed where your platform supports it.' },
  { title: 'Preview ready', body: 'You see the changes before anyone else does.' },
  { title: 'Customer approved', body: 'You approve, after one consolidated round of revisions if you want changes.' },
  { title: 'Published', body: 'We publish and check contact links, buttons and that the form delivers.' },
  { title: 'Completed', body: 'You receive a brief before-and-after summary. Hosting, domain and plugins stay yours.' },
]

export default function Website() {
  const svc = websiteService
  const price = catalog.pricing.website
  useSeo({
    title: `Website Improvement, ${money(price.price)} one-time — ${BRAND}`,
    description: svc?.description ?? 'A standalone, fixed-price improvement of up to three pages on your existing website.',
  })
  if (!svc) {
    return (
      <div className="page">
        <div className="container-narrow">
          <Link to="/" className="back">← Back to {BRAND}</Link>
          <h1>Website Improvement</h1>
          <p className="page-sub">This service is not in the current catalog. <Link to="/#book">Request a discovery conversation</Link> instead.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="page website-page">
      <div className="container-narrow">
        <Link to="/" className="back">← Back to {BRAND}</Link>
        <div className="page-eyebrow">{catalog.doors[svc.door]} · Standalone service</div>
        <h1 className="two-tone">
          <span className="grey">Website Improvement.</span><br />
          <span className="white">{money(price.price)} one-time.</span>
        </h1>
        <p className="page-sub">{svc.description}</p>
        <div className="website-facts">
          <span className="pill"><Icon.Tag />{money(price.price)} one-time</span>
          <span className="pill"><Icon.Clock />Target: {price.targetBusinessDays} business days</span>
          <span className="pill muted"><Icon.Link />No assessment, no retainer</span>
        </div>
        <div className="website-avail">
          <AvailabilityBadge availability={svc.availability} />
        </div>
        <p className="muted website-fit">{svc.targetCustomer} Stand-alone: it does not require the assessment and does not credit toward other services.</p>

        <div className="section-head">
          <h2 className="two-tone">
            <span className="grey">What is</span> <span className="white">included.</span>
          </h2>
          <p className="lead">One website, up to three pages, one consolidated revision round, {price.hoursBudget} staff hours in total.</p>
        </div>
        <ul className="check-list check-list-page">
          {svc.setupDeliverables.map(d => <li key={d}><Icon.Check />{d}</li>)}
        </ul>

        <div className="section-head">
          <h2 className="two-tone">
            <span className="grey">What is</span> <span className="white">not included.</span>
          </h2>
          <p className="lead">If you need one of these, say so in the request and we will tell you plainly whether it is a separate quote or something we do not do.</p>
        </div>
        <ul className="x-list">
          {svc.exclusions.map(d => <li key={d}>{d}</li>)}
        </ul>

        <div className="section-head">
          <h2 className="two-tone">
            <span className="grey">How it</span> <span className="white">goes.</span>
          </h2>
          <p className="lead">
            Our target is {price.targetBusinessDays} business days from the day payment, access and content are all received.
            That is a target, not a guarantee; platform limits and revision timing can move it, and we tell you when they do.
          </p>
        </div>
        <ol className="process">
          {WEBSITE_STEPS.map((s, i) => (
            <li className="process-step" key={s.title}>
              <div className="num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="section-head">
          <h2 className="two-tone">
            <span className="grey">Who does</span> <span className="white">what.</span>
          </h2>
        </div>
        <div className="keep-grid keep-grid-page">
          <div className="keep-col">
            <h3>You</h3>
            <ul className="check-list">
              {svc.customerResponsibilities.map(r => <li key={r}><Icon.Check />{r}</li>)}
            </ul>
          </div>
          <div className="keep-col">
            <h3>{BRAND}</h3>
            <ul className="check-list">
              {svc.deploiResponsibilities.map(r => <li key={r}><Icon.Check />{r}</li>)}
            </ul>
          </div>
        </div>
        <p className="muted website-fine">
          We improve clarity, usability and inquiry paths on pages you already have. We do not promise leads,
          search rankings, revenue or accessibility compliance, and we do not run advertising pixels, session
          replay or analytics on your behalf.
        </p>

        <div className="section-head" id="request">
          <h2 className="two-tone">
            <span className="grey">Request</span> <span className="white">website improvements.</span>
          </h2>
          <p className="lead">
            Tell us about your site and what you would like changed. We reply within one business day with
            the scope in writing.
          </p>
        </div>
        <div className="book-inner">
          <WebsiteForm />
        </div>
      </div>
    </div>
  )
}
