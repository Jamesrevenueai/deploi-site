import { redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth'
import { AppShell } from '@/components/shell/AppShell'
import { StoreProvider } from '@/components/store/bits'
import { OFFICE_NAV } from './nav'
import { OfficeGate } from './_components/OfficeGate'

export const dynamic = 'force-dynamic'
export const metadata = { title: { default: 'Office', template: '%s · Deploi Office' } }

/** Deploi Office: CRM, calendar and lead follow-up agents. Any signed-in customer organization may enable it; it is gated by org_products, not org_type. */
export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole('client')
  if (session.orgType !== 'merchant') redirect('/no-store')
  return (
    <AppShell items={OFFICE_NAV} session={session}>
      <StoreProvider base="/store"><OfficeGate>{children}</OfficeGate></StoreProvider>
    </AppShell>
  )
}
