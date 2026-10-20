import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { ChatBubble } from './components/ChatBubble'
import { useScrollReveal } from './hooks/useScrollReveal'
import Home from './pages/Home'
import Legal from './pages/Legal'
import Baa from './pages/Baa'
import Evv from './pages/Evv'
import NotFound from './pages/NotFound'

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
      </main>
      <Footer />
      <ChatBubble />
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
