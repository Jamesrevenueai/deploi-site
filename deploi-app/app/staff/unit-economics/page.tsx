import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { admin } from '@/lib/db'
import { currentMonth, economicsReport } from '@/lib/platform/economics'
import { loadPlans, invalidatePlanCache } from '@/lib/plans/catalog'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Economics' }
export const dynamic = 'force-dynamic'

const usd = (n: number | null, d = 2) => (n === null ? '—' : `$${n.toFixed(d)}`)
const FLAG: Record<string, string> = { above_target: 'above target', negative_margin: 'negative margin', no_revenue_with_cost: 'cost, no revenue' }

function shift(month: string, by: number) {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return d.toISOString().slice(0, 7)
}

export default async function EconomicsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireRole('staff')
  const sp = await searchParams
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? '') ? sp.month! : currentMonth()
  invalidatePlanCache()
  const [report, plans] = await admin(db => Promise.all([economicsReport(db, month), loadPlans(db)]))
  const t = report.totals
  return (
    <>
      <PageHeader title="Unit economics" eyebrow="Staff" sub="Per organization and month: what it pays, what it costs to serve, and what each verified resolution costs." />
      <div className="mb-5 flex flex-col gap-2">
        <Banner icon="dollar">
          Variable-cost target: <strong>{usd(report.prices.targetMinUsd, 0)}–{usd(report.prices.targetMaxUsd, 0)} a month for a {usd(report.prices.targetPlanUsd, 0)} plan</strong>, scaled by each plan&rsquo;s price.
          Unit prices (estimates, from the environment): job run {usd(report.prices.jobRunUsd, 4)}, provider call {usd(report.prices.providerCallUsd, 4)}, email {usd(report.prices.emailUsd, 4)}. Model cost is measured per call.
        </Banner>
      </div>
      <div className="mb-4 flex items-center gap-3 text-[14px]">
        <Link href={`?month=${shift(month, -1)}`} className="badge muted">&larr; {shift(month, -1)}</Link>
        <strong>{month}</strong>
        <Link href={`?month=${shift(month, 1)}`} className="badge muted">{shift(month, 1)} &rarr;</Link>
        <span className="ml-auto">Revenue {usd(t.revenueUsd)} · variable cost {usd(t.variableCostUsd)} · {t.verifiedResolutions} verified resolutions · {t.flagged} flagged</span>
      </div>
      {report.orgs.length === 0 ? <Empty title="No organizations">Merchant organizations appear here.</Empty> : (
        <div className="table-wrap">
          <table className="dg-table">
            <thead><tr><th>Organization</th><th>Plan</th><th>Revenue</th><th>AI</th><th>Provider/API</th><th>Email</th><th>Variable</th><th>Resolutions</th><th>Per resolution</th><th>Margin</th><th>Flags</th></tr></thead>
            <tbody>
              {report.orgs.map(o => (
                <tr key={o.orgId}>
                  <td className="ink">{o.orgName}</td>
                  <td>{o.plan ?? '—'}{o.subscriptionStatus ? <span className="text-grey-h"> ({o.subscriptionStatus})</span> : null}</td>
                  <td>{usd(o.revenueUsd)}</td>
                  <td>{usd(o.aiCostUsd, 4)} <span className="text-grey-h">({o.aiCalls})</span></td>
                  <td>{usd(o.providerCostUsd + o.jobCostUsd, 4)}{Object.keys(o.providerCalls).length ? <div className="text-[12px] text-grey-h">{Object.entries(o.providerCalls).map(([c, n]) => `${c} ${n}`).join(' · ')} calls</div> : null}</td>
                  <td>{usd(o.emailCostUsd, 4)}</td>
                  <td>{usd(o.variableCostUsd)}</td>
                  <td>{o.verifiedResolutions}</td>
                  <td>{usd(o.costPerResolutionUsd)}</td>
                  <td>{o.grossMarginPct === null ? '—' : `${o.grossMarginPct}%`}</td>
                  <td>{o.flags.length ? o.flags.map(f => <Badge key={f} tone="warn">{FLAG[f] ?? f}</Badge>) : <Badge tone="ok">ok</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-8 mb-3 text-[1.1rem]">Plans</h2>
      <p className="mb-3 text-[14px]">Edited through <code>POST /api/staff/plans</code> (audited). A hypothesis is sold in Stripe test mode only; the owner approves a price before it is final. Editing a plan never changes an existing subscription.</p>
      <div className="table-wrap">
        <table className="dg-table">
          <thead><tr><th>Plan</th><th>Suite</th><th>Price</th><th>Library tier</th><th>Agents</th><th>Actions/mo</th><th>Emails/mo</th><th>AI budget</th><th>Status</th><th>Version</th></tr></thead>
          <tbody>
            {plans.map(p => (
              <tr key={p.key}>
                <td className="ink">{p.display_name} <span className="text-grey-h">{p.key}</span></td>
                <td>{p.suite}</td>
                <td>{usd(p.monthly_price_cents / 100, 0)}</td>
                <td>{p.tier_key}</td>
                <td>{p.limits.maxAgents ?? '—'}</td>
                <td>{p.limits.monthlyActions ?? '—'}</td>
                <td>{p.limits.monthlyEmails ?? '—'}</td>
                <td>{p.limits.aiBudgetUsd !== undefined ? usd(p.limits.aiBudgetUsd, 0) : '—'}</td>
                <td><Badge tone={p.status === 'approved' ? 'ok' : p.status === 'retired' ? 'muted' : 'warn'}>{p.status}</Badge>{!p.active && <Badge tone="muted">inactive</Badge>}</td>
                <td>{p.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
