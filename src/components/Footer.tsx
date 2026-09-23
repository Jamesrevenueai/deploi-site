import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'

export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer>
      <div className="container">
        <div className="footer-top">
          <div className="footer-brand-block">
            <div className="footer-brand">
              {BRAND}
              <span className="dot">.</span>
            </div>
            <p className="footer-tag">
              We deploy your AI &mdash; and keep it running. Private-by-design AI workers for
              small businesses, managed for you every month.
            </p>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Product</div>
            <ul>
              <li><Link to="/plan">Plan</Link></li>
              <li><Link to="/build">Build</Link></li>
              <li><Link to="/train">Train</Link></li>
              <li><Link to="/run">Run</Link></li>
              <li><Link to="/tools">Tools</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Start</div>
            <ul>
              <li><Link to="/audit">Get an AI Audit</Link></li>
              <li><Link to="/audit/sample">Sample report</Link></li>
              <li><Link to="/course">Course</Link></li>
              <li><Link to="/#waitlist">Waitlist</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Legal</div>
            <ul>
              <li><Link to="/terms">Terms of Service</Link></li>
              <li><Link to="/privacy">Privacy Policy</Link></li>
            </ul>
          </div>
        </div>

        <div className="footer-disclaimer">
          <p>
            {BRAND} provides AI consulting, training and implementation. We do not provide legal,
            tax or compliance advice. Savings figures are estimates, not guarantees.
          </p>
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
