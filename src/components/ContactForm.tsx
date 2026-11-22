import { useState, type FormEvent } from 'react'
import { CONTACT_TOPICS, ContactUnavailable, contactEndpoint, submitContact, validateContact, type ContactPayload, type ContactTopic } from '../lib/contact'
import { CONTACT_EMAIL } from '../lib/brand'

/**
 * Contact form: posts to the app's rate-limited public contact endpoint (/api/public/contact). Without an app
 * API configured it opens the visitor's mail client instead. There is no password or API key field, on purpose.
 */
export function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [openedAt] = useState(() => Date.now())
  const url = contactEndpoint()

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const f = new FormData(e.currentTarget)
    const p: ContactPayload = {
      name: String(f.get('name') ?? '').trim(), email: String(f.get('email') ?? '').trim(), company: String(f.get('company') ?? '').trim() || undefined,
      topic: (String(f.get('topic') ?? 'other') as ContactTopic), message: String(f.get('message') ?? '').trim(), website: String(f.get('website') ?? ''), elapsed_ms: Date.now() - openedAt,
    }
    const problem = validateContact(p)
    if (problem) { setError(problem); return }
    const byEmail = () => {
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Contact (${p.topic})`)}&body=${encodeURIComponent(`${p.message}\n\n${p.name}${p.company ? `, ${p.company}` : ''}`)}`
      setStatus('done')
    }
    if (!url) { byEmail(); return }
    setStatus('sending')
    try { await submitContact(url, p); setStatus('done') } catch (err) {
      if (err instanceof ContactUnavailable) { byEmail(); return }
      setStatus('idle'); setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  if (status === 'done') return <div className="confirmation" role="status"><h3>Message sent.</h3><p>Thank you. We will reply by email.</p></div>
  return (
    <form className="form" onSubmit={onSubmit} noValidate aria-label="Contact us">
      <div className="field-row">
        <div className="field"><label htmlFor="ct-name">Name</label><input id="ct-name" name="name" type="text" autoComplete="name" required /></div>
        <div className="field"><label htmlFor="ct-email">Email</label><input id="ct-email" name="email" type="email" autoComplete="email" required /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="ct-company">Company (optional)</label><input id="ct-company" name="company" type="text" autoComplete="organization" /></div>
        <div className="field"><label htmlFor="ct-topic">Topic</label><select id="ct-topic" name="topic" defaultValue="sales">{CONTACT_TOPICS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
      </div>
      <div className="field"><label htmlFor="ct-message">Message</label><textarea id="ct-message" name="message" rows={5} maxLength={4000} required /></div>
      <div className="hp" aria-hidden="true"><label htmlFor="ct-website">Leave this field empty</label><input id="ct-website" name="website" type="text" tabIndex={-1} autoComplete="off" /></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button type="submit" className="btn btn-primary" disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Send message'}</button>
      <p className="form-notice">Never send passwords or access keys through this form.</p>
    </form>
  )
}
