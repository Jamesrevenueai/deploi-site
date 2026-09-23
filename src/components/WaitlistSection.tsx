import { WaitlistForm } from './WaitlistForm'

type Props = {
  service?: string
  eyebrow?: string
  title?: string
  body?: string
}

export function WaitlistSection({
  service,
  eyebrow = 'Waitlist',
  title = 'Get on the list.',
  body = "We're onboarding a small number of businesses at a time. Leave your details and we'll reach out when we've got a slot that fits.",
}: Props) {
  return (
    <section id="waitlist" className="waitlist">
      <div className="container-narrow waitlist-card">
        <div className="section-head reveal" style={{ marginBottom: 0 }}>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
        <div className="reveal d1">
          <WaitlistForm service={service} />
        </div>
      </div>
    </section>
  )
}
