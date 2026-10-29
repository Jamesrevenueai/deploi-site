import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { admin } from '@/lib/db'
import { accessConfig, listAccess, listInvites, BASIS_LABEL, decide } from '@/lib/engine/access'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Input } from '@/components/ui/Field'
import { decideAccessAction, revokeInviteAction } from './actions'
import { InviteForm } from './InviteForm'

export const metadata = { title: 'Store access' }
export const dynamic = 'force-dynamic'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

export default async function StoreAccessPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireRole('staff')
  const filter = (await searchParams).filter === 'all' ? 'all' : 'pending'
  const [rows, invites] = await admin(db => Promise.all([listAccess(db, filter), listInvites(db)]))
  const mode = accessConfig.mode
  return (
    <>
      <PageHeader title="Store access" eyebrow="Staff" sub="Which Shopify stores Deploi may change and send real email for. Every store can install and scan; changes need access." />
      <div className="mb-5 flex flex-col gap-2">
        <Banner icon="shield">
          Mode: <strong>{mode === 'open' ? 'open (every installed store)' : 'beta'}</strong>. In beta, a store is enabled when Shopify reports a development store
          (where Shopify reviewers test), when it redeems an invite, or when staff approve it. A denial always wins.
          {accessConfig.writesPaused && <> <strong>LIVE_WRITES=off: writes to every live store are paused.</strong></>}
        </Banner>
      </div>

      <h2 className="text-[1.1rem] mb-3">Stores</h2>
      <div className="mb-3 flex gap-2 text-[14px]">
        <Link href="?filter=pending" className={`badge ${filter === 'pending' ? '' : 'muted'}`}>Waiting</Link>
        <Link href="?filter=all" className={`badge ${filter === 'all' ? '' : 'muted'}`}>All</Link>
      </div>
      {rows.length === 0 ? <Empty title={filter === 'pending' ? 'No stores waiting' : 'No stores yet'}>Stores appear here after they install the app.</Empty> : (
        <div className="flex flex-col gap-3 mb-10">
          {rows.map(r => {
            const live = decide(r, mode)
            return (
              <div key={r.id} className="card p-5 flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="break-all">{r.display_name ?? r.external_id}</strong>
                  <span className="text-grey-h text-[13px] break-all">{r.external_id}</span>
                  <Badge tone={live.status === 'eligible' ? 'ok' : 'warn'}>{live.status === 'eligible' ? `Enabled · ${BASIS_LABEL[live.basis ?? 'open_access']}` : live.status === 'denied' ? 'Denied' : 'Waiting'}</Badge>
                  {r.is_development_store && <Badge>Development store</Badge>}
                  {r.connection_status && r.connection_status !== 'active' && <Badge tone="warn">{r.connection_status}</Badge>}
                </div>
                <div className="text-[14px] text-grey">
                  Plan: {r.plan_name ?? 'unknown'} · Requested: {when(r.requested_at)}{r.request_note ? <> · &ldquo;{r.request_note}&rdquo;</> : null}
                  {r.staff_decision && <> · Staff {r.staff_decision} by {r.decided_by} {when(r.decided_at)}{r.reason ? ` (${r.reason})` : ''}</>}
                </div>
                <form action={decideAccessAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={r.id} />
                  <Input name="reason" placeholder="Reason (kept in the audit trail)" maxLength={300} aria-label={`Reason for ${r.external_id}`} />
                  <Button size="sm" type="submit" name="decision" value="approved">Approve</Button>
                  <Button size="sm" variant="ghost" type="submit" name="decision" value="denied">Deny</Button>
                  {r.staff_decision && <Button size="sm" variant="ghost" type="submit" name="decision" value="clear">Clear decision</Button>}
                </form>
              </div>
            )
          })}
        </div>
      )}

      <h2 className="text-[1.1rem] mb-3">Invite codes</h2>
      <div className="mb-4"><InviteForm /></div>
      {invites.length === 0 ? <Empty title="No invites yet">Create a code for a beta merchant or for Shopify&rsquo;s reviewers.</Empty> : (
        <div className="flex flex-col gap-2">
          {invites.map(i => {
            const expired = new Date(i.expires_at).getTime() <= Date.now()
            return (
              <div key={i.id} className="card p-4 flex flex-wrap items-center gap-3 text-[14px]">
                <strong>{i.label}</strong>
                <span className="text-grey-h">{i.shop_domain ?? 'any shop'} · {i.uses}/{i.max_uses} used · expires {when(i.expires_at)} · by {i.created_by}</span>
                {i.revoked_at ? <Badge tone="warn">Revoked</Badge> : expired ? <Badge tone="warn">Expired</Badge> : (
                  <form action={revokeInviteAction}><input type="hidden" name="id" value={i.id} /><Button size="sm" variant="ghost" type="submit">Revoke</Button></form>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
