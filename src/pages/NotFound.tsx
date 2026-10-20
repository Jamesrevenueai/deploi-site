import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'

export default function NotFound() {
  useSeo({
    title: `Page not found — ${BRAND}`,
    description: 'The page you were looking for does not exist.',
  })
  return (
    <div className="page">
      <div className="container-narrow">
        <div className="page-eyebrow">404</div>
        <h1 className="two-tone">
          <span className="grey">This page</span><br />
          <span className="white">doesn’t exist.</span>
        </h1>
        <p className="page-sub">The link you followed is broken or the page has moved.</p>
        <div className="page-actions">
          <Link to="/" className="btn btn-primary">Back to {BRAND}</Link>
        </div>
      </div>
    </div>
  )
}
