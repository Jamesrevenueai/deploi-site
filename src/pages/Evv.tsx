import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { LeadForm } from '../components/LeadForm'
import { ImageCard } from '../components/ImageCard'
import { Icon } from '../lib/icons'

const WATCHES = [
  { title: 'Clock-in / clock-out mismatch', body: 'A visit with a missing punch, or a duration outside the scheduled window, is caught the same day instead of at claim time.' },
  { title: 'Missing GPS', body: 'Visits verified without a location, or outside the client geofence, are flagged for correction while the aide still remembers the visit.' },
  { title: 'Unit overage vs. authorization', body: 'Units delivered are compared to the remaining authorization so care never outruns what will be paid.' },
  { title: 'Unverified visit past the correction window', body: 'Each open exception shows days left in the state correction window and turns red at seven days. Nothing silently expires.' },
]

const VENDORS = [
  { name: 'Sandata', status: 'First' },
  { name: 'AlayaCare', status: 'Next' },
  { name: 'HHAeXchange', status: 'Next' },
  { name: 'WellSky', status: 'Next' },
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
          The EVV exception layer sits on top of the EVV system you already use. It reads the visit
          export, finds what will not pay, and gives your biller a sorted list with the days left to
          fix each one.
        </p>

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
          <p className="lead">We connect through the vendor export or API. Your EVV stays the system of record.</p>
        </div>
        <div className="vendors">
          {VENDORS.map(v => (
            <span className={`pill ${v.status === 'Next' ? 'muted' : ''}`} key={v.name}>
              <Icon.Link />{v.name} · {v.status}
            </span>
          ))}
        </div>

        <div className="card-grid single">
          <ImageCard
            tag="Correction window"
            tagIcon={<Icon.Clock />}
            title="Sorted by soonest to expire"
            body="Ohio default 60 days; per-state windows configurable. Red at seven days left. Fixed rows close and count in the morning report."
          />
        </div>

        <div className="section-head" id="early-access">
          <h2 className="two-tone">
            <span className="grey">Request</span> <span className="white">early access.</span>
          </h2>
          <p className="lead">Tell us which EVV you run and we will show you the exception list on your own export.</p>
        </div>
        <div className="book-inner">
          <LeadForm
            source="evv-page"
            cta="Request early access"
            messageLabel="Which EVV system do you use?"
            messagePlaceholder="e.g. Sandata, and roughly how many visits a month"
            confirmation={{ title: 'You’re on the list.', body: 'We’ll reach out within one business day.' }}
          />
        </div>
      </div>
    </div>
  )
}
