import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { createAssessment, defaultFeeDollars } from '@/lib/assessments/actions'
import { env } from '@/lib/env'
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
  return (
    <>
      <PageHeader title="New assessment" sub="Marks the prospect assessment_sold, creates their tenant, and starts the 60-day build credit." eyebrow="Assessments" />
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not create.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}
      <form action={createAssessment} className="flex max-w-xl flex-col gap-4">
        <Field label="Prospect" htmlFor="prospect_id" hint="Agencies that already have a tenant reuse it.">
          <Select id="prospect_id" name="prospect_id" defaultValue={sp.prospect ?? prospects[0]?.id} required>
            {prospects.map(p => <option key={p.id} value={p.id}>{p.agency_name}{p.owner_name ? ` · ${p.owner_name}` : ''} · {p.stage.replace(/_/g, ' ')}{p.agency_id ? ' · tenant exists' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Assessment fee paid ($)" htmlFor="fee_dollars" hint={`Published range ${env.pricing.assessment}. Credited toward a build sold within 60 days.`}>
          <Input id="fee_dollars" name="fee_dollars" type="number" min={0} step="50" defaultValue={fee} required />
        </Field>
        <div><Button type="submit">Create and start the walkthrough</Button></div>
      </form>
    </>
  )
}
