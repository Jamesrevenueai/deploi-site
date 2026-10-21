import { BookButton, bookCtaLabel } from './Button'
import { LeadForm } from './LeadForm'
import { env } from '../lib/env'

export function BookSection() {
  const label = bookCtaLabel()
  return (
    <section id="book">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">{env.bookingUrl ? 'Book a call' : 'Request a discovery conversation'}</span>
          <h2 className="two-tone">
            <span className="grey">Tell us which follow-up</span><br />
            <span className="white">is costing you the most.</span>
          </h2>
          <p className="lead">
            A discovery conversation is a short call about which problems hurt most and whether we fit.
            No fee, no obligation. If it makes sense, the next step is the paid assessment.
          </p>
        </div>
        <div className="book-inner reveal">
          {env.bookingUrl && <BookButton>{label}</BookButton>}
          <p className="muted">
            {env.bookingUrl ? 'Or leave your details and we will reach out within one business day.' : 'Leave your details and we will reach out within one business day.'}
          </p>
          <LeadForm source="site" cta={label} />
        </div>
      </div>
    </section>
  )
}
