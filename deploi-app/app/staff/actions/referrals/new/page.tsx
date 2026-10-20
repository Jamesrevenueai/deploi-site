import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { logReferral } from '../../actions'

export const metadata = { title: 'Log a referral' }
export const dynamic = 'force-dynamic'

export default async function NewReferral() {
  const session = await requireRole('staff')
  const agencies = await withUser(session, db => db.query<{ id: string; name: string }>('select id, name from agencies order by name'), { ip: await requestIp() })
  return (
    <>
      <PageHeader title="Log a referral" sub="For referrals that arrive by phone, fax or in person. The referral-response worker drafts the reply right after." />
      <form action={logReferral} className="grid max-w-2xl gap-4 md:grid-cols-2">
        <Field label="Agency" htmlFor="agency_id"><Select id="agency_id" name="agency_id">{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Channel" htmlFor="source_channel"><Select id="source_channel" name="source_channel" defaultValue="phone">{['phone', 'fax', 'portal', 'email', 'manual'].map(c => <option key={c} value={c}>{c}</option>)}</Select></Field>
        <Field label="Referrer name" htmlFor="source_name"><Input id="source_name" name="source_name" placeholder="Case manager" /></Field>
        <Field label="Referrer organization" htmlFor="source_org"><Input id="source_org" name="source_org" placeholder="County AAA" /></Field>
        <Field label="Referrer email" htmlFor="source_email" hint="Needed for the reply and follow-ups."><Input id="source_email" name="source_email" type="email" /></Field>
        <Field label="Client (initials are fine)" htmlFor="client_name"><Input id="client_name" name="client_name" /></Field>
        <Field label="County" htmlFor="county"><Input id="county" name="county" placeholder="Franklin" /></Field>
        <Field label="Service code" htmlFor="service"><Input id="service" name="service" placeholder="T1019" /></Field>
        <Field label="Hours per week" htmlFor="hours_per_week"><Input id="hours_per_week" name="hours_per_week" type="number" min={0} step={0.5} /></Field>
        <div className="md:col-span-2"><Field label="Notes" htmlFor="notes"><Textarea id="notes" name="notes" rows={3} /></Field></div>
        <div className="md:col-span-2"><Button type="submit">Save and draft reply</Button></div>
      </form>
    </>
  )
}
