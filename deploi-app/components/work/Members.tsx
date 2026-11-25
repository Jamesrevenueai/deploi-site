'use client'
/**
 * Settings → People and roles: who is in the organization, their roles, open invitations (resend with a new
 * link, or revoke), and the invite form. Owners and admins manage; only an owner makes or unmakes an owner and
 * the last owner cannot be demoted or removed (the server enforces every rule; this screen only asks).
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'

type Role = 'owner' | 'admin' | 'member' | 'viewer'
type Member = { userId: string; email: string; fullName: string | null; role: Role; joinedAt: string; you: boolean }
type Invite = { id: string; email: string; role: Role; invitedAt: string; expiresAt: string | null; expired: boolean; sentCount: number }
type MembersResponse = { members: Member[]; invites: Invite[]; yourRole: Role | null; membersCanApprove: boolean }
type SendResult = { email: string; role: string; emailStatus: 'sent' | 'held' | 'failed' | 'uncertain' | 'pending'; emailReason: string | null; link?: string }

const API = '/api/store/settings/members'
const ROLE_HINT: Record<Role, string> = { owner: 'everything, including deletion and owners', admin: 'grants agents, approves, billing, connections, members', member: 'day-to-day work; approves only if the owner allows', viewer: 'read only' }

function sentNote(r: SendResult): { tone: 'info' | 'warn'; text: React.ReactNode } {
  if (r.emailStatus === 'sent') return { tone: 'info', text: <>Invitation sent to {r.email} as {r.role}. The link works once and expires in 7 days.</> }
  return {
    tone: 'warn',
    text: <>The invitation for {r.email} is recorded, but the email was not sent{r.emailReason ? ` (${r.emailReason})` : ''}.{r.link ? <> Share this link with them yourself; it works only for {r.email}: <code className="break-all" data-testid="invite-link">{r.link}</code></> : null}</>,
  }
}

export function MembersPanel() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<MembersResponse & { ok: true }>(API), 'members')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'warn'; text: React.ReactNode } | null>(null)
  if (loading && !data) return <Loading label="Loading members" rows={2} />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (!data) return null
  const canManage = data.yourRole === 'owner' || data.yourRole === 'admin'
  const owner = data.yourRole === 'owner'
  const owners = data.members.filter(m => m.role === 'owner').length

  async function post<R>(key: string, body: Record<string, unknown>, ok: (r: R) => { tone: 'info' | 'warn'; text: React.ReactNode }) {
    setBusy(key); setNote(null)
    try { const r = await storeFetch<R>(API, { method: 'POST', body }); setNote(ok(r)); await reload() } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="members">
      <div aria-live="polite">{note && <Banner tone={note.tone} icon={note.tone === 'info' ? 'check' : 'alert'}>{note.text}</Banner>}</div>
      <ul className="flex flex-col gap-2" aria-label="Members">
        {data.members.map(m => {
          const lastOwner = m.role === 'owner' && owners <= 1
          return (
            <li key={m.userId} className="panel flex flex-col gap-2 p-4 md:flex-row md:items-center md:justify-between" data-member={m.email}>
              <div className="min-w-0">
                <div className="font-semibold text-ink break-all">{m.fullName || m.email}{m.you && <span className="text-grey-h font-normal"> (you)</span>}</div>
                {m.fullName && <div className="text-[13px] text-grey">{m.email}</div>}
                <div className="text-[13px] text-grey-h">{ROLE_HINT[m.role]}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canManage && !lastOwner && (owner || m.role !== 'owner')
                  ? <Select aria-label={`Role of ${m.email}`} value={m.role} disabled={busy !== null} onChange={e => void post('role', { action: 'change_role', userId: m.userId, role: e.target.value }, () => ({ tone: 'info', text: `${m.email} is now ${e.target.value}.` }))}>
                      {(owner ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer']).map(r => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  : <Badge tone={m.role === 'owner' ? 'ok' : 'muted'}>{m.role}</Badge>}
                {lastOwner && <span className="text-[12px] text-grey-h">the last owner</span>}
                {!lastOwner && (m.you || (canManage && (owner || m.role !== 'owner'))) && (
                  <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => { if (window.confirm(m.you ? 'Leave this organization?' : `Remove ${m.email}?`)) void post('remove', { action: 'remove', userId: m.userId }, () => ({ tone: 'info', text: m.you ? 'You left the organization.' : `${m.email} was removed.` })) }}>{m.you ? 'Leave' : 'Remove'}</Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {data.invites.length > 0 && (
        <div>
          <h3 className="pb-2 text-[15px]">Pending invitations</h3>
          <ul className="flex flex-col gap-2" aria-label="Pending invitations">
            {data.invites.map(i => (
              <li key={i.id} className="panel flex flex-col gap-2 p-4 md:flex-row md:items-center md:justify-between" data-invite={i.email}>
                <div className="min-w-0">
                  <div className="font-semibold text-ink break-all">{i.email}</div>
                  <div className="text-[13px] text-grey-h">{i.role} · {i.expired ? <span className="text-warn">expired</span> : i.expiresAt ? `expires ${i.expiresAt.slice(0, 10)}` : 'not sent'}{i.sentCount > 1 ? ` · sent ${i.sentCount} times` : ''}</div>
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void post<SendResult>(`resend:${i.id}`, { action: 'resend_invite', inviteId: i.id }, sentNote)}>Resend</Button>
                    <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void post(`revoke:${i.id}`, { action: 'revoke_invite', inviteId: i.id }, () => ({ tone: 'info', text: `The invitation for ${i.email} was withdrawn; its link no longer works.` }))}>Revoke</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage ? (
        <form className="panel flex flex-col gap-3 p-4" aria-label="Invite someone" onSubmit={e => { e.preventDefault(); void post<SendResult>('invite', { action: 'invite', email, role }, r => { setEmail(''); return sentNote(r) }) }}>
          <h3 className="text-[15px]">Invite someone</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px]">
            <Field label="Email" htmlFor="invite-email"><Input id="invite-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@your-business.com" /></Field>
            <Field label="Role" htmlFor="invite-role"><Select id="invite-role" value={role} onChange={e => setRole(e.target.value as Role)}>{(['admin', 'member', 'viewer'] as const).map(r => <option key={r} value={r}>{r}</option>)}</Select></Field>
          </div>
          <p className="text-[13px] text-grey-h">They get an email with a link that works once, only for that address, for 7 days. Make someone an owner after they join.</p>
          <div><Button type="submit" size="sm" disabled={busy !== null || !email.trim()}>{busy === 'invite' ? 'Sending…' : 'Send invitation'}</Button></div>
        </form>
      ) : <p className="text-[13px] text-grey-h">Your role is {data.yourRole}. Owners and admins invite people and change roles.</p>}
    </div>
  )
}
