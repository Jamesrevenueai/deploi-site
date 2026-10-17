import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BRAND } from '../lib/brand'

const NAV_LINKS = [
  { to: '/#what', label: 'What we do' },
  { to: '/#menu', label: 'Services' },
  { to: '/#how', label: 'How it works' },
  { to: '/#pricing', label: 'Pricing' },
  { to: '/#faq', label: 'FAQ' },
]

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 12)
    h()
    window.addEventListener('scroll', h, { passive: true })
    return () => window.removeEventListener('scroll', h)
  }, [])

  useEffect(() => {
    setOpen(false)
  }, [location.pathname, location.hash])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <nav className={`nav ${scrolled || open ? 'scrolled' : ''}`}>
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label={BRAND}>
          {BRAND.toLowerCase()}
          <span className="dot">.</span>
        </Link>

        <div className="nav-links" aria-label="Primary">
          {NAV_LINKS.map(l => (
            <Link key={l.to} to={l.to} className="nav-link">
              {l.label}
            </Link>
          ))}
        </div>

        <div className="nav-right">
          <Link to="/#waitlist" className="btn btn-primary sm">Book a call</Link>
          <button
            type="button"
            className={`nav-hamburger ${open ? 'open' : ''}`}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>

      <div className={`nav-mobile ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="nav-mobile-inner">
          {NAV_LINKS.map(l => (
            <Link key={l.to} to={l.to} className="nav-mobile-link">
              {l.label}
            </Link>
          ))}
          <Link to="/#waitlist" className="nav-mobile-cta">Book a call →</Link>
        </div>
      </div>
    </nav>
  )
}
