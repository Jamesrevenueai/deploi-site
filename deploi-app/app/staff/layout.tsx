import { requireRole } from '@/lib/auth'
import { STAFF_NAV } from '@/lib/nav'
import { AppShell } from '@/components/shell/AppShell'

export const dynamic = 'force-dynamic'

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole('staff')
  return <AppShell items={STAFF_NAV} session={session}>{children}</AppShell>
}
