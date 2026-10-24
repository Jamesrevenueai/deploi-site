import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { listEngagements, statusCounts } from '@/lib/website/queries'
import { STATUSES, STATUS_LABEL, laborBudget, moneyCents, websitePriceCents, NO_CREDIT_TEXT, isStatus } from '@/lib/website/states'
import { getPricing } from '@/lib/catalog/pricing'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { Empty } from '@/components/ui/Empty'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { StatusBadge, PaymentBadge } from '@/components/website/StatusBadge'

export const metadata = { title: 'Website Improvement' }
export const dynamic = 'force-dynamic'

export default async function WebsiteListPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const status = isStatus(sp.status) ? sp.status : ''
  const { rows, counts } = await withUser(session, async db => ({ rows: await listEngagements(db, { status }), counts: await statusCounts(db) }), { ip: await requestIp() })
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const open = total - (counts.completed ?? 0) - (counts.cancelled ?? 0)
  const pricing = getPricing().website

  return (
    <>
      <PageHeader
        title="Website Improvement"
        sub={`${total} engagement${total === 1 ? '' : 's'} · ${open} open · ${counts.inquiry ?? 0} inquiries · ${counts.improving ?? 0} improving · ${moneyCents(websitePriceCents())} one-time, ${pricing.hoursBudget} staff hours, up to three pages`}
        actions={<Button variant="ghost" size="sm" href="/staff/pipeline?view=list&interest=website_improvement">Website leads in pipeline</Button>}
      />
      {sp.error === 'invalid-id' && <div className="mb-5"><Banner tone="warn"><strong>That engagement id is not valid.</strong></Banner></div>}
      <div className="mb-5"><Banner icon="spark">{NO_CREDIT_TEXT} Leads arrive from the site form tagged <strong>Website Improvement</strong>; no assessment is needed.</Banner></div>
      <form method="get" className="mb-5 grid grid-cols-[1fr_auto] gap-2 md:max-w-md">
        <Select name="status" defaultValue={status} aria-label="Status">
          <option value="">All statuses ({total})</option>
          {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]} ({counts[s] ?? 0})</option>)}
        </Select>
        <Button variant="ghost" size="sm" type="submit">Filter</Button>
      </form>
      {rows.length === 0 ? (
        <Empty title={status ? `No engagements in ${STATUS_LABEL[status].toLowerCase()}` : 'No website engagements yet'}>
          {status ? <Link href="/staff/website" className="text-ink underline">Clear the filter</Link> : 'A website lead from the site form creates one automatically in Inquiry.'}
        </Empty>
      ) : (
        <>
          <ul className="flex flex-col gap-3 min-[960px]:hidden">
            {rows.map(e => {
              const b = laborBudget(e.hours_logged)
              return (
                <li key={e.id} className="rounded-2xl border border-line p-4">
                  <Link href={`/staff/website/${e.id}`} className="block">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[16px] font-medium text-ink">{e.agency_name ?? 'Unlinked engagement'}</div>
                        <div className="truncate text-[13px] text-grey">{e.website_url ?? 'no site URL'}{e.platform ? ` · ${e.platform}` : ''}</div>
                      </div>
                      <StatusBadge status={e.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-grey-h">
                      <PaymentBadge status={e.payment_status} isMock={e.payment_is_mock} />
                      <span>{moneyCents(e.price_cents)}</span>
                      <span className={b.level === 'blocked' ? 'text-danger' : b.level === 'warn' ? 'text-warn' : ''}>{b.hours.toFixed(1)} / {b.budget} h</span>
                      {e.target_date && <span>target {String(e.target_date).slice(0, 10)}</span>}
                      {e.maintenance_requested && <Badge tone="muted">maintenance requested</Badge>}
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="table-wrap hidden min-[960px]:block">
            <table className="dg-table">
              <thead><tr><th>Practice</th><th>Site</th><th>Status</th><th>Payment</th><th>Price</th><th>Hours</th><th>Target</th><th>Updated</th></tr></thead>
              <tbody>
                {rows.map(e => {
                  const b = laborBudget(e.hours_logged)
                  return (
                    <tr key={e.id}>
                      <td className="ink"><Link href={`/staff/website/${e.id}`}>{e.agency_name ?? 'Unlinked engagement'}</Link>{e.owner_name && <div className="text-[13px] font-normal text-grey">{e.owner_name}</div>}</td>
                      <td>{e.website_url ?? '—'}{e.platform ? <div className="text-[13px]">{e.platform}</div> : null}</td>
                      <td><StatusBadge status={e.status} /></td>
                      <td><PaymentBadge status={e.payment_status} isMock={e.payment_is_mock} /></td>
                      <td>{moneyCents(e.price_cents)}</td>
                      <td className={b.level === 'blocked' ? 'text-danger' : b.level === 'warn' ? 'text-warn' : ''}>{b.hours.toFixed(2)} / {b.budget}{b.level !== 'ok' && <div className="text-[12px]">{b.level === 'blocked' ? 'budget reached' : 'near budget'}</div>}</td>
                      <td>{e.target_date ? String(e.target_date).slice(0, 10) : '—'}</td>
                      <td>{new Date(e.updated_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' })}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
