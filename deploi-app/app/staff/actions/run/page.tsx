import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { WORKER_LABELS, WORKER_NAMES } from '@/lib/workers/types'
import { runWorkerNow } from '../actions'

export const metadata = { title: 'Run a worker' }
export const dynamic = 'force-dynamic'

export default async function RunPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const { agencies, runs } = await withUser(session, async db => ({
    agencies: await db.query<{ id: string; name: string }>('select id, name from agencies order by name'),
    runs: await db.query<{ worker: string; agency_name: string | null; dry_run: boolean; started_at: string; summary: Record<string, number> }>(
      'select r.worker, g.name as agency_name, r.dry_run, r.started_at, r.summary from worker_runs r left join agencies g on g.id = r.agency_id order by r.started_at desc limit 12'),
  }), { ip: await requestIp() })
  const agencyId = sp.agency ?? agencies[0]?.id

  return (
    <>
      <PageHeader title="Run a worker" sub="Dry-run writes proposals only. The nightly cron does the same for every agency at 06:00 UTC." actions={<Button variant="ghost" size="sm" href="/staff/actions">Back to actions</Button>} />
      {sp.result && <div className="mb-5"><Banner icon="bolt"><strong>Done.</strong> {sp.result}</Banner></div>}
      <form method="get" className="mb-5 max-w-sm">
        <label className="field"><span className="text-ink text-[14px] font-medium">Agency</span>
          <Select name="agency" defaultValue={agencyId}>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        </label>
        <button className="btn ghost xs mt-2" type="submit">Load agency</button>
      </form>
      <div className="grid gap-3 md:grid-cols-2">
        {[...WORKER_NAMES, 'all' as const].map(w => (
          <form key={w} action={runWorkerNow} className="flex items-center justify-between gap-3 rounded-2xl border border-line p-4">
            <input type="hidden" name="agency_id" value={agencyId ?? ''} />
            <input type="hidden" name="worker" value={w} />
            <span className="text-ink font-medium">{w === 'all' ? 'All nightly workers' : WORKER_LABELS[w]}</span>
            <button className="btn ghost sm" type="submit"><Icon name="bolt" size={15} />Dry-run</button>
          </form>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" href="/staff/actions/referrals/new">Log a referral</Button>
        <Button variant="ghost" size="sm" href="/staff/actions/applicants/import">Import applicants</Button>
      </div>
      <h2 className="mt-10 mb-3 text-lg">Recent runs</h2>
      <ul className="flex flex-col gap-2 text-[14px]">
        {runs.map((r, i) => (
          <li key={i} className="flex flex-wrap justify-between gap-2 rounded-xl border border-line px-4 py-3">
            <span><span className="text-ink">{WORKER_LABELS[r.worker as keyof typeof WORKER_LABELS] ?? r.worker}</span> · {r.agency_name ?? '—'}{r.dry_run ? ' · dry-run' : ''}</span>
            <span className="text-grey-h">{r.summary?.inserted ?? 0} new / {r.summary?.proposed ?? 0} proposed · {new Date(r.started_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
