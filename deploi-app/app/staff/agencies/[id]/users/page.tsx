import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { listAgencyUsers, hasAuthProvider } from '@/lib/users/invite'
import { inviteUserAction, resendInviteAction, revokeInviteAction } from '@/lib/users/actions'
import { PageHeader } from '@/components/ui/PageHeader'
import { Field, Input, Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Users' }
export const dynamic = 'force-dynamic'

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const OK: Record<string, string> = { sent: 'Invite sent. They get a magic link from Supabase and land in their dashboard on first sign-in.', resent: 'Invite re-sent.', recorded: 'Invite recorded. No auth provider is configured, so no email went out yet.', revoked: 'Invite revoked.' }

export default async function AgencyUsers({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const g = await db.one<{ id: string; name: string }>('select id, name from agencies where id = $1', [id])
    if (!g) return null
    return { g, ...(await listAgencyUsers(db, id)) }
  }, { ip })
  if (!data) notFound()
  const { g, profiles, invites } = data
  const open = invites.filter(i => i.status !== 'accepted' && i.status !== 'revoked')
  const closed = invites.filter(i => i.status === 'accepted' || i.status === 'revoked')

  return (
    <>
      <PageHeader eyebrow={<Link href={`/staff/agencies/${id}`}>{g.name}</Link>} title="Users"
        sub="Invite the people at this practice who should see the dashboard. Each invite is a magic link; no passwords." />
      {sp.ok && <div className="mb-5"><Banner icon="mail"><strong>Done.</strong> {OK[sp.ok] ?? sp.ok}</Banner></div>}
      {sp.error && <div className="mb-5"><Banner tone="warn"><strong>Could not invite.</strong> {sp.error}</Banner></div>}
      {!hasAuthProvider() && <div className="mb-5"><Banner tone="warn"><strong>No auth provider configured.</strong> Invites are recorded but no email is sent until Supabase keys are set.</Banner></div>}

      <section className="rounded-[20px] border border-line p-5 md:p-6">
        <h2 className="mb-4 text-lg">Invite a user</h2>
        <form action={inviteUserAction} className="grid gap-4 md:grid-cols-[1fr_180px_auto] md:items-end">
          <input type="hidden" name="agency_id" value={id} />
          <Field label="Email" htmlFor="invite-email"><Input id="invite-email" name="email" type="email" autoComplete="off" required placeholder="owner@practice.com" /></Field>
          <Field label="Role" htmlFor="invite-role">
            <Select id="invite-role" name="role" defaultValue="client"><option value="client">Client</option><option value="staff">Staff</option></Select>
          </Field>
          <Button type="submit">Send invite</Button>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg">Signed in</h2>
        {profiles.length === 0 ? <Empty title="No users yet" /> : (
          <ul className="flex flex-col gap-2">
            {profiles.map(p => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-4 py-3">
                <span className="text-ink font-medium">{p.email}</span>
                <span className="flex items-center gap-2 text-[14px] text-grey-h"><Badge tone={p.role === 'staff' ? 'ok' : 'muted'}>{p.role}</Badge>since {date(p.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg">Pending invites</h2>
        {open.length === 0 ? <Empty title="No pending invites" /> : (
          <ul className="flex flex-col gap-2">
            {open.map(i => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3">
                <div className="min-w-0">
                  <div className="text-ink font-medium">{i.email}</div>
                  <div className="text-[13px] text-grey-h">{i.role} · invited {date(i.invited_at)} · {i.status}</div>
                </div>
                <div className="flex gap-2">
                  <form action={resendInviteAction}><input type="hidden" name="agency_id" value={id} /><input type="hidden" name="invite_id" value={i.id} /><button className="btn ghost xs" type="submit">Resend</button></form>
                  <form action={revokeInviteAction}><input type="hidden" name="agency_id" value={id} /><input type="hidden" name="invite_id" value={i.id} /><button className="btn danger xs" type="submit">Revoke</button></form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {closed.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg">History</h2>
          <ul className="flex flex-col gap-2">
            {closed.map(i => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-4 py-3 text-[14px]">
                <span className="text-ink">{i.email}</span>
                <span className="text-grey-h"><Badge tone={i.status === 'accepted' ? 'ok' : 'muted'}>{i.status}</Badge> {i.accepted_at ? `accepted ${date(i.accepted_at)}` : `invited ${date(i.invited_at)}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
