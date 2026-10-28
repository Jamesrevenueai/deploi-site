import { redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth'
import { CLIENT_NAV } from '@/lib/nav'
import { AppShell } from '@/components/shell/AppShell'

export const dynamic = 'force-dynamic'

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole('client')
  if (session.orgType === 'merchant') redirect('/store')
  return <AppShell items={CLIENT_NAV} session={session}>{children}</AppShell>
}
