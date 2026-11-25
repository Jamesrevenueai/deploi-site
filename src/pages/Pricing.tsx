import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { PricingSection } from '../components/PricingSection'
import { OVERAGE, STORE_PLANS, OFFICE_PLANS } from '../lib/pricing'

export const PRICING_TITLE = `Pricing — ${BRAND}`
export const PRICING_DESCRIPTION = `Store plans ${STORE_PLANS.map(p => `${p.name} ${p.price}`).join(', ')} a month; Office plans ${OFFICE_PLANS.map(p => `${p.name} ${p.price}`).join(', ')} a month. ${OVERAGE.store.text}`

/** The same pricing section as the homepage (one source: deploi-app/lib/pricing/catalog.json), with the page's h1. */
export default function Pricing() {
  useSeo({ title: PRICING_TITLE, description: PRICING_DESCRIPTION })
  return (
    <div className="dz-x pricing-page">
      <PricingSection headingLevel={1} />
    </div>
  )
}
