import { AgentNewScreen } from '@/components/store/AgentNew'

export const metadata = { title: 'Create agent' }

export default async function ShopifyNewAgentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  return <AgentNewScreen template={sp.template ?? null} />
}
