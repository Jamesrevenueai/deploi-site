import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Empty } from '@/components/ui/Empty'
import { ActionCard, STATUS_LABEL, type ActionView } from '@/components/actions/ActionCard'
import { ImportFreshness } from '@/components/actions/ImportFreshness'
import { WORKER_LABELS, WORKER_NAMES } from '@/lib/workers/types'
import { ACTION_STATUSES } from '@/lib/workers/runtime'
import { lastSuccessfulImport } from '@/lib/imports/provenance'
import { approveAction, editAndApproveAction, skipAction, retryAction } from './actions'

export const metadata = { title: 'Proposed actions' }
export const dynamic = 'force-dynamic'

type Row = {
  id: string; agency_id: string; agency_name: string | null; worker: string; kind: 'email' | 'sms' | 'task'; to_ref: string | null; subject: string | null; body: string
  payload: Record<string, unknown>; status: string; created_at: string; sent_at: string | null; hold_reason: string | null
  delivery_status: string | null; simulated: boolean; expires_at: string | null; suppressed_reason: string | null; failure_reason: string | null; send_after: string | null; attempt_count: number
}

const FILTERS: [string, string][] = [
  ['proposed', 'Waiting'], ['pending', 'Approved / queued'], ['attempted', 'Attempted'], ['delivered', 'Delivered'], ['failed', 'Failed'],
  ['unknown', 'Delivery unknown'], ['suppressed', 'Suppressed'], ['expired', 'Expired'], ['skipped', 'Skipped'], ['all', 'All'],
]

