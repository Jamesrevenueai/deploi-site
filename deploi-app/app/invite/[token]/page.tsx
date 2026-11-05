import { env } from '@/lib/env'
import { getSession } from '@/lib/auth'
import { inviteInfo, maskEmail, type InviteRefusal } from '@/lib/platform/invites'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { acceptInviteAction, inviteDevSignIn, inviteMagicLink } from './actions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Invitation · Deploi AI', robots: { index: false } }

const ROLE_WORDS: Record<string, string> = {
  admin: 'Admins grant and widen agents, approve work, manage billing, connections and members.',
  member: 'Members do the day-to-day work: create and pause agents and reject items; they approve only when the owner allows it.',
  viewer: 'Viewers can see everything and change nothing.',
}
const REFUSED_TITLE: Record<InviteRefusal, string> = {
  invalid: 'This invitation link is not valid', replaced: 'This link was replaced', expired: 'This invitation has expired', revoked: 'This invitation was withdrawn',
  used: 'This invitation was already used', wrong_email: 'This invitation is for another address', other_org: 'Your account belongs to another organization',
  already_member: 'You are already a member', staff: 'Staff accounts cannot join',
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md fade-up">
        <div className="wordmark mb-10 text-center">deploi <span className="text-grey-h">ai</span></div>
        <div className="panel p-6 md:p-8"><div className="flex flex-col gap-5" data-testid="invite">{children}</div></div>
        <p className="mt-6 text-center text-[13px] text-grey-h">Questions? hello@getdeploi.com</p>
      </div>
    </main>
  )
}

/**
 * Accept an invitation (/invite/<token>): the organization and role, then sign in (or sign up) as the invited
 * address and join. Joining is a server action; the organization comes from the signed invite, never the request.
 */
export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params
  const sp = await searchParams
  const info = await inviteInfo(token)
  const s = await getSession()
  const hidden = <input type="hidden" name="token" value={token} />

  if (info.state !== 'valid') {
    return (
      <Shell>
        <h1 className="text-2xl" data-state={info.state}>{REFUSED_TITLE[info.state]}</h1>
        <p className="text-[15px] text-grey">{info.message}</p>
        {info.state === 'already_member' || (s && s.orgType === 'merchant') ? <Button href="/store">Go to Deploi</Button> : <Button href="/login" variant="ghost">Sign in</Button>}
      </Shell>
    )
  }
  const refused = sp.refused as InviteRefusal | undefined
  const wrong = s && s.email.toLowerCase() !== info.email.toLowerCase()
  return (
    <Shell>
      <div>
        <div className="eyebrow pb-2">Invitation</div>
        <h1 className="text-2xl">Join {info.orgName} on Deploi</h1>
        <p className="pt-2 text-[15px] text-grey">You are invited as <strong className="text-ink" data-testid="invite-role">{info.role}</strong>. {ROLE_WORDS[info.role]}</p>
        <p className="pt-2 text-[13px] text-grey-h">For {info.maskedEmail} · expires {info.expiresAt.slice(0, 10)}</p>
      </div>
      {refused && <Banner tone="warn"><strong>{REFUSED_TITLE[refused] ?? 'Could not join'}.</strong> {refused === 'wrong_email' ? `This invitation is for ${info.maskedEmail}.` : 'Ask the person who invited you.'}</Banner>}
      {sp.error && <Banner tone="warn"><strong>Could not continue.</strong> {sp.error.replace(/-/g, ' ')}.</Banner>}
      {sp.sent && <Banner icon="mail"><strong>Check your email.</strong> We sent a sign-in link to {info.maskedEmail}. It brings you back here.</Banner>}

      {!s && env.authMode === 'dev' && (
        <form action={inviteDevSignIn} className="flex flex-col gap-3">
          {hidden}
          <Button type="submit">Continue as {info.email}</Button>
          <p className="text-[13px] text-grey-h">Development sign-in: signs in as the invited address (a new account if it has none).</p>
        </form>
      )}
      {!s && env.authMode === 'supabase' && (
        <form action={inviteMagicLink} className="flex flex-col gap-3">
          {hidden}
          <Button type="submit">Email me a sign-in link</Button>
          <p className="text-[13px] text-grey-h">New to Deploi? The same link creates your account. It goes to {info.maskedEmail} only.</p>
        </form>
      )}
      {s && !wrong && (
        <form action={acceptInviteAction} className="flex flex-col gap-3">
          {hidden}
          <Button type="submit">Join {info.orgName} as {info.role}</Button>
          <p className="text-[13px] text-grey-h">Signed in as {s.email}.</p>
        </form>
      )}
      {s && wrong && (
        <div className="flex flex-col gap-3">
          <Banner tone="warn">You are signed in as {maskEmail(s.email)}, but this invitation is for {info.maskedEmail}. Sign out, then sign in with the invited address.</Banner>
          <form action="/logout" method="post"><input type="hidden" name="next" value={`/invite/${token}`} /><Button type="submit" variant="ghost">Sign out</Button></form>
        </div>
      )}
    </Shell>
  )
}
