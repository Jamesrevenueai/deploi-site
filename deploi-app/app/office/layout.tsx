import { AppShell } from '@/components/app/AppShell'
import { loadShell, merchantSession } from '@/lib/app/shell'
import { SubNav } from '@/components/shell/SubNav'
import { StoreProvider } from '@/components/store/bits'
import { OFFICE_NAV } from './nav'
import { OfficeGate } from './_components/OfficeGate'
import { HelpMenu } from '@/components/support/HelpMenu'

export const dynamic = 'force-dynamic'
export const metadata = { title: { default: 'Office', template: '%s · Deploi Office' } }

/** Deploi Office, in the same shell and navigation as the rest of the customer app (its own pages are tabs). CRM, calendar and lead follow-up agents. Any signed-in customer organization may enable it; it is gated by org_products, not org_type. */
export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const { session, actor } = await merchantSession()
  const shell = await loadShell(actor)
  return (
    <AppShell shell={shell} session={session} subnav={<SubNav items={OFFICE_NAV} label="Deploi Office" />}>
      <StoreProvider base="/store"><OfficeGate>{children}</OfficeGate><HelpMenu /></StoreProvider>
    </AppShell>
  )
}
