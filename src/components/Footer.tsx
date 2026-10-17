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
              {BRAND.toLowerCase()}
              <span className="dot">.</span>
            </div>
            <p className="footer-tag">
              Operations &amp; technology for Medicaid home care and DODD agencies. More clients,
              more aides, fewer missed visits &mdash; built on the systems you already use.
            </p>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Site</div>
            <ul>
              <li><Link to="/#what">What we do</Link></li>
              <li><Link to="/#menu">Services</Link></li>
              <li><Link to="/#how">How it works</Link></li>
              <li><Link to="/#pricing">Pricing</Link></li>
              <li><Link to="/#faq">FAQ</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Company</div>
            <ul>
              <li><Link to="/#waitlist">Book a call</Link></li>
              <li><Link to="/terms">Terms of Service</Link></li>
              <li><Link to="/privacy">Privacy Policy</Link></li>
            </ul>
          </div>
        </div>

        <div className="footer-disclaimer">
          <p>
            {BRAND} provides operations consulting, software implementation and managed services to
            home care agencies. We do not provide legal, tax or compliance advice. Figures quoted are
            estimates, not guarantees. A Business Associate Agreement is signed before any client
            data is shared.
          </p>
        </div>

        <div className="footer-bottom">
          <div className="footer-copy">© {year} {BRAND} · Ohio, USA · All rights reserved</div>
          <div className="footer-status" aria-label="status">
            <span className="led" aria-hidden="true"></span>
            Taking new agencies
          </div>
        </div>
      </div>
    </footer>
  )
}
