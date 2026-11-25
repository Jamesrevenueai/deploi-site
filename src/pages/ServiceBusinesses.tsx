import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { BRAND, CONTACT_EMAIL } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { Cards, PageHero, Section, Steps } from '../components/Page'
import { Icon } from '../lib/icons'
import { BUSINESS_CHOICES, TOOLS, officeSignupPayload, submitOfficeSignup } from '../lib/office-signup'

/** What each agent does, in plain words. Every one starts in "ask me first" until the owner says otherwise. */
export const SERVICE_AGENTS = [
  { title: 'Missed Call Agent', body: 'When you can’t pick up, it texts the caller back right away, asks what they need, adds them to your CRM as a new lead and texts you the details with a link.' },
  { title: 'Booking Agent', body: 'Texts the customer open times from your calendar, books the one they pick, confirms it, reminds them the day before, and moves it if they need a different time.' },
  { title: 'Lead responder', body: 'Answers new leads from your website form or email with your message and three times you are free.' },
  { title: 'Crew dispatcher', body: 'Sends each scheduled job to the right crew member with the address, time and what to do, and checks they confirmed. They text DONE when the job is finished.' },
  { title: 'Job invoicer', body: 'When the crew marks the job done, it creates the invoice in QuickBooks and sends it to the customer.' },
  { title: 'Payment chaser', body: 'Follows up invoices that are late on a polite schedule, notes part payments, and tells you when it is paid.' },
]
export const BY_BUSINESS = [
  { title: 'HVAC, construction and landscaping', body: 'Missed calls turned into booked visits, crews dispatched with the job details, invoices sent when the work is done.' },
  { title: 'Property managers', body: 'Maintenance requests sent to the right vendor, tenants kept updated, rent reminders and leasing inquiries answered.' },
  { title: 'Real estate and leasing agents', body: 'Every inquiry answered with times to view, showings booked, the CRM kept current, and commission invoices tracked after move-in.' },
]

function SignupForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [openedAt] = useState(() => Date.now())
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const p = officeSignupPayload(new FormData(e.currentTarget))
    if ('error' in p) { setError(p.error); return }
    setStatus('sending')
    try { await submitOfficeSignup({ ...p, elapsed_ms: Date.now() - openedAt }); setStatus('done') } catch (err) { setStatus('idle'); setError(err instanceof Error ? err.message : 'Something went wrong.') }
  }
  if (status === 'done') return (
    <div className="confirmation" role="status">
      <div className="check" aria-hidden="true"><Icon.Check width={22} height={22} /></div>
      <h3>You’re on the list.</h3>
      <p>We will email you an invite to set up your account. Then you connect your tools and choose which agents to switch on. We will never ask for a password or API key by email.</p>
    </div>
  )
  return (
    <form className="form form-wide" onSubmit={onSubmit} noValidate aria-label="Sign up your business">
      <div className="field-row">
        <div className="field"><label htmlFor="os-name">Name</label><input id="os-name" name="name" autoComplete="name" required /></div>
        <div className="field"><label htmlFor="os-email">Work email</label><input id="os-email" name="email" type="email" autoComplete="email" required /></div>
      </div>
      <div className="field-row">
        <div className="field"><label htmlFor="os-company">Business name</label><input id="os-company" name="company" autoComplete="organization" required /></div>
        <div className="field"><label htmlFor="os-phone">Mobile for your updates<span className="optional">(optional)</span></label><input id="os-phone" name="phone" type="tel" autoComplete="tel" placeholder="+1 555 010 0100" /></div>
      </div>
      <div className="field">
        <label htmlFor="os-business">What kind of business?</label>
        <select id="os-business" name="business" defaultValue="" required>
          <option value="">Choose one</option>
          {BUSINESS_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <fieldset className="fieldset">
        <legend>Tools you use today<span className="optional">(optional)</span></legend>
        <div className="check-group">{TOOLS.map(t => <label className="check-option" key={t.value}><input type="checkbox" name="tools" value={t.value} /><span className="check-label">{t.label}</span></label>)}</div>
      </fieldset>
      <div className="field"><label htmlFor="os-message">What slips through the cracks today?<span className="optional">(optional)</span></label><textarea id="os-message" name="message" placeholder="e.g. we miss calls while we are on a job, or invoices go out late" /></div>
      <div className="hp" aria-hidden="true"><label htmlFor="os-website">Leave this field empty</label><input id="os-website" name="website" tabIndex={-1} autoComplete="off" /></div>
      <p className="form-notice">Never send passwords or API keys through this form.</p>
      <button type="submit" className="btn btn-primary" disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Sign up my business'}</button>
      {error && <div className="form-error" role="alert">{error}</div>}
    </form>
  )
}

export default function ServiceBusinesses() {
  useSeo({ title: `For service businesses — ${BRAND}`, description: 'AI agents for HVAC, construction, landscaping, property managers and real estate agents: missed calls texted back, jobs booked, crews dispatched, invoices sent and chased. Pilot.' })
  return (
    <div className="page">
      <PageHero eyebrow="For service businesses · Pilot" title="Stop losing jobs to missed calls and late invoices." lead={`${BRAND} gives your business a small team of AI agents. They text back the calls you miss, book the visit, send the job to your crew, invoice when it is done and chase the payment. You get a text when something needs you.`}>
        <a href="#sign-up" className="btn btn-primary">Sign up my business</a>
      </PageHero>
      <Section title="What the agents do" lead="Each agent starts by asking you first. Once you trust it, let it act and tell you after."><Cards items={SERVICE_AGENTS} cols={3} /></Section>
      <Section title="Built for your kind of business" tone="alt"><Cards items={BY_BUSINESS} cols={3} /></Section>
      <Section title="How it starts">
        <Steps steps={[
          { title: 'Sign up', body: 'Tell us about your business and the tools you use. We email you an invite.' },
          { title: 'Connect your tools', body: 'Connect your calendar, your CRM and QuickBooks, and get a Deploi number your missed calls forward to.' },
          { title: 'Switch on agents', body: 'Choose the agents you want. They start in "ask me first", and you get a text with a link for anything that needs you.' },
        ]} />
      </Section>
      <Section id="sign-up" title="Sign up your business" tone="alt" lead="Pilot: we set up each business with you. Questions first? Contact us.">
        <SignupForm />
        <p className="muted pt">Already invited? <a href="/signup">Sign in to the app</a>. Prefer email? <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> · <Link to="/office">Deploi Office</Link></p>
      </Section>
    </div>
  )
}
