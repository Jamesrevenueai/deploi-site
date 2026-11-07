import { AgentScreen } from '@/components/team/AgentScreen'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'
export const metadata = { title: 'Agent' }
export default async function ShopifyTeamAgentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  // a library agent not marked ready for Shopify is a 404 here, even when the Team page is shown
  requireEmbeddedFeature('team', { libraryAgent: decodeURIComponent(key) })
  return <AgentScreen agentKey={key} />
}
