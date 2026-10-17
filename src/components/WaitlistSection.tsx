import { WaitlistForm } from './WaitlistForm'

export function WaitlistSection() {
  return (
    <section id="waitlist" className="cta-section">
      <div className="container">
        <div className="cta-block reveal">
          <div className="cta-copy">
            <span className="eyebrow">Book a call</span>
            <h2>Find your biggest leak in one 20-minute call.</h2>
            <p>
              Bring one referral you lost and one visit that didn&rsquo;t pay. We&rsquo;ll walk both
              with you and tell you what we&rsquo;d fix first.
            </p>
          </div>
          <div className="reveal d1">
            <WaitlistForm />
          </div>
        </div>
      </div>
    </section>
  )
}
