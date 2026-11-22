import { AgentDetailScreen } from '@/components/store/AgentDetail'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Agent' }

export default async function ShopifyAgentPage({ params }: { params: Promise<{ id: string }> }) {
  requireEmbeddedFeature('agents')
  const { id } = await params
  return <AgentDetailScreen id={id} />
}
