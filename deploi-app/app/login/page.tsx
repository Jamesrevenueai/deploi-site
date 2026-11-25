import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { homeFor } from '@/lib/session'
import { devSignIn, devSignUp, magicLink } from './actions'
import { Field, Input, Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { css } from '@/components/dp/css'
import { LogoMark, Wordmark } from '@/components/dp/bits'

export const dynamic = 'force-dynamic'

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const s = await getSession()
  if (s) redirect(homeFor(s))
  const dev = env.authMode === 'dev'
  const profiles = dev ? await admin(db => db.query<{ email: string; role: string; full_name: string | null }>('select email, role, full_name from profiles order by role desc, email')) : []

  return (
    <main style={css("min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 48px 16px; background: #F5F7FF; font-family: 'Plus Jakarta Sans', system-ui, sans-serif;")}>
      <div style={css('width: 100%; max-width: 440px;')}>
        <div style={css('display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 28px;')}><LogoMark size={36} /><Wordmark size={22} /></div>
        <div data-testid="login-card" style={css('background: #FFFFFF; border: 1px solid #E0E7FF; border-radius: 20px; padding: 32px; box-shadow: 0 20px 50px -30px rgba(79,70,229,0.35);')}>
          <div style={css('display: flex; flex-direction: column; gap: 20px;')}>
            <div>
              <span style={css('font-size: 13px; font-weight: 600; color: #4F46E5;')}>Deploi · your store and office, run by agents</span>
              <h1 style={css('margin: 6px 0 0; font-size: 30px; font-weight: 800; letter-spacing: -0.025em; color: #1E1B4B;')}>Sign in</h1>
              <p style={css('margin: 8px 0 0; font-size: 15px; line-height: 1.55; color: #3730A3;')}>
                {dev ? 'Development sign-in: pick a seeded user, or create a new test account.' : env.hasSupabase ? 'New or returning, we will email you a one-time sign-in link. A new address gets a new account.' : 'This server is reached through Shopify.'}
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
            ) : null}
            {dev ? (
              <form action={devSignUp} className="flex flex-col gap-4 border-t border-line pt-5" aria-label="Create a test account">
                <Field label="New account email" htmlFor="new-email" hint="Development only: a new account with no organization, as a real sign-up would be.">
                  <Input id="new-email" name="email" type="email" autoComplete="off" required placeholder="new.owner@example.com" />
                </Field>
                <Button type="submit" variant="ghost">Create account</Button>
              </form>
            ) : !env.hasSupabase ? (
              <Banner><strong>Email sign-in is not set up on this server.</strong> Open Deploi from your Shopify admin (Apps → Deploi).</Banner>
            ) : (
              <form action={magicLink} className="flex flex-col gap-4">
                <Field label="Work email" htmlFor="email">
                  <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@your-store.com" />
                </Field>
                <Button type="submit">Email me a link</Button>
              </form>
            )}
          </div>
        </div>
        <p style={css('margin: 20px 0 0; text-align: center; font-size: 13px; color: #3730A3;')}>Questions? <a href="mailto:support@getdeploi.com" style={css('color: #4F46E5; font-weight: 700; text-decoration: none;')}>support@getdeploi.com</a></p>
      </div>
    </main>
  )
}
