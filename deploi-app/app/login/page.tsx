import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { devSignIn, magicLink } from './actions'
import { Field, Input, Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'

export const dynamic = 'force-dynamic'

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const s = await getSession()
  if (s) redirect(s.role === 'staff' ? '/staff/pipeline' : '/app/home')
  const dev = env.authMode === 'dev'
  const profiles = dev ? await admin(db => db.query<{ email: string; role: string; full_name: string | null }>('select email, role, full_name from profiles order by role desc, email')) : []

  return (
    <main className="min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md fade-up">
        <div className="wordmark mb-10 text-center">deploi <span className="text-grey-h">ai</span></div>
        <div className="metal rounded-[20px] p-6 md:p-8">
          <div className="relative flex flex-col gap-5">
            <div>
              <h1 className="text-2xl">Sign in</h1>
              <p className="mt-2 text-grey text-[15px]">
                {dev ? 'Development sign-in: pick a seeded user.' : 'We will email you a one-time sign-in link.'}
              </p>
            </div>
            {sp.sent && <Banner icon="mail"><strong>Check your email.</strong> The link signs you in on this device.</Banner>}
            {sp.error && <Banner tone="warn"><strong>Could not sign in.</strong> {sp.error.replace(/-/g, ' ')}.</Banner>}
            {dev ? (
              <form action={devSignIn} className="flex flex-col gap-4">
                <Field label="User" htmlFor="email">
                  <Select id="email" name="email" defaultValue={profiles[0]?.email}>
                    {profiles.map(p => <option key={p.email} value={p.email}>{p.email} · {p.role}</option>)}
                  </Select>
                </Field>
                <Button type="submit">Sign in</Button>
                <p className="text-[13px] text-grey-h">Dev auth is on because Supabase is not configured (or AUTH_MODE=dev).</p>
              </form>
            ) : (
              <form action={magicLink} className="flex flex-col gap-4">
                <Field label="Work email" htmlFor="email">
                  <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@agency.com" />
                </Field>
                <Button type="submit">Email me a link</Button>
              </form>
            )}
          </div>
        </div>
        <p className="mt-6 text-center text-[13px] text-grey-h">Questions? hello@getdeploi.com</p>
      </div>
    </main>
  )
}
