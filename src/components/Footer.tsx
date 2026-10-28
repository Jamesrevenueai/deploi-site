import { Link } from 'react-router-dom'
import { BRAND, CONTACT_EMAIL, WORDMARK } from '../lib/brand'
import { CTA_HREF, CTA_LABEL } from './Button'
import { NAV_LINKS } from './Nav'

export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer>
      <div className="container">
        <div className="footer-brand">{WORDMARK[0]} <span className="brand-ai">{WORDMARK[1]}</span></div>
        <p className="footer-tag">Find stock and listing problems. Approve the fix. See it verified.</p>

        <div className="footer-cols">
          <div className="footer-col">
            <div className="footer-col-title">Product</div>
            <ul>
              {NAV_LINKS.map(l => (
                <li key={l.to}><Link to={l.to}>{l.label}</Link></li>
              ))}
              <li><Link to={CTA_HREF}>{CTA_LABEL}</Link></li>
            </ul>
          </div>
          <div className="footer-col">
            <div className="footer-col-title">Company</div>
            <ul>
              <li><Link to="/privacy">Privacy Policy</Link></li>
              <li><Link to="/terms">Terms of Service</Link></li>
              <li><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
            </ul>
          </div>
        </div>

        <p className="footer-fine">
          Shopify, WooCommerce and Amazon are trademarks of their respective owners. {BRAND} connects through each
          platform&rsquo;s official API and is not affiliated with or endorsed by them.
        </p>
        <div className="footer-copy">© {year} {BRAND}. All rights reserved.</div>
      </div>
    </footer>
  )
}
