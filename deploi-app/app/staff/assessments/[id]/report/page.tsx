import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { env } from '@/lib/env'
import { getAssessment, getSteps, leaksTotal } from '@/lib/assessments/queries'
import { generateReport } from '@/lib/assessments/actions'
import { DOOR_SCOPE, money } from '@/lib/leaks'
import { STEPS, TRACE_TITLES, elapsedLabel, type Trace } from '@/lib/assessments/steps'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { GlassPill, GlassFacts } from '@/components/ui/GlassPill'
import { LeakCards } from '@/components/assessments/LeakCards'

export const metadata = { title: 'Assessment report' }
export const dynamic = 'force-dynamic'

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

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
  const total = leaksTotal(a.leaks)

  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/staff/assessments/${a.id}`}>← Walkthrough</Link>}
        title={<><span className="text-grey-h">Operations Assessment</span><br />{a.agency_name}</>}
        sub={`Prepared for ${a.owner_name ?? 'the owner'}. ${a.leaks?.length ? `${money(total)} per year across the three biggest leaks.` : 'Calculate the leaks in the walkthrough first.'}`}
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
              <h2 className="mb-4 text-lg">{TRACE_TITLES[trace]}</h2>
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
          <h2>Three biggest leaks</h2>
          <LeakCards leaks={a.leaks ?? []} />
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
              <div className="flex justify-between gap-4"><dt>Step 1 · Assessment</dt><dd className="text-ink text-right">{env.pricing.assessment}{a.fee_cents ? <div className="text-[13px] text-grey-h">paid {money(a.fee_cents / 100)}, credited 60 days</div> : null}</dd></div>
              <div className="flex justify-between gap-4"><dt>Step 2 · Build</dt><dd className="text-ink text-right">{env.pricing.build}</dd></div>
              <div className="flex justify-between gap-4"><dt>Step 3 · Run</dt><dd className="text-ink text-right">{env.pricing.retainer}</dd></div>
            </dl>
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
