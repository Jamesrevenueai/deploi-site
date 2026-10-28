import { useState, type FormEvent } from 'react'
import {
  CATALOG_SIZES,
  PLATFORMS,
  earlyAccessPayload,
  leadMailBody,
  resolveLeadTarget,
  submitLead,
  validateLead,
} from '../lib/leads'
import { Icon } from '../lib/icons'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { CTA_LABEL } from './Button'

/**
 * "Apply for Early Access". Posts to the app lead API (service_interest "early_access"),
 * falls back to Formspree, and opens the visitor's mail client when neither is configured.
 * There is no password or API key field, on purpose.
 */
export function EarlyAccessForm() {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const configured = resolveLeadTarget().kind !== 'none'

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const payload = earlyAccessPayload(new FormData(e.currentTarget))
    const problem = validateLead(payload)
    if (problem) {
      setError(problem)
      return
    }
    if (!configured) {
      // No backend yet: hand the application to the visitor's mail client instead of failing.
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Early access application')}&body=${encodeURIComponent(leadMailBody(payload))}`
      setStatus('done')
      return
    }
    setStatus('submitting')
    try {
      await submitLead(payload)
      setStatus('done')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
  }

  if (status === 'done') {
    return (
      <div className="confirmation" role="status">
        <div className="check" aria-hidden="true"><Icon.Check width={22} height={22} /></div>
        <h3>Application received.</h3>
        <p>
          Thank you. We will reply by email. We will never ask you to send a password or API key by email or
          through a form.
        </p>
      </div>
    )
  }

  return (
    <form className="form form-wide" onSubmit={handleSubmit} noValidate aria-label={CTA_LABEL}>
      <div className="field-row">
        <div className="field">
          <label htmlFor="ea-name">Name</label>
          <input id="ea-name" name="name" type="text" autoComplete="name" required />
        </div>
        <div className="field">
          <label htmlFor="ea-email">Work email</label>
          <input id="ea-email" name="email" type="email" autoComplete="email" required />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="ea-company">Store or company name</label>
          <input id="ea-company" name="agency_name" type="text" autoComplete="organization" required />
        </div>
        <div className="field">
          <label htmlFor="ea-url">Store URL</label>
          <input id="ea-url" name="store_url" type="url" inputMode="url" placeholder="https://" autoComplete="url" required />
        </div>
      </div>
      <fieldset className="fieldset">
        <legend>Platforms you sell on</legend>
        <p className="field-hint">Choose at least one. You only need one platform to use {BRAND}.</p>
        <div className="check-group">
          {PLATFORMS.map(p => (
            <label className="check-option" key={p.value}>
              <input type="checkbox" name="platforms" value={p.value} defaultChecked={p.value === 'shopify'} />
              <span className="check-label">{p.label}</span>
              {p.planned && <span className="check-hint">Planned</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="ea-size">Approximate number of products<span className="optional">(optional)</span></label>
        <select id="ea-size" name="catalog_size" defaultValue="">
          <option value="">Choose a range</option>
          {CATALOG_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ea-message">The stock or listing problem you most want solved<span className="optional">(optional)</span></label>
        <textarea id="ea-message" name="message" placeholder="e.g. products keep selling after they run out, or stock shows below zero at one location" />
      </div>
      {/* Honeypot: hidden from people and screen readers; bots that fill it are dropped by the API. */}
      <div className="hp" aria-hidden="true">
        <label htmlFor="ea-website">Leave this field empty</label>
        <input id="ea-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <p className="form-notice">Never send passwords or API keys through this form.</p>
      <button type="submit" className="btn btn-primary" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : CTA_LABEL}
      </button>
      {error && <div className="form-error" role="alert">{error}</div>}
      {import.meta.env.DEV && !configured && !error && (
        <div className="form-notice">Preview build: no lead API is configured, so submitting opens your mail client.</div>
      )}
    </form>
  )
}
