import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Suspense, lazy, useEffect } from 'react'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { useScrollReveal } from './hooks/useScrollReveal'
import Home from './pages/Home'
// Secondary routes load on demand so the homepage bundle stays small.
const Legal = lazy(() => import('./pages/Legal'))
const Support = lazy(() => import('./pages/Support'))
const NotFound = lazy(() => import('./pages/NotFound'))

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}

/**
 * Routes from earlier versions of the site. They all go to the homepage so old links never 404.
 * Pages from before the agent product (/website, /evv, /baa) send old links to the home page.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/website': '/',
  '/evv': '/',
  '/baa': '/',
  '/plan': '/',
  '/build': '/',
  '/train': '/',
  '/run': '/',
  '/tools': '/',
  '/audit': '/',
  '/audit/sample': '/',
  '/course': '/',
}

export function AppRoutes() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Home />} />
        {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route path="/terms" element={<Legal kind="terms" />} />
        <Route path="/privacy" element={<Legal kind="privacy" />} />
        <Route path="/support" element={<Support />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}

export function Shell() {
  useScrollReveal()
  useHashScroll()

  return (
    <>
      <Nav />
      <main>
        <AppRoutes />
      </main>
      <Footer />
    </>
  )
}

/** Hashes from earlier versions of the site that now mean the early access form. */
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
