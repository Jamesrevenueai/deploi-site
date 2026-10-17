import { useState, type FormEvent } from 'react'
import { BRAND } from '../lib/brand'

const FORMSPREE_ENDPOINT: string | undefined = import.meta.env.VITE_FORMSPREE_ENDPOINT

type Props = {
  /** Optional hidden `service` field written into the payload. */
  service?: string
}

export function WaitlistForm({ service }: Props) {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const configured = Boolean(FORMSPREE_ENDPOINT && FORMSPREE_ENDPOINT.trim())

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    const fd = new FormData(e.currentTarget)
    const payload: Record<string, string> = {
      name: String(fd.get('name') ?? '').trim(),
      business: String(fd.get('business') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      wants: String(fd.get('wants') ?? '').trim(),
      _source: BRAND + ' book-a-call',
    }
    if (service) payload.service = service

    if (!payload.name || !payload.business || !payload.email) {
      setError('Please fill in name, agency, and email.')
      return
    }

    if (!configured) {
      setError('Form backend is not configured yet. Set VITE_FORMSPREE_ENDPOINT and redeploy.')
      return
    }

    setStatus('submitting')
    try {
      const res = await fetch(FORMSPREE_ENDPOINT!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(detail || `Request failed (${res.status})`)
      }
      setStatus('done')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
  }

  if (status === 'done') {
    return (
      <div className="confirmation">
        <div className="check" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="5 12 10 17 19 8" />
          </svg>
        </div>
        <h3>Got it.</h3>
        <p>We'll reach out within one business day to set up your 20-minute call.</p>
      </div>
    )
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {service && <input type="hidden" name="service" value={service} />}
      <div className="field">
        <label htmlFor={`name-${service ?? 'main'}`}>Name</label>
        <input id={`name-${service ?? 'main'}`} name="name" type="text" autoComplete="name" required />
      </div>
      <div className="field">
        <label htmlFor={`business-${service ?? 'main'}`}>Agency</label>
        <input id={`business-${service ?? 'main'}`} name="business" type="text" autoComplete="organization" required />
      </div>
      <div className="field">
        <label htmlFor={`email-${service ?? 'main'}`}>Work email</label>
        <input id={`email-${service ?? 'main'}`} name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor={`wants-${service ?? 'main'}`}>
          What&rsquo;s leaking right now?
          <span className="optional">(optional)</span>
        </label>
        <textarea id={`wants-${service ?? 'main'}`} name="wants" placeholder="e.g. referrals we answer too late, open shifts, EVV denials, hiring…" />
      </div>
      <button type="submit" className="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : 'Book my call'}
      </button>
      {error && <div className="form-error">{error}</div>}
      {!configured && !error && (
        <div className="form-notice">
          Preview build — form submissions are not yet delivered. Set{' '}
          <code>VITE_FORMSPREE_ENDPOINT</code> to enable.
        </div>
      )}
    </form>
  )
}
