import { Link } from 'react-router-dom'
import { BRAND, CONTACT_EMAIL, WORDMARK } from '../lib/brand'
import { bookCtaLabel } from './Button'
import { Icon } from '../lib/icons'

export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer>
      <div className="container">
        <div className="footer-brand">{WORDMARK[0]} <span className="brand-ai">{WORDMARK[1]}</span></div>
        <p className="footer-tag">Done-for-you operations for home care agencies first; other small healthcare practices by conversation.</p>
        <div className="footer-social">
          <a href="https://www.linkedin.com/company/getdeploi" aria-label={`${BRAND} on LinkedIn`} rel="noopener noreferrer" target="_blank"><Icon.LinkedIn /></a>
          <a href="https://www.youtube.com/@getdeploi" aria-label={`${BRAND} on YouTube`} rel="noopener noreferrer" target="_blank"><Icon.YouTube /></a>
          <a href="https://x.com/getdeploi" aria-label={`${BRAND} on X`} rel="noopener noreferrer" target="_blank"><Icon.X /></a>
        </div>

        <div className="footer-cols">
          <div className="footer-col">
            <div className="footer-col-title">Navigation</div>
            <ul>
              <li><Link to="/#what">What we do</Link></li>
              <li><Link to="/#menu">Services</Link></li>
              <li><Link to="/#how">How it works</Link></li>
              <li><Link to="/#pricing">Pricing</Link></li>
              <li><Link to="/website">Website Improvement</Link></li>
              <li><Link to="/evv">EVV exception management</Link></li>
              <li><Link to="/#faq">FAQ</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Support</div>
            <ul>
              <li><Link to="/#book">{bookCtaLabel()}</Link></li>
              <li><Link to="/baa">Business Associate Agreement</Link></li>
              <li><Link to="/terms">Terms of Service</Link></li>
              <li><Link to="/privacy">Privacy Policy</Link></li>
              <li><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
            </ul>
          </div>
        </div>

        <div className="footer-copy">© {year} {BRAND}. All rights reserved.</div>
      </div>
    </footer>
  )
}
