import { ShopifyPlanScreen } from '@/components/store/ShopifyPlan'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'
export const metadata = { title: 'Plan' }
/** Shopify App Pricing: the plan read from Shopify, and a button to Shopify's hosted plan page (only while billing is on). */
export default function ShopifyPlanPage() { requireEmbeddedFeature('plan'); return <ShopifyPlanScreen /> }
