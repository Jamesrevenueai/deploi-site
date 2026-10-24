import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getAssessment, getSteps } from '@/lib/assessments/queries'
import { parseEvidence } from '@/lib/assessments/evidence'
import { getCreditForAssessment, listApplications } from '@/lib/credit/ledger'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { TraceForm } from '@/components/assessments/TraceForm'
import { LeakInputsForm } from '@/components/assessments/LeakInputsForm'
import { CorrectionsLog } from '@/components/assessments/CorrectionsLog'
import { CreditPanel } from '@/components/assessments/CreditPanel'
import { BaaCard } from '@/components/baa/BaaCard'

export const metadata = { title: 'Assessment walkthrough' }
export const dynamic = 'force-dynamic'

const CREDIT_MSG: Record<string, string> = { paid: 'Payment recorded on the ledger. The credit is now available for a qualifying build.', mock_paid: 'Mock payment recorded. It is simulated: the credit stays unusable until a real payment is recorded.' }

export default async function Walkthrough({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const a = await getAssessment(db, id)
    if (!a) return null
    const baa = await db.one<{ baa_signed_at: string | null; baa_document_url: string | null }>('select baa_signed_at, baa_document_url from agencies where id = $1', [a.agency_id])
    const credit = await getCreditForAssessment(db, a.id)
    const applications = credit ? await listApplications(db, credit.id) : []
    return { a, steps: await getSteps(db, id), baa, credit, applications }
  }, { ip })
  if (!data) notFound()
  const { a, steps, baa, credit, applications } = data
  const evidence = parseEvidence(a.evidence)
  const creditError = sp.error?.startsWith('credit-') ? sp.error.replace(/^credit-/, '').replace(/_/g, ' ') : null
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/staff/assessments">Assessments</Link>}
        title={a.agency_name}
        sub={<>Walkthrough with {a.owner_name ?? 'the owner'}. Timestamp each step; the gaps are where the money leaks. Step fields are optional: aggregate or redacted traces are fine. <Badge tone={a.status === 'complete' ? 'ok' : 'warn'}>{a.status.replace(/_/g, ' ')}</Badge></>}
        actions={<><Link className="btn ghost sm" href={`/staff/agencies/${a.agency_id}`}>Agency</Link><Link className="btn ghost sm" href={`/staff/assessments/${a.id}/report`}>Report</Link></>}
      />
      {sp.credit && CREDIT_MSG[sp.credit] && <div className="mb-6"><Banner icon="dollar"><strong>{sp.credit === 'paid' ? 'Payment recorded.' : 'Simulated payment recorded.'}</strong> {CREDIT_MSG[sp.credit]}</Banner></div>}
      {creditError && <div className="mb-6"><Banner tone="warn"><strong>Credit action refused.</strong> {creditError}.</Banner></div>}
      {sp.corrected && <div className="mb-6"><Banner icon="edit"><strong>Correction logged.</strong> The previous value stays in the log; inputs were recalculated where applicable.</Banner></div>}
      {sp.error === 'correction-incomplete' && <div className="mb-6"><Banner tone="warn"><strong>Correction not logged.</strong> Field, corrected value and who corrected it are required.</Banner></div>}
      <div className="flex flex-col gap-10">
        <CreditPanel credit={credit} applications={applications} back={`/staff/assessments/${a.id}`} />
        <TraceForm assessmentId={a.id} trace="referral" steps={steps} />
        <TraceForm assessmentId={a.id} trace="visit" steps={steps} />
        <section id="leaks" className="flex flex-col gap-4">
          <h2>Leak calculator</h2>
          <p className="text-grey max-w-[64ch]">The owner&rsquo;s averages plus, where available, counts from real exports. Each input carries a status (measured, owner-reported, assumed) that sets the evidence grade; the two traces corroborate but never set a frequency. The three principal problems go on the report with the formula next to the dollars.</p>
          <LeakInputsForm assessmentId={a.id} inputs={a.inputs ?? {}} evidence={evidence} />
          <CorrectionsLog assessmentId={a.id} evidence={evidence} />
        </section>
        <BaaCard assessmentId={a.id} agencyId={a.agency_id} signedAt={baa?.baa_signed_at ?? null} documentUrl={baa?.baa_document_url ?? null} error={sp.error?.startsWith('baa') ? sp.error : undefined} justSigned={sp.baa === 'signed'} />
      </div>
    </>
  )
}
