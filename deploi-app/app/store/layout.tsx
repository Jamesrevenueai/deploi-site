import { redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth'
import { MERCHANT_NAV } from '@/lib/store/nav'
import { AppShell } from '@/components/shell/AppShell'
import { StoreProvider } from '@/components/store/bits'

export const dynamic = 'force-dynamic'
export const metadata = { title: { default: 'Store', template: '%s · Deploi AI' } }

/** Merchant area of the Deploi web app. Staff are redirected by requireRole; an account without a store sees /no-store. */
export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole('client')
  if (session.orgType !== 'merchant') redirect('/no-store')
  return (
    <AppShell items={MERCHANT_NAV} session={session}>
      <StoreProvider base="/store">{children}</StoreProvider>
    </AppShell>
  )
}
