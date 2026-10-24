import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getAssessment, getSteps } from '@/lib/assessments/queries'
import { generateReport } from '@/lib/assessments/actions'
import { parseEvidence, provenanceSummary, INPUT_LABEL } from '@/lib/assessments/evidence'
import { recommendedService, successMetric } from '@/lib/assessments/recommend'
import { DOOR_SCOPE, money, categoryTotals, CATEGORY_LABEL, LEAK_CATEGORIES, INPUT_STATUS_LABEL, type InputKey } from '@/lib/leaks'
import { STEPS, TRACE_TITLES, elapsedLabel, type Trace } from '@/lib/assessments/steps'
import { getPricing, range } from '@/lib/catalog/pricing'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { GlassPill, GlassFacts } from '@/components/ui/GlassPill'
import { LeakCards } from '@/components/assessments/LeakCards'

export const metadata = { title: 'Assessment report' }
export const dynamic = 'force-dynamic'

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const label = (k: string) => INPUT_LABEL[k as InputKey] ?? k.replace(/_/g, ' ')

export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const a = await getAssessment(db, id)
    if (!a) return null
    return { a, steps: await getSteps(db, id) }
  }, { ip })
  if (!data) notFound()
  const { a, steps } = data
  const door = a.recommended_door ?? 'growth'
  const scope = DOOR_SCOPE[door]
  const leaks = a.leaks ?? []
  const totals = categoryTotals(leaks)
  const evidence = parseEvidence(a.evidence)
  const prov = provenanceSummary(leaks)
  const svc = recommendedService(leaks, door)
  const metric = successMetric(svc)
  const pricing = getPricing()
  const baseline = Object.entries(evidence.inputs).filter(([, e]) => e?.status === 'measured').map(([k]) => k)
  const observed = totals.observed_lost_revenue
  const opportunity = totals.potential_revenue_opportunity

  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/staff/assessments/${a.id}`}>← Walkthrough</Link>}
        title={<><span className="text-grey-h">Operations Assessment</span><br />{a.agency_name}</>}
        sub={`Prepared for ${a.owner_name ?? 'the owner'}. ${leaks.length ? `${money(observed)} observed lost revenue and ${money(opportunity)} potential opportunity per year (base estimates), by category below.` : 'Calculate the leaks in the walkthrough first.'}`}
        actions={<>
          {a.report_path && <a className="btn ghost sm" href={`/api/reports/${a.id}`} target="_blank" rel="noopener noreferrer">Open PDF</a>}
          <form action={generateReport}><input type="hidden" name="assessment_id" value={a.id} /><Button type="submit" size="sm">{a.report_path ? 'Regenerate PDF' : 'Generate PDF'}</Button></form>
        </>}
      />
      {sp.generated && <div className="mb-6"><Banner icon="file"><strong>PDF saved</strong> under the agency. It is now visible on the client&rsquo;s home page.</Banner></div>}

      <div className="flex flex-col gap-10">
        <section className="grid gap-6 md:grid-cols-2">
          {(['referral', 'visit'] as Trace[]).map(trace => (
            <div key={trace} className="rounded-[20px] border border-line p-5">
              <h2 className="mb-4 text-lg">{TRACE_TITLES[trace]}{evidence.redacted && <Badge tone="muted">redacted</Badge>}</h2>
              <ol className="relative flex flex-col gap-3 border-l border-line pl-5">
                {STEPS[trace].map((d, i) => {
                  const st = steps.find(s => s.trace === trace && s.step_key === d.key)
                  const prev = i > 0 ? steps.find(s => s.trace === trace && s.step_key === STEPS[trace][i - 1].key) : null
                  const el = prev ? elapsedLabel(prev.occurred_at, st?.occurred_at ?? null) : null
                  return (
                    <li key={d.key} className="relative">
                      <span className={`absolute -left-[26px] top-1.5 h-3 w-3 rounded-full ${st?.occurred_at ? 'bg-white' : 'border border-grey-h'}`} aria-hidden="true" />
                      <div className="text-ink font-medium text-[15px]">{d.title}{st?.outcome ? <span className="text-grey-h"> · {st.outcome}</span> : null}</div>
                      <div className="text-[13px] text-grey-h">{fmt(st?.occurred_at ?? null)}{st?.who ? ` · ${st.who}` : ''}{el ? ` · +${el}` : ''}</div>
                      {st?.what_went_wrong && <div className="text-[14px] text-grey">{st.what_went_wrong}</div>}
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-4">
          <h2>Three principal supported problems</h2>
          <LeakCards leaks={leaks} />
          {leaks.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {LEAK_CATEGORIES.filter(c => totals[c] > 0).map(c => (
                <div key={c} className="rounded-2xl border border-line px-4 py-3"><div className="text-[13px] text-grey-h">{CATEGORY_LABEL[c]}</div><div className="text-ink font-medium">{money(totals[c])} / yr</div></div>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-[20px] border border-line p-5">
            <h2 className="mb-3 text-lg">Evidence quality</h2>
            <dl className="flex flex-col gap-2 text-[14px]">
              <div className="flex justify-between gap-4"><dt className="text-grey-h">Period</dt><dd className="text-ink text-right">{evidence.period_start && evidence.period_end ? `${evidence.period_start} → ${evidence.period_end}` : 'not supplied'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-grey-h">Sample size</dt><dd className="text-ink text-right">{evidence.sample_size ?? 'not supplied'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-grey-h">Source</dt><dd className="text-ink text-right">{evidence.source_reference ?? 'not supplied'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-grey-h">Supplied by</dt><dd className="text-ink text-right">{evidence.supplied_by ?? 'not supplied'}</dd></div>
              {(['measured', 'owner_reported', 'assumed'] as const).map(s => (
                <div key={s} className="flex justify-between gap-4"><dt className="text-grey-h">{INPUT_STATUS_LABEL[s]}</dt><dd className="text-ink text-right">{prov[s].length ? prov[s].map(label).join(', ') : '—'}</dd></div>
              ))}
              <div className="flex justify-between gap-4"><dt className="text-grey-h">Missing data</dt><dd className="text-ink text-right">{evidence.missing.length ? evidence.missing.map(label).join(', ') : 'none'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-grey-h">Corrections</dt><dd className="text-ink text-right">{evidence.corrections.length}</dd></div>
            </dl>
          </div>
          <div className="rounded-[20px] border border-line p-5">
            <h2 className="mb-3 text-lg">Baseline and success metric</h2>
            <p className="text-[14px] text-grey">Baseline: {baseline.length ? baseline.map(label).join(', ') : 'no measured inputs yet; the baseline is set during build from the first export.'}</p>
            <p className="mt-3 text-[14px] text-grey">Recommended first workflow: <span className="text-ink">{svc.name}</span></p>
            {metric && <p className="mt-2 text-[14px] text-grey">Proposed success metric: <span className="text-ink">{metric.label}</span>. {metric.definition}</p>}
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
          <div className="metal p-5 md:p-6">
            <div className="relative flex h-full flex-col gap-4">
              <div><GlassPill icon="arrow-right">Recommended first door</GlassPill></div>
              <h2 className="text-ink text-2xl md:text-3xl tracking-tight">{scope.title}</h2>
              <ul className="list-disc pl-5 text-grey text-[15px] md:text-[17px] max-w-[52ch]">{scope.scope.map(x => <li key={x}>{x}</li>)}</ul>
              <div className="mt-auto"><GlassFacts facts={[{ icon: 'clock', label: 'Live in weeks' }, { icon: 'shield', label: 'Your systems stay' }]} /></div>
            </div>
          </div>
          <div className="rounded-[20px] border border-line p-5">
            <h2 className="mb-4 text-lg">Pricing</h2>
            <dl className="flex flex-col gap-3 text-[15px]">
              <div className="flex justify-between gap-4"><dt>Step 1 · Assessment</dt><dd className="text-ink text-right">{range(pricing.assessment)}{a.fee_cents ? <div className="text-[13px] text-grey-h">fee {money(a.fee_cents / 100)}; credit applies under the configured terms ({pricing.assessment.creditTermDays} days)</div> : null}</dd></div>
              <div className="flex justify-between gap-4"><dt>Step 2 · Build</dt><dd className="text-ink text-right">{range(pricing.build)}</dd></div>
              <div className="flex justify-between gap-4"><dt>Step 3 · Monthly management</dt><dd className="text-ink text-right">{range(pricing.management)} / mo</dd></div>
            </dl>
            <p className="mt-3 text-[13px] text-grey-h">Exact scope determines the final quote.</p>
            <h2 className="mb-3 mt-6 text-lg">Next steps</h2>
            <ol className="list-decimal pl-5 text-[15px] flex flex-col gap-1">
              <li>Pick the first door.</li>
              <li>Sign the BAA before any client data moves.</li>
              <li>Build, then run with a morning report every day.</li>
            </ol>
          </div>
        </section>
      </div>
    </>
  )
}
