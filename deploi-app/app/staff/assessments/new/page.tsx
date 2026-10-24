import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { createAssessment, defaultFeeDollars } from '@/lib/assessments/actions'
import { getPricing, range } from '@/lib/catalog/pricing'
import { SERVICES } from '@/lib/catalog/services'
import { PageHeader } from '@/components/ui/PageHeader'
import { Field, Input, Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'

export const metadata = { title: 'New assessment' }
export const dynamic = 'force-dynamic'

export default async function NewAssessment({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const prospects = await withUser(session, db => db.query<{ id: string; agency_name: string; owner_name: string | null; stage: string; agency_id: string | null }>(
    "select id, agency_name, owner_name, stage, agency_id from prospects where stage <> 'lost' order by case when stage in ('call_held','call_booked') then 0 else 1 end, agency_name"), { ip })
  const fee = await defaultFeeDollars()
  const pricing = getPricing()
  const eligible = SERVICES.filter(s => !s.standalone)
  return (
    <>
      <PageHeader title="New assessment" sub={`Marks the prospect assessment_sold, creates their tenant, and issues the ${pricing.assessment.creditTermDays}-day build credit on the ledger (unpaid until a payment is recorded).`} eyebrow="Assessments" />
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not create.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}
      <form action={createAssessment} className="flex max-w-xl flex-col gap-4">
        <Field label="Prospect" htmlFor="prospect_id" hint="Agencies that already have a tenant reuse it.">
          <Select id="prospect_id" name="prospect_id" defaultValue={sp.prospect ?? prospects[0]?.id} required>
            {prospects.map(p => <option key={p.id} value={p.id}>{p.agency_name}{p.owner_name ? ` · ${p.owner_name}` : ''} · {p.stage.replace(/_/g, ' ')}{p.agency_id ? ' · tenant exists' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Assessment fee ($)" htmlFor="fee_dollars" hint={`Published range ${range(pricing.assessment)}; exact scope determines the final quote.`}>
          <Input id="fee_dollars" name="fee_dollars" type="number" min={0} step="50" defaultValue={fee} required />
        </Field>
        <Field label="Credit amount ($)" htmlFor="credit_dollars" hint="Defaults to the fee. Never above the fee.">
          <Input id="credit_dollars" name="credit_dollars" type="number" min={0} step="50" placeholder={String(fee)} />
        </Field>
        <Field label="Eligible build" htmlFor="eligible_service_key" hint="Optional. Limits the credit to one service. Website Improvement is a standalone service and is never credited.">
          <Select id="eligible_service_key" name="eligible_service_key" defaultValue="">
            <option value="">Any qualifying build</option>
            {eligible.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </Select>
        </Field>
        <p className="text-[13px] text-grey-h">Credit term: {pricing.assessment.creditTermDays} days from issue (ASSESSMENT_CREDIT_TERM_DAYS). The credit becomes usable only after a real payment is recorded on the assessment page; a mock payment is labelled simulated and never applies.</p>
        <div><Button type="submit">Create and start the walkthrough</Button></div>
      </form>
    </>
  )
}
