import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { SERVICES, AVAILABILITY_LABEL } from '@/lib/catalog/services'
import { getPricing, range } from '@/lib/catalog/pricing'
import { proposalDefaults, INPUT_METHOD_LABEL } from '@/lib/engagements/defaults'
import { PageHeader } from '@/components/ui/PageHeader'
import { Field, Select } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { createDraft } from '../actions'

export const metadata = { title: 'New engagement' }
export const dynamic = 'force-dynamic'

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')
const ERRORS: Record<string, string> = {
  'agency-required': 'Pick an agency. A prospect without a tenant needs an assessment first.',
  'standalone-service': 'Website Improvement is standalone and is tracked on the pipeline, not as an engagement.',
  'unknown-service': 'Unknown service.',
  'could-not-create': 'The draft could not be created.',
}

export default async function NewEngagement({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const services = SERVICES.filter(s => !s.standalone)
  const serviceKey = services.some(s => s.key === sp.service) ? sp.service! : services[0].key
  const svc = services.find(s => s.key === serviceKey)!
  const data = await withUser(session, async db => {
    const agencies = await db.query<{ id: string; name: string; timezone: string; prospect_id: string | null; baa_signed_at: string | null }>('select id, name, timezone, prospect_id, baa_signed_at from agencies order by name')
    const prospect = sp.prospect ? await db.one<{ id: string; agency_id: string | null; agency_name: string }>('select id, agency_id, agency_name from prospects where id = $1', [sp.prospect]) : null
    const assessment = sp.assessment ? await db.one<{ id: string; agency_id: string; prospect_id: string | null }>('select id, agency_id, prospect_id from assessments where id = $1', [sp.assessment]) : null
    return { agencies, prospect, assessment }
  }, { ip: await requestIp() })
  const agencyId = sp.agency ?? data.assessment?.agency_id ?? data.prospect?.agency_id ?? data.agencies[0]?.id ?? ''
  const agency = data.agencies.find(a => a.id === agencyId)
  const prospectId = sp.prospect ?? data.assessment?.prospect_id ?? agency?.prospect_id ?? ''
  const d = proposalDefaults(serviceKey, agency?.timezone)
  const p = getPricing()

  return (
    <>
      <PageHeader eyebrow={<Link href="/staff/engagements">Engagements</Link>} title="New engagement" sub="Creates a draft proposal prefilled from the service catalog. Fees start at the bottom of the published ranges and are a draft until scope is set." />
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not create.</strong> {ERRORS[sp.error] ?? sp.error.replace(/-/g, ' ')}</Banner></div>}
      {data.agencies.length === 0 && <div className="mb-4"><Banner tone="warn"><strong>No agencies yet.</strong> Sell an assessment first; it creates the tenant.</Banner></div>}

      <form method="get" className="mb-6 grid gap-3 rounded-[20px] border border-line p-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
        {prospectId && <input type="hidden" name="prospect" value={prospectId} />}
        {sp.assessment && <input type="hidden" name="assessment" value={sp.assessment} />}
        <Field label="Agency" htmlFor="agency">
          <Select id="agency" name="agency" defaultValue={agencyId}>
            {data.agencies.map(a => <option key={a.id} value={a.id}>{a.name}{a.baa_signed_at ? '' : ' · BAA not signed'}</option>)}
          </Select>
        </Field>
        <Field label="Service" htmlFor="service" hint="Non-standalone services only.">
          <Select id="service" name="service" defaultValue={serviceKey}>
            {services.map(s => <option key={s.key} value={s.key}>{s.name} · {AVAILABILITY_LABEL[s.availability]}</option>)}
          </Select>
        </Field>
        <Button variant="ghost" size="sm" type="submit">Preview defaults</Button>
      </form>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-[20px] border border-line p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2"><h2 className="text-lg">{svc.name}</h2><Badge tone="muted">{AVAILABILITY_LABEL[svc.availability]}</Badge></div>
          <p className="text-[15px]">{svc.description}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[14px]">
            <dt className="text-grey-h">Setup fee (draft)</dt><dd className="text-ink">{money(d.setup_fee_cents)} <span className="text-grey-h">range {range(p.build)}</span></dd>
            <dt className="text-grey-h">Monthly (draft)</dt><dd className="text-ink">{money(d.monthly_fee_cents)} <span className="text-grey-h">range {range(p.management)}</span></dd>
            <dt className="text-grey-h">Included volume</dt><dd className="text-ink">{d.included_volume ?? '—'} {d.volume_units ?? ''}</dd>
            <dt className="text-grey-h">Input</dt><dd className="text-ink">{svc.inputMethods.map(m => INPUT_METHOD_LABEL[m] ?? m).join(', ')}</dd>
            <dt className="text-grey-h">Fix period</dt><dd className="text-ink">{d.fix_period_days} days</dd>
            <dt className="text-grey-h">Initial term</dt><dd className="text-ink">{d.initial_term_months} months</dd>
          </dl>
        </div>
        <div className="rounded-[20px] border border-line p-5 flex flex-col gap-3 text-[14px]">
          <h3 className="text-base">Exclusions (prefilled)</h3>
          <ul className="list-disc pl-5">{svc.exclusions.map(x => <li key={x}>{x}</li>)}</ul>
          <h3 className="text-base mt-2">Success measures</h3>
          <ul className="list-disc pl-5">{svc.successMeasures.map(m => <li key={m.key}><span className="text-ink">{m.label}.</span> {m.definition}</li>)}</ul>
        </div>
      </section>

      <form action={createDraft} className="mt-6 flex flex-col gap-3 rounded-[20px] border border-line p-5">
        <input type="hidden" name="agency_id" value={agencyId} />
        <input type="hidden" name="service_key" value={serviceKey} />
        <input type="hidden" name="prospect_id" value={prospectId} />
        <input type="hidden" name="assessment_id" value={sp.assessment ?? ''} />
        <p className="text-[15px]">Draft for <span className="text-ink">{agency?.name ?? '—'}</span> · <span className="text-ink">{svc.name}</span>{sp.assessment ? ' · linked to the assessment' : ''}. Every field stays editable until the proposal is accepted.</p>
        <div><Button type="submit" disabled={!agencyId}>Create draft</Button></div>
      </form>
    </>
  )
}
