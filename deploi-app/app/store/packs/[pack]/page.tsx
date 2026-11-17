import { PackDashboard } from '@/components/packs/Packs'
export const metadata = { title: 'Agent pack' }
/** One pack: its agents, what each did, its records and settings. */
export default async function StorePackPage({ params }: { params: Promise<{ pack: string }> }) {
  const { pack } = await params
  return <PackDashboard pack={pack} />
}
