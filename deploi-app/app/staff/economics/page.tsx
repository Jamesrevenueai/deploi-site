import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { loadEconomicsOverview } from '@/lib/economics/queries'
import { CONTRIBUTION_LABEL, LABOR_KINDS, dollars } from '@/lib/economics/calc'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { MobileRows } from '@/components/dashboard/MobileRows'

export const metadata = { title: 'Economics' }
export const dynamic = 'force-dynamic'

const hrs = (n: number) => `${n.toFixed(2).replace(/\.00$/, '')} h`

export default async function EconomicsPage() {
  const session = await requireRole('staff')
  const ov = await withUser(session, db => loadEconomicsOverview(db), { ip: await requestIp() })
  const withData = ov.agencies.filter(a => a.collectedCents || a.projectedCents || a.mockCount || a.laborCents || a.costCents || a.engagements.length)
  const rates = (Object.entries(ov.rates) as [string, number][]).map(([k, v]) => `${k.replace('_labor', '')} ${dollars(v)}/h`).join(' · ')

  return (
    <>
      <PageHeader title="Economics" eyebrow="Internal · staff only" sub="Collected versus projected revenue, labor by kind at the current rates, costs and contribution per agency. Manual entries; no accounting system."
        actions={<><Button variant="ghost" size="sm" href="/staff/economics/log">Log an entry</Button><Button variant="ghost" size="sm" href="/staff/economics/rates">Rates</Button></>} />
      <div className="mb-5"><Banner icon="dollar"><strong>{CONTRIBUTION_LABEL}.</strong> Mock payments are listed but never counted as collected. Rates: {rates}. Month shown: {ov.month}.</Banner></div>

      {withData.length === 0 ? <Empty title="No economics entries yet">Log labor, costs or revenue to see contribution per agency.</Empty> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Agency</th><th>Collected</th><th>Projected</th><th>Mock</th><th>Labor hours</th><th>Labor value</th><th>Costs</th><th>Contribution*</th><th>Month {ov.month}*</th><th>Review h / case</th><th>Support h</th><th>Cost / completed workflow</th></tr></thead>
              <tbody>
                {withData.map(a => (
                  <tr key={a.agencyId}>
                    <td className="ink">{a.name}</td>
                    <td className="ink">{dollars(a.collectedCents)}</td>
                    <td>{dollars(a.projectedCents)}</td>
                    <td>{a.mockCount ? <Badge tone="muted">{a.mockCount} mock · {dollars(a.mockCents)} excluded</Badge> : '—'}</td>
                    <td className="whitespace-nowrap">{LABOR_KINDS.filter(k => a.hours[k]).map(k => `${k} ${hrs(a.hours[k])}`).join(' · ') || '—'}</td>
                    <td>{dollars(a.laborCents)}</td>
                    <td>{dollars(a.costCents)}</td>
                    <td className={a.contributionCents < 0 ? 'text-danger' : 'ink'}>{dollars(a.contributionCents)}</td>
                    <td className={a.month.contributionCents < 0 ? 'text-danger' : ''}>{dollars(a.month.contributionCents)}<div className="text-[12px] text-grey-h">{dollars(a.month.collectedMonthlyCents)} collected · {dollars(a.month.opsLaborCents)} ops labor · {dollars(a.month.runCostCents)} run costs</div></td>
                    <td>{a.reviewHoursPerCase === null ? <span className="text-grey-h">— ({a.casesDecided} decided)</span> : `${a.reviewHoursPerCase} h (${a.casesDecided} decided)`}</td>
                    <td>{hrs(a.supportHours)}</td>
                    <td>{a.completedNote ? <span className="text-grey-h">{a.completedNote}</span> : a.costPerCompletedWorkflowCents === null ? <span className="text-grey-h">— (0 completed)</span> : `${dollars(a.costPerCompletedWorkflowCents)} (${a.completedWorkflows})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MobileRows rows={withData.map(a => ({
            key: a.agencyId, title: a.name, badge: <Badge tone={a.contributionCents < 0 ? 'danger' : 'ok'}>{dollars(a.contributionCents)}</Badge>,
            lines: [
              `Collected ${dollars(a.collectedCents)} · projected ${dollars(a.projectedCents)}${a.mockCount ? ` · ${a.mockCount} mock excluded` : ''}`,
              `Labor ${dollars(a.laborCents)} (${LABOR_KINDS.filter(k => a.hours[k]).map(k => `${k} ${hrs(a.hours[k])}`).join(', ') || 'none'}) · costs ${dollars(a.costCents)}`,
              `Month ${ov.month}: ${dollars(a.month.contributionCents)} contribution`,
              `Review ${a.reviewHoursPerCase === null ? '—' : a.reviewHoursPerCase + ' h'} / case (${a.casesDecided} decided) · support ${hrs(a.supportHours)}`,
              a.completedNote ?? (a.costPerCompletedWorkflowCents === null ? 'Cost per completed workflow: — (0 completed)' : `Cost per completed workflow ${dollars(a.costPerCompletedWorkflowCents)} (${a.completedWorkflows})`),
            ],
          }))} />
          <p className="mt-3 text-[13px] text-grey-h">* {CONTRIBUTION_LABEL}. Review time per case = review hours ÷ proposed actions decided in the last 30 days. Cost per completed workflow = (labor + costs) ÷ delivered, non-simulated actions.</p>
        </>
      )}

      <section className="mt-8">
        <h2 className="mb-3">Implementation contribution per engagement</h2>
        {ov.agencies.every(a => a.engagementsNote) ? <p className="text-grey">Engagements table not available yet; per-engagement figures appear once the engage stream&apos;s tables exist.</p>
          : ov.agencies.flatMap(a => a.engagements).length === 0 ? <p className="text-grey">No engagements recorded.</p> : (
          <ul className="flex flex-col gap-3">
            {ov.agencies.flatMap(a => a.engagements.map(e => (
              <li key={e.engagementRef} className="rounded-[20px] border border-line p-4 text-[15px]">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-ink font-medium">{a.name} · {e.serviceKey ?? 'service'}</span>{e.status && <Badge tone="none">{e.status}</Badge>}</div>
                <div className="mt-1 text-grey">Setup fee collected {dollars(e.collectedSetupCents)} (projected {dollars(e.projectedSetupCents)}) − build labor {hrs(e.buildHours)} = {dollars(e.buildLaborCents)} − costs {dollars(e.implementationCostCents)} = <span className={e.contributionCents < 0 ? 'text-danger' : 'text-ink'}>{dollars(e.contributionCents)}</span> contribution*</div>
                <div className="text-[12px] text-grey-h">engagement {e.engagementRef}</div>
              </li>
            )))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3">Website Improvement</h2>
        {ov.websitesNote && <p className="mb-2 text-[14px] text-grey-h">{ov.websitesNote}.</p>}
        {ov.websites.length === 0 ? <p className="text-grey">No website engagements recorded.</p> : (
          <ul className="flex flex-col gap-3">
            {ov.websites.map(w => (
              <li key={w.id} className="rounded-[20px] border border-line p-4 text-[15px]">
                <div className="flex flex-wrap items-center gap-2"><span className="text-ink font-medium">Website engagement</span>{w.status && <Badge tone="none">{w.status}</Badge>}<Badge tone={w.collected ? 'ok' : 'muted'}>{w.paymentStatus ?? 'unpaid'}{w.isMock ? ' (mock, excluded)' : ''}</Badge></div>
                <div className="mt-1 text-grey">Price {dollars(w.priceCents)} vs {hrs(w.hours)} × build rate = {dollars(w.laborValueCents)} → <span className={w.contributionCents < 0 ? 'text-danger' : 'text-ink'}>{dollars(w.contributionCents)}</span> contribution* ({w.collected ? 'collected' : 'not collected: price counted as 0'})</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(Object.values(ov.unassigned.hours).some(Boolean) || ov.unassigned.costCents !== 0) && (
        <p className="mt-6 text-[13px] text-grey-h">Unassigned to an agency: {LABOR_KINDS.filter(k => ov.unassigned.hours[k]).map(k => `${k} ${hrs(ov.unassigned.hours[k])}`).join(', ') || 'no labor'} · costs {dollars(ov.unassigned.costCents)}.</p>
      )}
    </>
  )
}
