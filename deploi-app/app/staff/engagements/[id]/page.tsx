import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getEngagement, listTransitions } from '@/lib/engagements/queries'
import { availableTransitions } from '@/lib/engagements/transition'
import { STATUS_LABEL } from '@/lib/engagements/states'
import { CREDIT_ERROR_TEXT } from '@/lib/engagements/credit'
import { listCredits } from '@/lib/credit/ledger'
import { engagementReadiness } from '@/lib/onboarding/facts'
import { getPilot, listMeasurements } from '@/lib/pilots/queries'
import { getService, AVAILABILITY_LABEL } from '@/lib/catalog/services'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { ProposalForm } from '@/components/engagements/ProposalForm'
import { TransitionPanel } from '@/components/engagements/TransitionPanel'
import { CreditPanel } from '@/components/engagements/CreditPanel'
import { ChecklistPanel } from '@/components/engagements/ChecklistPanel'
import { PilotPanel } from '@/components/engagements/PilotPanel'

export const metadata = { title: 'Engagement' }
export const dynamic = 'force-dynamic'

const ERRORS: Record<string, string> = {
  'illegal-transition': 'That status change is not allowed from the current status.',
  'invalid-status': 'Unknown status.',
  'acceptance-evidence-required': 'Record how the customer accepted (method, reference, who, when). A status change alone does not prove acceptance.',
  'gate-failed': 'The launch gate is not met.',
  'not-found': 'Engagement not found.',
  'unknown-item': 'Unknown checklist item.',
  'pilot-invalid-metric': 'The primary metric must be one of the service success measures.',
  'pilot-invalid-dates': 'Check the dates: end before start, or not a date.',
  'pilot-no-period': 'Set the dates for that period before computing it.',
  'pilot-not-found': 'Define the pilot first.',
  'pilot-invalid-decision': 'Pick one of Continue, Revise, Expand, Pause or Stop.',
  'measurement-invalid': 'Enter a non-negative number.',
}

export default async function EngagementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const data = await withUser(session, async db => {
    const e = await getEngagement(db, id)
    if (!e) return null
    const [history, available, credits, applications, ready, pilot] = await Promise.all([
      listTransitions(db, id), availableTransitions(db, e), listCredits(db, e.agency_id),
      db.query<{ id: string; credit_id: string; amount_cents: number; applied_at: string; reversed_at: string | null }>('select id, credit_id, amount_cents, applied_at, reversed_at from assessment_credit_applications where engagement_ref = $1 order by applied_at', [id]),
      engagementReadiness(db, id, e.agency_id), getPilot(db, id),
    ])
    const measurements = pilot ? await listMeasurements(db, pilot.id) : []
    const ids = new Set<string>([...ready.rows.map(r => r.completed_by), pilot?.decided_by].filter((x): x is string => Boolean(x)))
    const names = ids.size ? await db.query<{ id: string; full_name: string | null; email: string }>('select id, full_name, email from profiles where id = any($1)', [Array.from(ids)]) : []
    return { e, history, available, credits, applications, readiness: ready.readiness, pilot, measurements, names: Object.fromEntries(names.map(n => [n.id, n.full_name ?? n.email])) }
  }, { ip: await requestIp() })
  if (!data) notFound()
  const { e, history, available, credits, applications, readiness, pilot, measurements, names } = data
  const svc = getService(e.service_key)
  const creditErr = sp.error?.startsWith('credit-') ? CREDIT_ERROR_TEXT[sp.error.slice(7).replace(/-/g, '_') as keyof typeof CREDIT_ERROR_TEXT] : null

  return (
    <>
      <PageHeader eyebrow={<Link href="/staff/engagements">Engagements</Link>} title={e.agency_name}
        sub={<>{svc?.name ?? e.service_key} <Badge tone="muted">{svc ? AVAILABILITY_LABEL[svc.availability] : 'unknown service'}</Badge>{e.owner_name ? ` · ${e.owner_name}` : ''}{e.baa_signed_at ? '' : ' · BAA not signed'}</>}
        actions={<><Link className="btn ghost sm" href={`/staff/agencies/${e.agency_id}`}>Agency</Link>{e.assessment_id && <Link className="btn ghost sm" href={`/staff/assessments/${e.assessment_id}`}>Assessment</Link>}<a className="btn ghost sm" href={`/staff/engagements/${e.id}/proposal.pdf`} target="_blank" rel="noopener noreferrer">Proposal PDF</a></>} />

      <div className="mb-5 flex flex-col gap-2">
        {sp.created && <Banner icon="check"><strong>Draft created.</strong> Fees, exclusions, volume and measures are prefilled from the catalog; edit them before sending the proposal.</Banner>}
        {sp.saved === '1' && <Banner icon="check"><strong>Proposal saved.</strong></Banner>}
        {sp.saved === 'contacts' && <Banner icon="check"><strong>Contacts and support saved.</strong> Commercial terms are locked after acceptance.</Banner>}
        {sp.moved && <Banner icon="check"><strong>Moved to {STATUS_LABEL[sp.moved as keyof typeof STATUS_LABEL] ?? sp.moved}.</strong></Banner>}
        {sp.credit && <Banner icon="dollar"><strong>Credit applied.</strong> ${Math.round(Number(sp.credit) / 100).toLocaleString('en-US')} now applied to this engagement through the ledger.</Banner>}
        {sp.item && <Banner icon="check"><strong>Checklist updated.</strong></Banner>}
        {sp.test === 'ok' && <Banner icon="check"><strong>Live input test delivered.</strong> Recorded as live evidence on the checklist.</Banner>}
        {sp.test === 'mocked' && <Banner tone="warn"><strong>Input test was simulated.</strong> No provider credentials, so the adapter mocked the send. Recorded as simulated; it does not satisfy the testing gate.</Banner>}
        {sp.test === 'failed' && <Banner tone="warn"><strong>Input test failed.</strong> {sp.detail ?? ''}</Banner>}
        {sp.test === 'unsupported' && <Banner tone="warn"><strong>Nothing to send.</strong> {sp.detail ?? 'This input method is verified by a real import.'}</Banner>}
        {sp.pilot === 'saved' && <Banner icon="check"><strong>Pilot saved.</strong></Banner>}
        {sp.computed && <Banner icon="check"><strong>{sp.computed === 'manual' ? 'Measurement recorded.' : `${sp.computed === 'baseline' ? 'Baseline' : 'Pilot'} measurements computed.`}</strong> Every measure carries its denominator, sample size and missing-data note.</Banner>}
        {sp.decided && <Banner icon="check"><strong>Pilot decision recorded: {sp.decided}.</strong></Banner>}
        {sp.error && <Banner tone="warn"><strong>Could not do that.</strong> {creditErr ?? ERRORS[sp.error] ?? sp.error.replace(/-/g, ' ')}{sp.unmet ? ` Unmet: ${sp.unmet}.` : ''}</Banner>}
      </div>

      <div className="flex flex-col gap-6">
        <TransitionPanel e={e} available={available} history={history} />
        <ProposalForm e={e} />
        <CreditPanel engagementId={e.id} status={e.status} credits={credits} applications={applications} appliedCents={e.credit_applied_cents} />
        <ChecklistPanel engagementId={e.id} inputMethod={e.input_method} readiness={readiness} names={names} />
        <PilotPanel engagementId={e.id} agencyId={e.agency_id} serviceKey={e.service_key} pilot={pilot} measurements={measurements} names={names} />
      </div>
    </>
  )
}
