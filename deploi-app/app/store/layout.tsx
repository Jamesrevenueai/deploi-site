import { AppShell } from '@/components/app/AppShell'
import { loadShell, merchantSession } from '@/lib/app/shell'
import { StoreProvider } from '@/components/store/bits'
import { FeedbackButton } from '@/components/team/FeedbackButton'
import { BillingStatusBanner } from '@/components/store/BillingStatusBanner'
import { HelpMenu } from '@/components/support/HelpMenu'

export const dynamic = 'force-dynamic'
export const metadata = { title: { default: 'Store', template: '%s · Deploi AI' } }

/** Merchant area of the Deploi web app. Staff are redirected by requireRole; an account without a store sees /no-store. */
export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const { session, actor } = await merchantSession()
  const shell = await loadShell(actor)
  return (
    <AppShell shell={shell} session={session}>
      <StoreProvider base="/store"><BillingStatusBanner />{children}<HelpMenu /><FeedbackButton /></StoreProvider>
    </AppShell>
  )
}
