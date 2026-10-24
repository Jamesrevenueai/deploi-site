import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { listEngagements } from '@/lib/engagements/queries'
import { STATUSES, STATUS_LABEL, STATUS_TONE, isStatus } from '@/lib/engagements/states'
import { getService } from '@/lib/catalog/services'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Banner } from '@/components/ui/Banner'

export const metadata = { title: 'Engagements' }
export const dynamic = 'force-dynamic'

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')
const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default async function EngagementsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const status = sp.status && isStatus(sp.status) ? sp.status : null
  const { rows, counts } = await withUser(session, async db => {
    const rows = await listEngagements(db, { status })
    const counts = await db.query<{ status: string; n: string }>('select status, count(*)::text as n from engagements group by status')
    return { rows, counts }
  }, { ip: await requestIp() })
  const n = (s: string) => Number(counts.find(c => c.status === s)?.n ?? 0)
  const total = counts.reduce((x, c) => x + Number(c.n), 0)

  return (
    <>
      <PageHeader title="Engagements" eyebrow="Proposal to pilot" sub="One row per sold service: proposal, acceptance evidence, onboarding gates, pilot measurement. Website Improvement work lives on the pipeline, not here."
        actions={<Button size="sm" href="/staff/engagements/new">New engagement</Button>} />
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Something went wrong.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}

      <div className="mb-5 flex flex-wrap gap-2 text-[14px]">
        <Link href="/staff/engagements" className={`badge ${status ? 'muted' : ''}`}>All {total}</Link>
        {STATUSES.map(s => <Link key={s} href={`/staff/engagements?status=${s}`} className={`badge ${status === s ? '' : 'muted'}`}>{STATUS_LABEL[s]} {n(s)}</Link>)}
      </div>

      {rows.length === 0 ? (
        <Empty title={status ? `No ${STATUS_LABEL[status].toLowerCase()} engagements` : 'No engagements yet'}>
          {status ? <Link href="/staff/engagements" className="text-ink">Show all</Link> : <>Create one from an agency with a sold build. Drafts prefill from the service catalog.</>}
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map(e => {
            const svc = getService(e.service_key)
            return (
              <li key={e.id} className="rounded-[20px] border border-line p-4 md:p-5">
                <Link href={`/staff/engagements/${e.id}`} className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ink font-medium">{e.agency_name}</span>
                      <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                    </div>
                    <div className="mt-1 text-[14px]">{svc?.name ?? e.service_key} · setup {money(e.setup_fee_cents)} · {money(e.monthly_fee_cents)}/mo{e.credit_applied_cents ? ` · credit ${money(e.credit_applied_cents)}` : ''}</div>
                    <div className="text-[13px] text-grey-h">{e.deploi_owner ? `Deploi: ${e.deploi_owner} · ` : ''}updated {date(e.updated_at)}{e.baa_signed_at ? '' : ' · BAA not signed'}</div>
                  </div>
                  <span className="btn ghost xs self-start md:self-auto">Open</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
