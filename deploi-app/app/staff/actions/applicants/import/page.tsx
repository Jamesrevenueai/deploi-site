import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Field, Select, Textarea } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { importApplicants } from '../../actions'

export const metadata = { title: 'Import applicants' }
export const dynamic = 'force-dynamic'

export default async function ImportApplicants({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const agencies = await withUser(session, db => db.query<{ id: string; name: string }>('select id, name from agencies order by name'), { ip: await requestIp() })
  return (
    <>
      <PageHeader title="Import applicants" sub="CSV with first_name, last_name, phone, email. Duplicates by phone are skipped. The screening worker proposes the 4-question text right after." />
      {sp.error === 'baa-not-signed' && <div className="mb-5"><Banner tone="warn"><strong>BAA not signed for this agency.</strong> Mark the BAA signed on the assessment page before importing client data.</Banner></div>}
      <form action={importApplicants} className="flex max-w-2xl flex-col gap-4">
        <Field label="Agency" htmlFor="agency_id"><Select id="agency_id" name="agency_id">{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="CSV file" htmlFor="file"><input id="file" name="file" type="file" accept=".csv,text/csv" className="input" /></Field>
        <Field label="…or paste CSV" htmlFor="csv"><Textarea id="csv" name="csv" rows={6} placeholder={'first_name,last_name,phone,email\nAvery,Okafor,+16145550199,avery@example.com'} /></Field>
        <div><Button type="submit">Import and screen</Button></div>
      </form>
    </>
  )
}
