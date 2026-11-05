import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { admin } from '@/lib/db'
import { currentMonth } from '@/lib/platform/economics'
import { financeReport } from '@/lib/billing/finance'
import { invalidatePlanCache } from '@/lib/plans/catalog'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Finance' }
export const dynamic = 'force-dynamic'

const money = (cents: number | null) => (cents === null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`)
const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)
const pct = (n: number | null) => (n === null ? '—' : `${n}%`)

function shift(month: string, by: number) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7)
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="au-panel p-4">
      <div className="text-[13px] text-grey">{label}</div>
      <div className="mt-1 text-[1.4rem] ink" data-stat={label}>{value}</div>
      {sub && <div className="mt-1 text-[12px] text-grey">{sub}</div>}
    </div>
  )
}

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireRole('staff')
  const sp = await searchParams
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? '') ? sp.month! : currentMonth()
  invalidatePlanCache()
  const r = await admin(db => financeReport(db, month))
  const s = r.summary
  return (
    <>
      <PageHeader title="Finance" eyebrow="Staff" sub="Recurring revenue, trials, churn and failed payments, and revenue against variable cost per organization." />
      {s.mrr.pricesAreHypotheses && (
        <div className="mb-4"><Banner tone="warn">Pilot pricing: some or all of this revenue comes from plan prices that are still hypotheses (not approved by the owner). Treat MRR as a projection, not booked revenue.</Banner></div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[14px]">
        <Link href={`?month=${shift(month, -1)}`} className="badge muted">&larr; {shift(month, -1)}</Link>
        <strong>{month}</strong>
        <Link href={`?month=${shift(month, 1)}`} className="badge muted">{shift(month, 1)} &rarr;</Link>
        <a className="badge ml-auto" href={`/api/staff/finance?month=${month}&format=csv`} download>Export CSV</a>
      </div>
      <h2 className="mb-2 text-[1.05rem]">Recurring revenue (as of now)</h2>
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="MRR (live)" value={money(s.mrr.liveCents)} sub={s.mrr.hypothesisCents ? `${money(s.mrr.hypothesisCents)} at hypothesis prices` : undefined} />
        <Stat label="ARR (live)" value={money(s.mrr.arrLiveCents)} />
        <Stat label="MRR (test mode)" value={money(s.mrr.testCents)} sub="Stripe test mode and Shopify test charges: not revenue" />
        <Stat label="Paying subscriptions" value={String(s.mrr.subscriptions)} sub={s.mrr.unpriced ? `${s.mrr.unpriced} without a plan price` : undefined} />
      </div>
      {s.mrr.byPlan.length > 0 && (
        <div className="table-wrap mt-3">
          <table className="dg-table">
            <thead><tr><th>Plan</th><th>Subscriptions</th><th>MRR</th><th>Price</th></tr></thead>
            <tbody>{s.mrr.byPlan.map(p => (
              <tr key={p.planKey}><td className="ink">{p.name}</td><td>{p.count}</td><td>{money(p.mrrCents)}</td><td>{p.hypothesis ? <Badge tone="warn">hypothesis</Badge> : <Badge tone="ok">approved</Badge>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <h2 className="mt-6 mb-2 text-[1.05rem]">{month}</h2>
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Trials started" value={String(s.trials.started)} sub={`${s.trials.running} running now`} />
        <Stat label="Trial conversion" value={pct(s.trials.conversionPct)} sub={`${s.trials.converted} of ${s.trials.ended} ended (${s.trials.lapsed} lapsed, ${s.trials.canceled} cancelled)`} />
        <Stat label="Churn" value={pct(s.churn.churnPct)} sub={`${s.churn.churned} of ${s.churn.activeAtStart} ended · ${money(s.churn.churnedMrrCents)} MRR · ${s.churn.scheduled} set to end`} />
        <Stat label="Failed payments" value={String(s.failedPayments.attempts)} sub={`${s.failedPayments.orgs} organizations · ${money(s.failedPayments.amountDueCents)} due · ${s.failedPayments.recovered} recovered · ${s.failedPayments.openNow} open now`} />
      </div>
      {Object.keys(s.churn.reasons).length > 0 && (
        <p className="mt-2 text-[13px] text-grey">Cancellation reasons: {Object.entries(s.churn.reasons).map(([k, n]) => `${k.replace(/_/g, ' ')} (${n})`).join(', ')}</p>
      )}
      <h2 className="mt-6 mb-2 text-[1.05rem]">Revenue and variable cost per organization</h2>
      {r.orgs.length === 0 ? <Empty title="No organizations">Merchant organizations appear here.</Empty> : (
        <div className="table-wrap">
          <table className="dg-table">
            <thead><tr><th>Organization</th><th>Plan</th><th>Status</th><th>MRR</th><th>Revenue</th><th>Variable cost</th><th>Margin</th><th>Failed payments</th><th>Trial</th><th>Flags</th></tr></thead>
            <tbody>
              {r.orgs.map(o => (
                <tr key={o.orgId}>
                  <td className="ink">{o.orgName}</td>
                  <td>{o.planName ?? o.plan ?? '—'}{o.hypothesisPrice && <> <Badge tone="warn">pilot</Badge></>}</td>
                  <td>{o.subscriptionStatus ?? '—'}{o.provider ? <span className="text-grey-h"> ({o.provider}{o.livemode === false ? ', test' : ''})</span> : null}</td>
                  <td>{money(o.mrrCents)}</td>
                  <td>{usd(o.revenueUsd)}</td>
                  <td>{usd(o.variableCostUsd)}</td>
                  <td>{pct(o.grossMarginPct)}</td>
                  <td>{o.failedPayments}</td>
                  <td>{o.trialOutcome ?? '—'}</td>
                  <td>{o.flags.length ? o.flags.map(f => <Badge key={f} tone="warn">{f.replace(/_/g, ' ')}</Badge>) : <Badge tone="ok">ok</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-[13px] text-grey">Amounts use the plans table&rsquo;s prices; Stripe&rsquo;s invoices are the record of what was charged. Variable cost is from <Link href={`/staff/unit-economics?month=${month}`} className="underline">Unit economics</Link>.</p>
    </>
  )
}
