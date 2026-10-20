import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Suspense, lazy, useEffect } from 'react'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { useScrollReveal } from './hooks/useScrollReveal'
import Home from './pages/Home'
// Secondary routes and the chat bubble load on demand so the homepage bundle stays small.
const Legal = lazy(() => import('./pages/Legal'))
const Baa = lazy(() => import('./pages/Baa'))
const Evv = lazy(() => import('./pages/Evv'))
const NotFound = lazy(() => import('./pages/NotFound'))
const ChatBubble = lazy(() => import('./components/ChatBubble').then(m => ({ default: m.ChatBubble })))

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}

/** Old routes from earlier versions of the site: send them to the matching homepage section. */
const LEGACY_REDIRECTS: Record<string, string> = {
  '/plan': '/#how',
  '/build': '/#how',
  '/train': '/#menu',
  '/run': '/#pricing',
  '/tools': '/#menu',
  '/audit': '/#pricing',
  '/audit/sample': '/#pricing',
  '/course': '/#menu',
}

export function Shell() {
  useScrollReveal()
  useHashScroll()

  return (
    <>
      <Nav />
      <main>
        <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}
          <Route path="/terms" element={<Legal kind="terms" />} />
          <Route path="/privacy" element={<Legal kind="privacy" />} />
          <Route path="/baa" element={<Baa />} />
          <Route path="/evv" element={<Evv />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </main>
      <Footer />
      <Suspense fallback={null}><ChatBubble /></Suspense>
    </>
  )
}

/**
 * When a route lands with a hash like `/#pricing`, scroll to it on next paint.
 * Legacy `#waitlist` links map to the book-a-call form.
 */
function useHashScroll() {
  const location = useLocation()
  useEffect(() => {
    if (!location.hash) return
    const id = location.hash.slice(1) === 'waitlist' ? 'book' : location.hash.slice(1)
    const t = window.setTimeout(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
    return () => window.clearTimeout(t)
  }, [location.pathname, location.hash])
}
