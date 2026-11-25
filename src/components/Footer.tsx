import { Link } from 'react-router-dom'
import { BRAND, LEGAL } from '../lib/brand'
import { css } from '../lib/css'
import { Wordmark } from './Nav'

export const FOOTER_TAGLINE = 'AI agents that run your store and your office — with proof of every action.'
export const TRADEMARK_LINE = 'Shopify is a trademark of Shopify Inc.'

const COL = 'flex: 0 1 180px; display: flex; flex-direction: column; gap: 4px; font-size: 15px;'
const A = 'min-height: 36px; display: flex; align-items: center; color: #3730A3; text-decoration: none;'
const SMALL = 'max-width: 1240px; margin: 0 auto; padding: 0 24px 32px; font-size: 13px; color: #3730A3;'

export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="dz-x" style={css('border-top: 1px solid #E0E7FF;')}>
      <div style={css('max-width: 1240px; margin: 0 auto; padding: 56px 24px 40px; display: flex; flex-wrap: wrap; gap: 40px;')}>
        <div style={css('flex: 1 1 280px; display: flex; flex-direction: column; gap: 12px;')}>
          <span style={css('font-weight: 800; font-size: 20px;')}><Wordmark /></span>
          <span style={css('font-size: 15px; line-height: 1.6; color: #3730A3; max-width: 300px;')}>{FOOTER_TAGLINE}</span>
        </div>
        <nav aria-label="Product" style={css(COL)}><span style={css('font-weight: 800; padding-bottom: 6px;')}>Product</span><Link className="lnk" to="/#crew" style={css(A)}>Store agents</Link><Link className="lnk" to="/#office" style={css(A)}>Deploi Office</Link><Link className="lnk" to="/#pricing" style={css(A)}>Pricing</Link></nav>
        <nav aria-label="Company" style={css(COL)}><span style={css('font-weight: 800; padding-bottom: 6px;')}>Company</span><Link className="lnk" to="/support" style={css(A)}>Support</Link><Link className="lnk" to="/privacy" style={css(A)}>Privacy</Link><Link className="lnk" to="/terms" style={css(A)}>Terms</Link></nav>
      </div>
      <div style={css(SMALL)}>© {year} {BRAND}. {TRADEMARK_LINE}<br />{BRAND} is operated by {LEGAL.entity}, {LEGAL.location}.</div>
    </footer>
  )
}
