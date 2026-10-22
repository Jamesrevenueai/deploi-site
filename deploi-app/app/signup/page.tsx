import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { joinWaitlist } from './actions'
import { Field, Input } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Get started' }

export default async function Signup({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const s = await getSession().catch(() => null)
  if (s) redirect(s.role === 'staff' ? '/staff/pipeline' : '/app/home')

  return (
    <main className="min-h-dvh flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md fade-up">
        <div className="wordmark mb-10 text-center">deploi <span className="text-grey-h">ai</span></div>
        <div className="metal rounded-[20px] p-6 md:p-8">
          <div className="relative flex flex-col gap-5">
            <div>
              <h1 className="text-2xl">Get started</h1>
              <p className="mt-2 text-grey text-[15px]">Deploi is invite-only while we onboard agencies. Join the list and we will set up your access.</p>
            </div>
            {sp.sent ? (
              <Banner icon="mail"><strong>You are on the list.</strong> We will email you when your access is ready.</Banner>
            ) : (
              <>
                {sp.error && <Banner tone="warn"><strong>Could not save that.</strong> {sp.error.replace(/-/g, ' ')}.</Banner>}
                <form action={joinWaitlist} className="flex flex-col gap-4">
                  <Field label="Your name" htmlFor="name">
                    <Input id="name" name="name" autoComplete="name" required maxLength={120} />
                  </Field>
                  <Field label="Work email" htmlFor="email">
                    <Input id="email" name="email" type="email" autoComplete="email" required maxLength={200} placeholder="you@agency.com" />
                  </Field>
                  <Field label="Agency" htmlFor="agency_name">
                    <Input id="agency_name" name="agency_name" autoComplete="organization" maxLength={200} />
                  </Field>
                  <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
                  <Button type="submit">Join the waitlist</Button>
                </form>
              </>
            )}
          </div>
        </div>
        <p className="mt-6 text-center text-[13px] text-grey-h">Already have access? <a href="/login" className="underline">Sign in</a></p>
      </div>
    </main>
  )
}
