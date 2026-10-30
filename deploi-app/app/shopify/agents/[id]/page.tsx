import { AgentDetailScreen } from '@/components/store/AgentDetail'

export const metadata = { title: 'Agent' }

export default async function ShopifyAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <AgentDetailScreen id={id} />
}
