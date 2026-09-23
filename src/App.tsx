import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { useScrollReveal } from './hooks/useScrollReveal'
import Home from './pages/Home'
import Audit from './pages/Audit'
import AuditSample from './pages/AuditSample'
import Course from './pages/Course'
import Tools from './pages/Tools'
import Door from './pages/Door'
import Legal from './pages/Legal'
import NotFound from './pages/NotFound'

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  )
}

function Shell() {
  useScrollReveal()
  useHashScroll()

  return (
    <>
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/plan" element={<Door door="plan" />} />
          <Route path="/build" element={<Door door="build" />} />
          <Route path="/train" element={<Door door="train" />} />
          <Route path="/run" element={<Door door="run" />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/audit/sample" element={<AuditSample />} />
          <Route path="/course" element={<Course />} />
          <Route path="/terms" element={<Legal kind="terms" />} />
          <Route path="/privacy" element={<Legal kind="privacy" />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </>
  )
}

/**
 * Small helper: when a route lands with a hash like `/#waitlist`, scroll to it
 * on next paint (react-router doesn't do this by default).
 */
function useHashScroll() {
  const location = useLocation()
  useEffect(() => {
    if (!location.hash) return
    const id = location.hash.slice(1)
    // wait one tick for the destination section to mount
    const t = window.setTimeout(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 40)
    return () => window.clearTimeout(t)
  }, [location.pathname, location.hash])
}
