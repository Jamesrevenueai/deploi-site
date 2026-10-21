import { Link } from 'react-router-dom'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'

const POINTS = [
  { title: 'Signed before any client data', body: 'No protected health information reaches us until the agreement is signed by both sides. The assessment can start with de-identified examples; the build cannot start without the BAA.' },
  { title: 'Changes and record reads are logged', body: 'Every change to client records in our systems is written to an audit log with who, what and when. Reads of client records are logged on the dashboard, report and action pages. You can ask for the log at any time.' },
  { title: 'Minimum necessary', body: 'We use and request only the data the specific service needs. Staffing and hiring services touch no client records at all.' },
  { title: 'Subcontractors bound to the same terms', body: 'Any vendor that could see your data (hosting, database, messaging) signs terms at least as strict as ours before it touches anything.' },
  { title: 'Breach notification within 60 days', body: 'If we discover a breach of unsecured PHI, we notify you without unreasonable delay and in no case later than 60 days after discovery, with what we know and what we are doing.' },
  { title: 'Termination returns or destroys data', body: 'When the engagement ends, we return your data or destroy it, as you choose, and certify it in writing. Where return or destruction is infeasible, protections continue for as long as we hold it.' },
]

export default function Baa() {
  useSeo({
    title: `Business Associate Agreement — ${BRAND}`,
    description: `A plain-language summary of what the ${BRAND} Business Associate Agreement covers.`,
  })
  return (
    <div className="page">
      <div className="container-narrow">
        <Link to="/" className="back">← Back to {BRAND}</Link>
        <div className="page-eyebrow">HIPAA</div>
        <h1 className="two-tone">
          <span className="grey">What our BAA</span><br />
          <span className="white">covers.</span>
        </h1>
        <p className="page-sub">
          A plain-language summary. The signed agreement controls; this page explains it. Request
          the full document at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
        <div className="section-head">
          <ul className="plain-list">
            {POINTS.map(p => (
              <li key={p.title}>
                <strong>{p.title}</strong>
                {p.body}
              </li>
            ))}
          </ul>
        </div>
        <p className="muted">
          See also our <Link to="/privacy">Privacy Policy</Link> and <Link to="/terms">Terms of Service</Link>.
        </p>
      </div>
    </div>
  )
}
