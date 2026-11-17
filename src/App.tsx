import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Suspense, lazy, useEffect } from 'react'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { useScrollReveal } from './hooks/useScrollReveal'
import Home from './pages/Home'
// Secondary routes load on demand so the homepage bundle stays small.
const Office = lazy(() => import('./pages/Office'))
const Commerce = lazy(() => import('./pages/Commerce'))
const HowItWorks = lazy(() => import('./pages/HowItWorks'))
const Integrations = lazy(() => import('./pages/Integrations'))
const Agents = lazy(() => import('./pages/Agents'))
const Pricing = lazy(() => import('./pages/Pricing'))
const Security = lazy(() => import('./pages/Security'))
const Signup = lazy(() => import('./pages/Signup'))
const Legal = lazy(() => import('./pages/Legal'))
const LegalIndex = lazy(() => import('./pages/LegalIndex'))
const Support = lazy(() => import('./pages/Support'))
const NotFound = lazy(() => import('./pages/NotFound'))

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}

/** The site's pages, by path (tested: every one renders). */
export const PAGES = ['/', '/office', '/commerce', '/how-it-works', '/integrations', '/agents', '/pricing', '/security', '/contact', '/support', '/signup', '/legal', '/terms', '/privacy'] as const

/**
 * Routes from earlier versions of the site. They all go somewhere that exists so old links never 404.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/website': '/',
  '/evv': '/',
  '/baa': '/',
  '/plan': '/pricing',
  '/build': '/',
  '/train': '/',
  '/run': '/',
  '/tools': '/integrations',
  '/audit': '/',
  '/audit/sample': '/',
  '/course': '/',
  '/how': '/how-it-works',
  '/capabilities': '/agents',
}

export function AppRoutes() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Home />} />
        {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route path="/office" element={<Office />} />
        <Route path="/commerce" element={<Commerce />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/security" element={<Security />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/contact" element={<Support />} />
        <Route path="/support" element={<Support />} />
        <Route path="/legal" element={<LegalIndex />} />
        <Route path="/terms" element={<Legal kind="terms" />} />
        <Route path="/privacy" element={<Legal kind="privacy" />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}

export function Shell() {
  useScrollReveal()
  useHashScroll()
  const { pathname } = useLocation()
  useEffect(() => { if (typeof window.scrollTo === 'function') window.scrollTo(0, 0) }, [pathname])

  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <Nav />
      <main id="main">
        <AppRoutes />
      </main>
      <Footer />
    </>
  )
}

/** Hashes from earlier versions of the site that now mean the pilot application form. */
const HASH_ALIASES: Record<string, string> = { waitlist: 'early-access', book: 'early-access' }

/** When a route lands with a hash like `/#faq`, scroll to it on next paint. */
function useHashScroll() {
  const location = useLocation()
  useEffect(() => {
    if (!location.hash) return
    const raw = location.hash.slice(1)
    const id = HASH_ALIASES[raw] ?? raw
    const t = window.setTimeout(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
    return () => window.clearTimeout(t)
  }, [location.pathname, location.hash])
}
