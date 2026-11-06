import { Link } from 'react-router-dom'
import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { PageHero, Section } from '../components/Page'
import { PLANS, PRICING_LABEL, PRICING_LINE, PRICING_NOTE, priceLabel } from '../lib/site-config'

export const PRICING_TITLE = `Pricing — ${BRAND}`
export const PRICING_DESCRIPTION = `${PRICING_LINE}.`

export default function Pricing() {
  useSeo({ title: PRICING_TITLE, description: PRICING_DESCRIPTION })
  return (
    <div className="page pricing-page">
      <PageHero eyebrow={PRICING_LABEL} title="Simple monthly plans for the pilot." lead={<>{PRICING_LINE}.</>} />
      <Section>
        <ul className="plans" aria-label="Plans">
          {PLANS.map(p => (
            <li key={p.key} className={`plan ${p.key === 'business_workforce' ? 'featured' : ''}`} data-plan={p.key}>
              <div className="plan-suite">{p.suite}</div>
              <h2 className="plan-name">{p.name}</h2>
              <div className="plan-price"><span className="plan-from">{p.from ? 'from ' : ''}</span>${p.price}<small>/mo</small></div>
              <span className="plan-pilot">{PRICING_LABEL}</span>
              <p className="plan-summary">{p.summary}</p>
              <ul className="plan-includes">{p.includes.map(x => <li key={x}>{x}</li>)}</ul>
              <CtaButton variant={p.key === 'business_workforce' ? 'primary' : 'ghost'} size="sm" />
              <span className="sr-only">{priceLabel(p)}</span>
            </li>
          ))}
        </ul>
        <p className="pricing-note" id="pilot"><strong>{PRICING_NOTE}</strong> We agree the pilot price with you before it starts, and you approve every charge. Questions? <Link to="/contact">Contact us</Link>.</p>
      </Section>
    </div>
  )
}
