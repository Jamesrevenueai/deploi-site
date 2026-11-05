import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { homeFor } from '@/lib/session'
import { Field, Input } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { TimezoneSelect } from './TimezoneSelect'
import { createOrganizationAction } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Welcome · Deploi AI' }

/**
 * First run for a new account with no organization: name the business and Deploi creates its organization,
 * with this person as the owner (lib/platform/signup.ts), then setup continues at /store/setup.
 * Someone who was invited joins through the link in their invitation email instead.
 */
export default async function StartPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireSession()
  if (s.role === 'staff' || s.agencyId) redirect(homeFor(s))
  const sp = await searchParams
  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md fade-up">
        <div className="wordmark mb-10 text-center">deploi <span className="text-grey-h">ai</span></div>
        <div className="panel p-6 md:p-8">
          <form action={createOrganizationAction} className="flex flex-col gap-5" data-testid="start">
            <div>
              <div className="eyebrow pb-2">Welcome</div>
              <h1 className="text-2xl">Set up your business on Deploi</h1>
              <p className="pt-2 text-[15px] text-grey">You are signed in as {s.email}. Name your business and you become its owner; you can invite your team afterwards.</p>
            </div>
            {sp.error && <Banner tone="warn">{sp.error}</Banner>}
            <Field label="Business name" htmlFor="start-name"><Input id="start-name" name="name" required maxLength={120} autoComplete="organization" /></Field>
            <Field label="Time zone" htmlFor="start-tz" hint="Agent schedules and the weekly summary use it."><TimezoneSelect id="start-tz" name="timezone" /></Field>
            <Button type="submit">Create my business</Button>
            <p className="text-[13px] text-grey-h">Were you invited to an existing team? Open the link in your invitation email instead; it adds you to that team.</p>
          </form>
        </div>
        <form action="/logout" method="post" className="mt-6 text-center"><button type="submit" className="btn ghost xs">Sign out</button></form>
      </div>
    </main>
  )
}
