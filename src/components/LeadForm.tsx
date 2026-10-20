import { useState, type FormEvent } from 'react'
import { submitLead, validateLead, resolveLeadTarget, type LeadSource } from '../lib/leads'
import { Icon } from '../lib/icons'
import { CONTACT_EMAIL } from '../lib/brand'

type Props = {
  source: LeadSource
  /** Label for the submit button. */
  cta?: string
  /** Label for the free-text field. */
  messageLabel?: string
  messagePlaceholder?: string
  /** Hide the agency field (chat panel keeps it short). */
  compact?: boolean
  confirmation?: { title: string; body: string }
}

export function LeadForm({
  source,
  cta = 'Book my call',
  messageLabel = 'What’s leaking right now?',
  messagePlaceholder = 'e.g. referrals we answer too late, no-shows, schedule gaps, denied claims, hiring…',
  compact = false,
  confirmation = { title: 'Got it.', body: 'We’ll reach out within one business day to set up your 20-minute call.' },
}: Props) {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const configured = resolveLeadTarget().kind !== 'none'

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const fd = new FormData(e.currentTarget)
    const payload = {
      name: String(fd.get('name') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      agency_name: String(fd.get('agency_name') ?? (compact ? '—' : '')).trim(),
      phone: String(fd.get('phone') ?? '').trim() || undefined,
      message: String(fd.get('message') ?? '').trim() || undefined,
      source,
    }
    const problem = validateLead(payload)
    if (problem) {
      setError(problem)
      return
    }
    if (!configured) {
      // No backend yet: hand the note to the visitor's mail client instead of failing.
      const body = `Name: ${payload.name}\nPractice: ${payload.agency_name}\nEmail: ${payload.email}\nPhone: ${payload.phone ?? ''}\n\n${payload.message ?? ''}`
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Book a call (${source})`)}&body=${encodeURIComponent(body)}`
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
        <h3>{confirmation.title}</h3>
        <p>{confirmation.body}</p>
      </div>
    )
  }

  const id = (f: string) => `${source}-${f}`
  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor={id('name')}>Name</label>
        <input id={id('name')} name="name" type="text" autoComplete="name" required />
      </div>
      {!compact && (
        <div className="field">
          <label htmlFor={id('agency')}>Practice</label>
          <input id={id('agency')} name="agency_name" type="text" autoComplete="organization" required />
        </div>
      )}
      <div className="field">
        <label htmlFor={id('email')}>Work email</label>
        <input id={id('email')} name="email" type="email" autoComplete="email" required />
      </div>
      {!compact && (
        <div className="field">
          <label htmlFor={id('phone')}>Phone<span className="optional">(optional)</span></label>
          <input id={id('phone')} name="phone" type="tel" autoComplete="tel" />
        </div>
      )}
      <div className="field">
        <label htmlFor={id('message')}>
          {messageLabel}
          {!compact && <span className="optional">(optional)</span>}
        </label>
        <textarea id={id('message')} name="message" placeholder={messagePlaceholder} />
      </div>
      <button type="submit" className="btn btn-ghost" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : cta}
      </button>
      {error && <div className="form-error" role="alert">{error}</div>}
      {import.meta.env.DEV && !configured && !error && (
        <div className="form-notice">Preview build: submissions are not delivered until the lead API is configured.</div>
      )}
    </form>
  )
}
