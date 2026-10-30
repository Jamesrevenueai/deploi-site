import { AgentScreen } from '@/components/team/AgentScreen'
export const metadata = { title: 'Agent' }
export default async function ShopifyTeamAgentPage({ params }: { params: Promise<{ key: string }> }) { const { key } = await params; return <AgentScreen agentKey={key} /> }
