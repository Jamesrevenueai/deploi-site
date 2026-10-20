import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BRAND, WORDMARK } from '../lib/brand'
import { BookButton } from './Button'
import { Icon } from '../lib/icons'

export const NAV_LINKS = [
  { to: '/#what', label: 'What we do' },
  { to: '/#menu', label: 'Services' },
  { to: '/#how', label: 'How it works' },
  { to: '/#pricing', label: 'Pricing' },
  { to: '/evv', label: 'EVV' },
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
    <nav className={`nav ${scrolled || open ? 'scrolled' : ''}`} aria-label="Primary">
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label={`${BRAND} home`}>
          {WORDMARK[0]} <span className="brand-ai">{WORDMARK[1]}</span>
        </Link>

        <div className="nav-right">
          <div className="nav-links">
            {NAV_LINKS.map(l => (
              <Link key={l.to} to={l.to} className="nav-link">
                {l.label}
              </Link>
            ))}
          </div>
          <BookButton size="sm">Book a call</BookButton>
          <button
            type="button"
            className="nav-hamburger"
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>

      <div id="mobile-menu" className={`nav-mobile ${open ? 'open' : ''}`} aria-hidden={!open}>
        <button type="button" className="nav-mobile-close" aria-label="Close menu" onClick={() => setOpen(false)}>
          <Icon.Close width={28} height={28} />
        </button>
        {NAV_LINKS.map(l => (
          <Link key={l.to} to={l.to} className="nav-mobile-link" onClick={() => setOpen(false)}>
            {l.label}
          </Link>
        ))}
        <BookButton>Book a call</BookButton>
      </div>
    </nav>
  )
}
