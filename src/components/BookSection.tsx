import { BookButton } from './Button'
import { LeadForm } from './LeadForm'
import { env } from '../lib/env'

export function BookSection() {
  return (
    <section id="book">
      <div className="container">
        <div className="section-head reveal">
          <span className="eyebrow">Book a call</span>
          <h2 className="two-tone">
            <span className="grey">Find your biggest leak</span><br />
            <span className="white">in one 20-minute call.</span>
          </h2>
          <p className="lead">
            Bring one referral you lost and one visit that didn&rsquo;t pay. We&rsquo;ll walk both
            with you and tell you what we&rsquo;d fix first.
          </p>
        </div>
        <div className="book-inner reveal">
          <BookButton>{env.bookingUrl ? 'Book a call' : 'Book a call'}</BookButton>
          <p className="muted">Or leave your details and we&rsquo;ll reach out within one business day.</p>
          <LeadForm source="site" />
        </div>
      </div>
    </section>
  )
}
