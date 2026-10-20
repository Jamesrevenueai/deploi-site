import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'

export default async function Root() {
  const s = await getSession()
  if (!s) redirect('/login')
  redirect(s.role === 'staff' ? '/staff/pipeline' : '/app/home')
}
