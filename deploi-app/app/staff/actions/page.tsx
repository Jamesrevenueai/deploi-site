import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Empty } from '@/components/ui/Empty'
import { ActionCard, type ActionView } from '@/components/actions/ActionCard'
import { WORKER_LABELS, WORKER_NAMES, type WorkerName } from '@/lib/workers/types'
import { approveAction, editAndApproveAction, skipAction } from './actions'

export const metadata = { title: 'Proposed actions' }
export const dynamic = 'force-dynamic'

type Row = { id: string; agency_id: string; agency_name: string | null; worker: WorkerName; kind: 'email' | 'sms' | 'task'; to_ref: string | null; subject: string | null; body: string; payload: Record<string, unknown>; status: string; created_at: string; sent_at: string | null }

export default async function ActionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const status = sp.status ?? 'proposed'
  const worker = sp.worker ?? ''
  const agency = sp.agency ?? ''

  const { rows, agencies, counts } = await withUser(session, async db => {
    const where: string[] = []
    const params: unknown[] = []
    if (status && status !== 'all') { params.push(status); where.push(`status = $${params.length}`) }
    if (worker) { params.push(worker); where.push(`worker = $${params.length}`) }
    if (agency) { params.push(agency); where.push(`agency_id = $${params.length}`) }
    const w = where.length ? 'where ' + where.join(' and ') : ''
    const rows = await db.query<Row>(`select id, agency_id, agency_name, worker, kind, to_ref, subject, body, payload, status, created_at, sent_at from proposed_actions ${w} order by created_at desc limit 200`, params)
    await db.auditRead('proposed_actions', agency || null, rows.map(r => r.id))
    const agencies = await db.query<{ id: string; name: string }>('select id, name from agencies order by name')
    const counts = await db.query<{ status: string; n: string }>('select status, count(*)::text as n from proposed_actions group by status')
    return { rows, agencies, counts }
  }, { ip: await requestIp() })

  const views: ActionView[] = rows.map(r => ({
    id: r.id, agency_name: r.agency_name, worker: r.worker, kind: r.kind, subject: r.subject, body: r.body, status: r.status, created_at: r.created_at, sent_at: r.sent_at,
    to_label: String(r.payload?.to_label ?? r.to_ref?.split(':')[0] ?? 'recipient'), about: r.payload?.about ? String(r.payload.about) : null,
  }))
  const n = (s: string) => Number(counts.find(c => c.status === s)?.n ?? 0)
  const qs = (patch: Record<string, string>) => '?' + new URLSearchParams({ status, ...(worker && { worker }), ...(agency && { agency }), ...patch }).toString()

  return (
    <>
      <PageHeader
        title="Proposed actions"
        sub="Everything a worker wants to send. Nothing reaches an aide, family or referrer until you approve it or switch a worker to auto-send."
        actions={<><Button variant="ghost" size="sm" href="/staff/actions/run">Run a worker</Button><Button variant="ghost" size="sm" href="/staff/actions/settings">Auto-send</Button></>}
      />
      {sp.approved && <div className="mb-4"><Banner icon="check"><strong>Sent.</strong> The action was delivered (or recorded in the mock outbox when no provider is configured).</Banner></div>}
      {sp.failed && <div className="mb-4"><Banner tone="warn"><strong>Could not send.</strong> No reachable recipient for that action (missing phone or email). Edit the record and try again.</Banner></div>}
      {sp.skipped && <div className="mb-4"><Banner icon="skip"><strong>Skipped.</strong></Banner></div>}
      {sp.ran && <div className="mb-4"><Banner icon="bolt"><strong>{sp.ran} new proposal(s)</strong> from the last run{sp.imported ? ` · ${sp.imported} applicants imported, ${sp.skipped ?? 0} skipped` : ''}.</Banner></div>}

      <div className="mb-4 flex flex-wrap gap-2 text-[14px]">
        {[['proposed', 'Waiting'], ['sent', 'Sent'], ['skipped', 'Skipped'], ['all', 'All']].map(([s, label]) => (
          <a key={s} href={qs({ status: s })} className={`badge ${status === s ? '' : 'muted'}`}>{label}{s !== 'all' ? ` ${n(s)}` : ''}</a>
        ))}
      </div>
      <form className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_auto]" method="get">
        <input type="hidden" name="status" value={status} />
        <Select name="worker" defaultValue={worker} aria-label="Worker">
          <option value="">All workers</option>
          {WORKER_NAMES.map(w => <option key={w} value={w}>{WORKER_LABELS[w]}</option>)}
        </Select>
        <Select name="agency" defaultValue={agency} aria-label="Agency">
          <option value="">All agencies</option>
          {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Button variant="ghost" size="sm" type="submit">Filter</Button>
      </form>

      {views.length === 0 ? (
        <Empty title="Nothing waiting">Run a worker in dry-run to see what it would send.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {views.map(a => <ActionCard key={a.id} a={a} actions={{ approve: approveAction, editApprove: editAndApproveAction, skip: skipAction }} />)}
        </ul>
      )}
    </>
  )
}
