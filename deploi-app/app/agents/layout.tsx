import { AppShell } from '@/components/app/AppShell'
import { loadShell, merchantSession } from '@/lib/app/shell'
import { StoreProvider } from '@/components/store/bits'
import { HelpMenu } from '@/components/support/HelpMenu'

export const dynamic = 'force-dynamic'
export const metadata = { title: { default: 'Agent', template: '%s · Deploi' } }

/** One agent's dashboard (/agents/<id>), in the same shell as the rest of the logged-in app. */
export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const { session, actor } = await merchantSession()
  const shell = await loadShell(actor)
  return (
    <AppShell shell={shell} session={session}>
      <StoreProvider base="/store">{children}<HelpMenu /></StoreProvider>
    </AppShell>
  )
}
