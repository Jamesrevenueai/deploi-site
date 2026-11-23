import { Link } from 'react-router-dom'
import { css } from '../lib/css'
import { env } from '../lib/env'
import { TRIAL_DAYS } from '../lib/pricing'

/** Header links: sections of the homepage (design-ref/site-home.html). From other pages they go to `/#section`. */
export const NAV_LINKS = [
  { to: '/#crew', label: 'Agents' },
  { to: '/#how', label: 'How it works' },
  { to: '/#office', label: 'Office' },
  { to: '/#pricing', label: 'Pricing' },
  { to: '/#faq', label: 'FAQ' },
]
export const TRIAL_LABEL = `Start ${TRIAL_DAYS}-day trial`
/** The Shopify App Store listing is not live yet: every trial / install button goes to the sign-up page. */
export const TRIAL_HREF = '/signup'
export const LOGIN_HREF = () => `${env.appUrl}/login`

/** The node-graph logo mark. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#EEF2FF" /><path d="M10 10 L22 11 L21 22 L11 21 Z M10 10 L21 22" stroke="#A5B4FC" strokeWidth="1.5" fill="none" /><circle cx="10" cy="10" r="3.6" fill="#4F46E5" /><circle cx="22" cy="11" r="2.6" fill="#4F46E5" /><circle cx="11" cy="21" r="2.6" fill="#4F46E5" /><circle cx="21" cy="22" r="2.8" fill="#E8734A" /></svg>
  )
}

export function Wordmark() {
  return <>deploi<span style={css('color: #4F46E5;')}>.ai</span></>
}

const NAV_A = 'min-height: 44px; display: inline-flex; align-items: center; padding: 0 12px; color: #312E81; text-decoration: none; font-size: 15px; font-weight: 600;'

export function Nav() {
  return (
    <div className="dz-x">
      <aside aria-label="Announcement" style={css('background: #1E1B4B; color: #E0E7FF; text-align: center; padding: 10px 16px; font-size: 13px; font-weight: 600;')}>New: <span style={css('color: #FFFFFF;')}>Deploi Office</span> — agents for home services, property managers and leasing agents. <Link to="/#office" style={css('color: #C7D2FE; font-weight: 700;')}>See it →</Link></aside>
      <header style={css('position: relative; z-index: 2; border-bottom: 1px solid #EEF2FF; background: #FFFFFF;')}>
        <div style={css('max-width: 1240px; margin: 0 auto; padding: 16px 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 20px;')}>
          <Link to="/" style={css('display: flex; align-items: center; gap: 10px; text-decoration: none; margin-right: auto;')}>
            <LogoMark />
            <span style={css('font-size: 21px; font-weight: 800; letter-spacing: -0.02em; color: #1E1B4B;')}><Wordmark /></span>
          </Link>
          <nav aria-label="Site" style={css('display: flex; flex-wrap: wrap; gap: 2px;')}>
            {NAV_LINKS.map(l => <Link key={l.to} className="lnk" to={l.to} style={css(NAV_A)}>{l.label}</Link>)}
          </nav>
          <div style={css('display: flex; gap: 8px;')}>
            <a href={LOGIN_HREF()} style={css('min-height: 44px; display: inline-flex; align-items: center; padding: 0 16px; border-radius: 12px; color: #3730A3; text-decoration: none; font-size: 15px; font-weight: 700;')}>Log in</a>
            <Link className="hbtn" to={TRIAL_HREF} style={css('min-height: 44px; display: inline-flex; align-items: center; padding: 0 18px; border-radius: 12px; background: #4F46E5; color: #FFFFFF; text-decoration: none; font-size: 15px; font-weight: 700;')}>{TRIAL_LABEL}</Link>
          </div>
        </div>
      </header>
    </div>
  )
}
