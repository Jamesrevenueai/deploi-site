import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'

export default function NotFound() {
  useSeo({
    title: `Page not found — ${BRAND}`,
    description: 'The page you were looking for does not exist.',
  })
  return (
    <section className="page-hero">
      <div className="container">
        <div className="page-eyebrow reveal">404</div>
        <h1 className="reveal d1">This page doesn't exist.</h1>
        <p className="page-sub reveal d2">
          The link you followed is broken or the page has moved.
        </p>
        <div className="page-actions reveal d3">
          <Link to="/" className="btn btn-primary">
            Back to {BRAND}
            <span className="arrow" aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </section>
  )
}
