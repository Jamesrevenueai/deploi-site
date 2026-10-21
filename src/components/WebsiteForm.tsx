import { useState, type FormEvent } from 'react'
import {
  ACCESS_STATUSES,
  MAX_WEBSITE_PAGES,
  WEBSITE_PLATFORMS,
  cleanPages,
  resolveLeadTarget,
  submitLead,
  validateLead,
  type AccessStatus,
  type LeadPayload,
  type WebsitePlatform,
} from '../lib/leads'
import { Icon } from '../lib/icons'
import { CONTACT_EMAIL } from '../lib/brand'

const SOURCE = 'site' as const

/** Builds the lead payload from the form. Exported so tests can check the mapping without a browser. */
export function websitePayload(fd: FormData): LeadPayload {
  const str = (k: string) => String(fd.get(k) ?? '').trim()
  const approvalName = str('approval_name')
  const approvalEmail = str('approval_email')
  const approval = [approvalName, approvalEmail].filter(Boolean).join(' <') + (approvalEmail && approvalName ? '>' : '')
  const platform = str('website_platform') as WebsitePlatform
  const access = str('access_status') as AccessStatus
  return {
    name: str('name'),
    email: str('email'),
    phone: str('phone') || undefined,
    agency_name: str('agency_name'),
    source: SOURCE,
    website: String(fd.get('website') ?? '') || undefined,
    service_interest: 'website_improvement',
    website_url: str('website_url'),
    website_platform: platform || undefined,
    website_goal: str('website_goal'),
    website_pages: cleanPages([str('page_1'), str('page_2'), str('page_3')]),
    website_changes: str('website_changes'),
    website_issues: str('website_issues') || undefined,
    access_status: access || undefined,
    approval_contact: approval || undefined,
    message: [
      `Website improvement request for ${str('website_url')}`,
      approval ? `Approval contact: ${approval}` : '',
    ].filter(Boolean).join('\n'),
  }
}

export function WebsiteForm() {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const configured = resolveLeadTarget().kind !== 'none'

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const payload = websitePayload(new FormData(e.currentTarget))
    const problem = validateLead(payload)
    if (problem) {
      setError(problem)
      return
    }
    if (!configured) {
      const body = [
        `Name: ${payload.name}`,
        `Agency or practice: ${payload.agency_name}`,
        `Email: ${payload.email}`,
        `Phone: ${payload.phone ?? ''}`,
        `Website: ${payload.website_url}`,
        `Platform: ${payload.website_platform ?? ''}`,
        `Goal: ${payload.website_goal ?? ''}`,
        `Pages: ${(payload.website_pages ?? []).join(', ')}`,
        `Changes: ${payload.website_changes ?? ''}`,
        `Known problems: ${payload.website_issues ?? ''}`,
        `Access: ${payload.access_status ?? ''}`,
        `Approval contact: ${payload.approval_contact ?? ''}`,
      ].join('\n')
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Website improvement request')}&body=${encodeURIComponent(body)}`
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
        <h3>Request received.</h3>
        <p>We will reply within one business day to confirm the scope. We will arrange website access securely at that point; please do not email passwords.</p>
      </div>
    )
  }

  return (
    <form className="form form-wide" onSubmit={handleSubmit} noValidate aria-label="Request website improvements">
      <fieldset className="fieldset">
        <legend>About you</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor="wi-name">Name</label>
            <input id="wi-name" name="name" type="text" autoComplete="name" required />
          </div>
          <div className="field">
            <label htmlFor="wi-email">Work email</label>
            <input id="wi-email" name="email" type="email" autoComplete="email" required />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="wi-phone">Phone<span className="optional">(optional)</span></label>
            <input id="wi-phone" name="phone" type="tel" autoComplete="tel" />
          </div>
          <div className="field">
            <label htmlFor="wi-agency">Practice or agency name</label>
            <input id="wi-agency" name="agency_name" type="text" autoComplete="organization" required />
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Your website</legend>
        <div className="field-row">
          <div className="field">
            <label htmlFor="wi-url">Website URL</label>
            <input id="wi-url" name="website_url" type="url" inputMode="url" placeholder="https://" autoComplete="url" required />
          </div>
          <div className="field">
            <label htmlFor="wi-platform">Website platform</label>
            <select id="wi-platform" name="website_platform" defaultValue="" required>
              <option value="" disabled>Choose one</option>
              {WEBSITE_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="wi-goal">Main business goal</label>
          <input id="wi-goal" name="website_goal" type="text" placeholder="e.g. more families calling about private-pay care, more aide applications" required />
        </div>
        <div className="field">
          <span className="field-label">Up to {MAX_WEBSITE_PAGES} pages to improve<span className="optional">(optional)</span></span>
          <div className="field-row three">
            {[1, 2, 3].map(n => (
              <input key={n} name={`page_${n}`} type="text" aria-label={`Page ${n} to improve`} placeholder={n === 1 ? 'e.g. Home' : n === 2 ? 'e.g. Services' : 'e.g. Contact'} />
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="wi-changes">Requested changes</label>
          <textarea id="wi-changes" name="website_changes" placeholder="What should be clearer, easier or fixed? Which buttons, forms or sections?" required />
        </div>
        <div className="field">
          <label htmlFor="wi-issues">Known technical problems<span className="optional">(optional)</span></label>
          <textarea id="wi-issues" name="website_issues" placeholder="e.g. the contact form does not deliver, the menu overlaps on phones" />
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>Access and approval</legend>
        <div className="field">
          <label htmlFor="wi-access">Access status</label>
          <select id="wi-access" name="access_status" defaultValue="" required>
            <option value="" disabled>Choose one</option>
            {ACCESS_STATUSES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        <p className="form-notice">Never send passwords through this form; we will arrange access securely.</p>
        <div className="field-row">
          <div className="field">
            <label htmlFor="wi-approval-name">Approval contact name<span className="optional">(optional)</span></label>
            <input id="wi-approval-name" name="approval_name" type="text" />
          </div>
          <div className="field">
            <label htmlFor="wi-approval-email">Approval contact email<span className="optional">(optional)</span></label>
            <input id="wi-approval-email" name="approval_email" type="email" />
          </div>
        </div>
      </fieldset>

      {/* Honeypot: hidden from people and screen readers; bots that fill it are dropped by the API. */}
      <div className="hp" aria-hidden="true">
        <label htmlFor="wi-website">Leave this field empty</label>
        <input id="wi-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <p className="form-notice">Please do not submit medical information through this form.</p>
      <button type="submit" className="btn btn-primary" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending…' : 'Request website improvements'}
      </button>
      {error && <div className="form-error" role="alert">{error}</div>}
      {import.meta.env.DEV && !configured && !error && (
        <div className="form-notice">Preview build: submissions are not delivered until the lead API is configured.</div>
      )}
    </form>
  )
}
