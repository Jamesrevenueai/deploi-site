import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getAssessment, getSteps } from '@/lib/assessments/queries'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { TraceForm } from '@/components/assessments/TraceForm'
import { LeakInputsForm } from '@/components/assessments/LeakInputsForm'
import { BaaCard } from '@/components/baa/BaaCard'

export const metadata = { title: 'Assessment walkthrough' }
export const dynamic = 'force-dynamic'

export default async function Walkthrough({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const a = await getAssessment(db, id)
    if (!a) return null
    const baa = await db.one<{ baa_signed_at: string | null; baa_document_url: string | null }>('select baa_signed_at, baa_document_url from agencies where id = $1', [a.agency_id])
    return { a, steps: await getSteps(db, id), baa }
  }, { ip })
  if (!data) notFound()
  const { a, steps, baa } = data
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/staff/assessments">Assessments</Link>}
        title={a.agency_name}
        sub={<>Walkthrough with {a.owner_name ?? 'the owner'}. Timestamp each step; the gaps are where the money leaks. <Badge tone={a.status === 'complete' ? 'ok' : 'warn'}>{a.status.replace(/_/g, ' ')}</Badge></>}
        actions={<><Link className="btn ghost sm" href={`/staff/agencies/${a.agency_id}`}>Agency</Link><Link className="btn ghost sm" href={`/staff/assessments/${a.id}/report`}>Report</Link></>}
      />
      <div className="flex flex-col gap-10">
        <TraceForm assessmentId={a.id} trace="referral" steps={steps} />
        <TraceForm assessmentId={a.id} trace="visit" steps={steps} />
        <section id="leaks" className="flex flex-col gap-4">
          <h2>Leak calculator</h2>
          <p className="text-grey max-w-[60ch]">Five numbers from the owner plus what the traces showed. The three biggest leaks go on the report with the formula next to the dollars.</p>
          <LeakInputsForm assessmentId={a.id} inputs={a.inputs ?? {}} />
        </section>
        <BaaCard assessmentId={a.id} agencyId={a.agency_id} signedAt={baa?.baa_signed_at ?? null} documentUrl={baa?.baa_document_url ?? null} error={sp.error} justSigned={sp.baa === 'signed'} />
      </div>
    </>
  )
}
