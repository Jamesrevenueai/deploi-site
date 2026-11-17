import { requireRole } from '@/lib/auth'
import { STAFF_NAV } from '@/lib/nav'
import { StaffShell } from '@/components/shell/StaffShell'

export const dynamic = 'force-dynamic'

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole('staff')
  return <StaffShell items={STAFF_NAV} session={session}>{children}</StaffShell>
}
