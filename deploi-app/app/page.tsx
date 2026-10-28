import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { homeFor } from '@/lib/session'

export default async function Root() {
  const s = await getSession()
  if (!s) redirect('/login')
  redirect(homeFor(s))
}
