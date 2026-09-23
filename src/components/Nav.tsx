import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { BRAND } from '../lib/brand'

const NAV_LINKS = [
  { to: '/plan', label: 'Plan' },
  { to: '/build', label: 'Build' },
  { to: '/train', label: 'Train' },
  { to: '/run', label: 'Run' },
  { to: '/tools', label: 'Tools' },
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
  }, [location.pathname])

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <nav className={`nav ${scrolled || open ? 'scrolled' : ''}`}>
      <div className="nav-inner">
        <Link to="/" className="brand" aria-label={BRAND}>
          {BRAND}
          <span className="dot">.</span>
        </Link>

        <div className="nav-links" role="menubar" aria-label="Primary">
          {NAV_LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              {l.label}
            </NavLink>
          ))}
        </div>

        <div className="nav-right">
          <Link to="/audit" className="nav-cta primary">Get an AI Audit</Link>
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
            <NavLink key={l.to} to={l.to} className="nav-mobile-link">
              {l.label}
            </NavLink>
          ))}
          <Link to="/audit" className="nav-mobile-cta">Get an AI Audit →</Link>
          <Link to="/course" className="nav-mobile-link">Course</Link>
        </div>
      </div>
    </nav>
  )
}