export default async function ActionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const status = sp.status ?? 'proposed'
  const worker = sp.worker ?? ''
  const agency = sp.agency ?? ''

  const { rows, agencies, counts, freshness } = await withUser(session, async db => {
    const where: string[] = []
    const params: unknown[] = []
    if (status === 'pending') where.push(`status in ('approved','queued')`)
    else if (status && status !== 'all') { params.push(status); where.push(`status = $${params.length}`) }
    if (worker) { params.push(worker); where.push(`worker = $${params.length}`) }
    if (agency) { params.push(agency); where.push(`agency_id = $${params.length}`) }
    const w = where.length ? 'where ' + where.join(' and ') : ''
    const rows = await db.query<Row>(`select id, agency_id, agency_name, worker, kind, to_ref, subject, body, payload, status, created_at, sent_at, hold_reason, delivery_status, simulated, expires_at, suppressed_reason, failure_reason, send_after, attempt_count from proposed_actions ${w} order by created_at desc limit 200`, params)
    await db.auditRead('proposed_actions', agency || null, rows.map(r => r.id))
    const agencies = await db.query<{ id: string; name: string }>('select id, name from agencies order by name')
    const counts = await db.query<{ status: string; n: string; simulated: string }>("select status, count(*)::text as n, count(*) filter (where simulated)::text as simulated from proposed_actions group by status")
    const freshness = agency ? await lastSuccessfulImport(db, 'applicants', agency) : null
    return { rows, agencies, counts, freshness }
  }, { ip: await requestIp() })

  const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))
  const views: ActionView[] = rows.map(r => ({
    id: r.id, agency_name: r.agency_name, worker: r.worker, kind: r.kind, subject: r.subject, body: r.body, status: r.status, created_at: iso(r.created_at)!, sent_at: iso(r.sent_at), hold_reason: r.hold_reason,
    delivery_status: r.delivery_status, simulated: r.simulated, expires_at: iso(r.expires_at), suppressed_reason: r.suppressed_reason, failure_reason: r.failure_reason, send_after: iso(r.send_after), attempt_count: r.attempt_count,
    to_label: String(r.payload?.to_label ?? r.to_ref?.split(':')[0] ?? 'recipient'), about: r.payload?.about ? String(r.payload.about) : null,
  }))
  const n = (s: string) => s === 'pending' ? Number(counts.find(c => c.status === 'approved')?.n ?? 0) + Number(counts.find(c => c.status === 'queued')?.n ?? 0) : Number(counts.find(c => c.status === s)?.n ?? 0)
  const simulated = Number(counts.find(c => c.status === 'delivered')?.simulated ?? 0)
  const qs = (patch: Record<string, string>) => '?' + new URLSearchParams({ status, ...(worker && { worker }), ...(agency && { agency }), ...patch }).toString()

  return (
    <>
      <PageHeader
        title="Proposed actions"
        sub="Everything a worker wants to send. Nothing reaches an aide, family or referrer until you approve it or switch a worker to auto-send. Approval and sending are two steps: consent, expiry and the contact window are checked right before the send."
        actions={<><Button variant="ghost" size="sm" href="/staff/actions/run">Run a worker</Button><Button variant="ghost" size="sm" href="/staff/actions/settings">Auto-send</Button></>}
      />
      {sp.approved && sp.simulated && <div className="mb-4"><Banner icon="check"><strong>Simulated send.</strong> No provider is configured, so the message went to the mock outbox. It is marked <em>simulated</em> and does not count as a real outcome.</Banner></div>}
      {sp.approved && sp.accepted && <div className="mb-4"><Banner icon="check"><strong>Handed to the provider.</strong> It shows as <em>attempted</em> until the delivery callback confirms it.</Banner></div>}
      {sp.deferred && <div className="mb-4"><Banner icon="clock"><strong>Approved and queued.</strong> It is outside the agency&apos;s contact window, so the text goes out at the next window start.</Banner></div>}
      {sp.expired && <div className="mb-4"><Banner tone="warn"><strong>Expired.</strong> This action passed its deadline (for example the shift already started) and was not sent.</Banner></div>}
      {sp.noop && <div className="mb-4"><Banner icon="check"><strong>Nothing to do.</strong> That action was already attempted or delivered; a retry never sends twice.</Banner></div>}
      {sp.failed && <div className="mb-4"><Banner tone="warn"><strong>Not sent.</strong> {sp.reason ? `${sp.reason}. ` : ''}If an SMS is held for missing consent, record consent on the contact and approve again. If there is no reachable recipient, fix the contact details and retry.</Banner></div>}
      {sp.skipped && <div className="mb-4"><Banner icon="skip"><strong>Skipped.</strong></Banner></div>}
      {sp.error === 'not-found' && <div className="mb-4"><Banner tone="warn"><strong>Action not found</strong> or not visible to your account.</Banner></div>}
      {sp.ran && <div className="mb-4"><Banner icon="bolt"><strong>{sp.ran} new proposal(s)</strong> from the last run{sp.imported ? ` · ${sp.imported} applicants imported, ${sp.skipped ?? 0} skipped` : ''}.</Banner></div>}

      <div className="mb-4 flex flex-wrap gap-2 text-[14px]">
        {FILTERS.map(([s, label]) => (
          <a key={s} href={qs({ status: s })} className={`badge ${status === s ? '' : 'muted'}`}>{label}{s !== 'all' ? ` ${n(s)}` : ''}</a>
        ))}
      </div>
      <p className="mb-5 text-[13px] text-grey-h">
        States: {ACTION_STATUSES.map(s => STATUS_LABEL[s]).join(' · ')}. {simulated > 0 && <>{simulated} delivered action{simulated === 1 ? '' : 's'} {simulated === 1 ? 'is' : 'are'} simulated (mock adapter) and excluded from outcomes.</>}
      </p>
      <form className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_auto]" method="get">
        <input type="hidden" name="status" value={status} />
        <Select name="worker" defaultValue={worker} aria-label="Worker">
          <option value="">All workers</option>
          {WORKER_NAMES.map(w => <option key={w} value={w}>{WORKER_LABELS[w]}</option>)}
          <option value="inbound_triage">Inbound triage</option>
        </Select>
        <Select name="agency" defaultValue={agency} aria-label="Agency">
          <option value="">All agencies</option>
          {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Button variant="ghost" size="sm" type="submit">Filter</Button>
      </form>
      {freshness && <div className="mb-5"><ImportFreshness kind="applicants" info={freshness} href={`/staff/actions/applicants/import?agency=${agency}`} /></div>}

      {views.length === 0 ? (
        <Empty title={status === 'unknown' ? 'No deliveries in doubt' : status === 'proposed' ? 'Nothing waiting' : 'Nothing here'}>
          {status === 'unknown' ? 'Every provider-accepted message has a delivery callback.' : 'Run a worker in dry-run to see what it would send.'}
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {views.map(a => <ActionCard key={a.id} a={a} actions={{ approve: approveAction, editApprove: editAndApproveAction, skip: skipAction, retry: retryAction }} />)}
        </ul>
      )}
    </>
  )
}
