import { BRAND } from '../lib/brand'
import { useSeo } from '../hooks/useSeo'
import { CtaButton } from '../components/Button'
import { Cards, IntegrationStatusBadge, PageHero, Section } from '../components/Page'
import { INTEGRATIONS } from '../lib/site-config'

export const COMMERCE_WORK = [
  { title: 'Store health', body: 'Finds stock and listing settings that cost you sales or oversell: products selling with no stock, unpublished items, missing SKUs.' },
  { title: 'Stock and inventory', body: 'Watches stock against your rules and proposes the fix, with the evidence it read.' },
  { title: 'Supplier follow-up', body: 'Chases suppliers on open orders and tracks the reply until the order is confirmed.' },
  { title: 'Verified fixes', body: 'After you approve a change, Deploi makes it and reads the store again. Only a confirmed change counts as done.' },
]

export default function Commerce() {
  useSeo({ title: `Deploi Commerce — ${BRAND}`, description: 'Store health, stock and supplier work handled by an AI team for Shopify and WooCommerce stores. Pilot.' })
  const tools = INTEGRATIONS.filter(i => i.group === 'Commerce' || i.key === 'deploi_email')
  return (
    <div className="page">
      <PageHero eyebrow="Deploi Commerce · Pilot" title="Your store’s unfinished work, found and fixed." lead="Deploi Commerce reads your store, finds the problems that cost sales, and fixes the ones you approve, then checks the store again to prove it.">
        <CtaButton />
      </PageHero>
      <Section title="What it handles"><Cards items={COMMERCE_WORK} cols={2} /></Section>
      <Section title="Works with" tone="alt">
        <ul className="chips">{tools.map(i => <li key={i.key} className="chip"><span>{i.name}</span><IntegrationStatusBadge i={i} /></li>)}</ul>
        <p className="muted pt">Shopify: not yet listed in the Shopify App Store.</p>
      </Section>
    </div>
  )
}
