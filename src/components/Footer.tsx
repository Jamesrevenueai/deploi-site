import { Link } from 'react-router-dom'
import { BRAND, CONTACT_EMAIL, LEGAL } from '../lib/brand'
import { CTA_HREF, CTA_LABEL } from './Button'
import { NAV_LINKS, Wordmark } from './Nav'
import { CORE_MESSAGE } from '../lib/site-config'

export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-top">
          <div>
            <div className="footer-brand"><Wordmark /></div>
            <p className="footer-tag">{CORE_MESSAGE}</p>
          </div>
          <div className="footer-cols">
            <div className="footer-col">
              <div className="footer-col-title">Product</div>
              <ul>
                {NAV_LINKS.map(l => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
              </ul>
            </div>
            <div className="footer-col">
              <div className="footer-col-title">Get started</div>
              <ul>
                <li><Link to={CTA_HREF}>{CTA_LABEL}</Link></li>
                <li><Link to="/signup">Sign up</Link></li>
                <li><Link to="/contact">Contact</Link></li>
                <li><Link to="/support">Support</Link></li>
              </ul>
            </div>
            <div className="footer-col">
              <div className="footer-col-title">Legal</div>
              <ul>
                <li><Link to="/privacy">Privacy Policy</Link></li>
                <li><Link to="/terms">Terms of Service</Link></li>
                <li><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
              </ul>
            </div>
          </div>
        </div>
        <p className="footer-fine">
          Shopify, WooCommerce, HubSpot, Google Calendar, QuickBooks and the other names on this site are trademarks of their respective owners.
          {' '}{BRAND} connects through each service&rsquo;s official API and is not affiliated with or endorsed by them; integrations are not partnerships.
        </p>
        <div className="footer-copy">© {year} {LEGAL.entity}. {BRAND} is operated by {LEGAL.entity}, {LEGAL.location}. All rights reserved.</div>
      </div>
    </footer>
  )
}
