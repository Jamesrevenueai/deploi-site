import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { LeadForm } from '../components/LeadForm'
import { ImageCard } from '../components/ImageCard'
import { Icon } from '../lib/icons'
import { catalog } from '../lib/catalog'
import { AvailabilityBadge } from '../components/AvailabilityBadge'

const EVV_VENDORS = catalog.integrations.filter(i => i.kind === 'evv')
const EVV_SERVICE = catalog.services.find(s => s.key === 'evv_exceptions')

const WATCHES = [
  { title: 'Clock-in / clock-out mismatch', body: 'A visit with a missing punch, or a duration outside the scheduled window, is caught the same day instead of at claim time.' },
  { title: 'Missing GPS', body: 'Visits verified without a location, or outside the client geofence, are flagged for correction while the aide still remembers the visit.' },
  { title: 'Unit overage vs. authorization', body: 'Units delivered are compared to the remaining authorization so care never outruns what will be paid.' },
  { title: 'Unverified visit near the correction deadline', body: 'Each open exception shows the days left to the correction deadline configured for your program, payer and state, with its source and effective date. Nothing silently expires.' },
]


export default function Evv() {
  useSeo({
    title: `EVV exception layer — ${BRAND}`,
    description: 'Visits checked against EVV and the authorization, fixed inside the correction window, before they reach billing.',
  })
  return (
    <div className="page">
      <div className="container-narrow">
        <Link to="/" className="back">← Back to {BRAND}</Link>
        <div className="page-eyebrow">Operations</div>
        <h1 className="two-tone">
          <span className="grey">Every visit checked.</span><br />
          <span className="white">Before it reaches billing.</span>
        </h1>
        <p className="page-sub">
          EVV exception management sits beside the EVV system you already use. It reads the visit
          export (CSV), checks it against seven rules and the authorization, and gives your biller a
          sorted exception list with the days left to fix each one, plus an advisory billing-hold list.
          Corrections stay in your vendor system, made by your people.
        </p>
        {EVV_SERVICE && <div className="website-avail"><AvailabilityBadge availability={EVV_SERVICE.availability} /></div>}

        <div className="section-head">
          <h2 className="two-tone">
            <span className="grey">What it</span> <span className="white">watches.</span>
          </h2>
        </div>
        <ul className="plain-list">
          {WATCHES.map(w => (
            <li key={w.title}>
              <strong>{w.title}</strong>
              {w.body}
            </li>
          ))}
        </ul>

        <div className="section-head">
          <h2 className="two-tone">
            <span className="grey">Which systems</span> <span className="white">it sits on.</span>
          </h2>
          <p className="lead">
            We read the visit export your EVV vendor already produces. Compatibility means our CSV import
            works with that export; it is not a partnership, and there is no live vendor connection yet.
            Your EVV stays the system of record.
          </p>
        </div>
        <div className="vendors">
          {EVV_VENDORS.map(v => (
            <span className="pill muted" key={v.key}>
              <Icon.Link />{v.name} · {catalog.integrationLevelLabel[v.level]}
            </span>
          ))}
        </div>

        <div className="card-grid single">
          <ImageCard
            tag="Correction window"
            tagIcon={<Icon.Clock />}
            title="Sorted by soonest deadline"
            body="Correction deadlines are configured per program, payer and state, each with its source and effective date. Rows turn red as the deadline nears; corrected rows close and count on the morning report."
          />
        </div>

        <div className="section-head" id="early-access">
          <h2 className="two-tone">
            <span className="grey">Request</span> <span className="white">early access.</span>
          </h2>
          <p className="lead">Tell us which EVV you run. The service is at the demonstration stage: we can walk you through the rules on synthetic data and talk about a supervised pilot on your own export.</p>
        </div>
        <div className="book-inner">
          <LeadForm
            source="evv-page"
            cta="Request early access"
            messageLabel="Which EVV system do you use?"
            messagePlaceholder="e.g. Sandata, and roughly how many visits a month"
            confirmation={{ title: 'Got it.', body: 'We will reach out within one business day.' }}
          />
        </div>
      </div>
    </div>
  )
}
