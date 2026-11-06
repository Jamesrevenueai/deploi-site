import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { CtaButton } from './Button'
import { Icon } from '../lib/icons'

export const NAV_LINKS = [
  { to: '/office', label: 'Deploi Office' },
  { to: '/commerce', label: 'Deploi Commerce' },
  { to: '/how-it-works', label: 'How it works' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/agents', label: 'Agents' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/security', label: 'Security' },
]

export function Wordmark() {
  return <>deploi<span className="dot">.</span></>
}

export function Nav() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  useEffect(() => { setOpen(false) }, [location.pathname, location.hash])
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label={`${BRAND} home`}><Wordmark /></Link>
        <div className="nav-links">
          {NAV_LINKS.map(l => <NavLink key={l.to} to={l.to} className="nav-link">{l.label}</NavLink>)}
        </div>
        <div className="nav-right">
          <Link to="/signup" className="nav-link nav-signin">Sign up</Link>
          <CtaButton size="sm" className="nav-cta" />
          <button type="button" className="nav-hamburger" aria-label="Open menu" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(true)}>
            <span /><span /><span />
          </button>
        </div>
      </div>
      <div id="mobile-menu" className={`nav-mobile ${open ? 'open' : ''}`} aria-hidden={!open}>
        <button type="button" className="nav-mobile-close" aria-label="Close menu" onClick={() => setOpen(false)}><Icon.Close width={26} height={26} /></button>
        {NAV_LINKS.map(l => <Link key={l.to} to={l.to} className="nav-mobile-link" onClick={() => setOpen(false)}>{l.label}</Link>)}
        <Link to="/signup" className="nav-mobile-link" onClick={() => setOpen(false)}>Sign up</Link>
        <Link to="/contact" className="nav-mobile-link" onClick={() => setOpen(false)}>Contact</Link>
        <CtaButton />
      </div>
    </nav>
  )
}
