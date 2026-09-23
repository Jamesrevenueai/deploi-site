import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { miniAuditUrl, isConfigured } from '../lib/ctaUrls'
import { DOOR_META, servicesFor, type Service, type ServiceDoor } from '../data/services'
import { WaitlistForm } from '../components/WaitlistForm'
import { useSeo } from '../hooks/useSeo'

type Props = { door: ServiceDoor }

export default function Door({ door }: Props) {
  const meta = DOOR_META[door]
  const services = servicesFor(door)

  useSeo({
    title: `${meta.title} — ${BRAND}`,
    description: meta.subtitle,
  })

  return (
    <>
      <section className="page-hero">
        <div className="container">
          <div className="page-eyebrow reveal">{titleCase(door)}</div>
          <h1 className="reveal d1">{meta.title}.</h1>
          <p className="page-sub reveal d2">{meta.subtitle}</p>
          {meta.note && <p className="door-note reveal d3">{meta.note}</p>}
        </div>
      </section>

      <section>
        <div className="container">
          <div className="services-grid">
            {services.map((s, i) => (
              <ServiceCard key={s.slug} service={s} index={i} />
            ))}
          </div>
        </div>
      </section>
    </>
  )
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function ServiceCard({ service, index }: { service: Service; index: number }) {
  const isComingSoon = service.status === 'coming_soon'
  const delayClass = `d${(index % 4) + 1}`

  return (
    <div className={`service-card reveal ${delayClass} ${isComingSoon ? 'coming' : ''}`}>
      {isComingSoon && <div className="service-coming">Coming soon</div>}
      <div className="service-name">{service.name}</div>
      <div className="service-price">{service.price}</div>
      <p className="service-oneliner">{service.oneLiner}</p>
      <ul className="service-includes">
        {service.includes.map(i => <li key={i}>{i}</li>)}
      </ul>
      {isComingSoon ? (
        <div className="service-waitlist">
          <div className="service-waitlist-title">Get on the waitlist for {service.name}.</div>
          <WaitlistForm service={service.slug} />
        </div>
      ) : (
        <ServiceCTA service={service} />
      )}
    </div>
  )
}

function ServiceCTA({ service }: { service: Service }) {
  if (service.cta === 'audit') {
    return (
      <Link to="/audit" className="service-cta">
        Learn about the audit
        <span className="arrow" aria-hidden="true">→</span>
      </Link>
    )
  }
  if (service.cta === 'course') {
    return (
      <Link to="/course" className="service-cta">
        See the course
        <span className="arrow" aria-hidden="true">→</span>
      </Link>
    )
  }
  const href = miniAuditUrl()
  const external = !href.startsWith('#') && !href.startsWith('/')
  return (
    <>
      <a
        href={href}
        className="service-cta"
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        Book a free mini-audit
        <span className="arrow" aria-hidden="true">→</span>
      </a>
      {!isConfigured.miniAudit() && (
        <div className="cta-notice">Booking link not configured yet — button goes to the waitlist.</div>
      )}
    </>
  )
}
