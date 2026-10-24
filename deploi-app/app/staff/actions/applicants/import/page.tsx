/* eslint-disable @next/next/no-html-link-for-pages -- the CSV template links are file downloads, not pages */
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { IMPORT_SPECS, lastSuccessfulImport, type RowError } from '@/lib/imports'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Field, Select, Textarea } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { ImportFreshness } from '@/components/actions/ImportFreshness'
import { RowErrorList } from '@/components/evv/RowErrorList'
import { importApplicants } from '../../actions'

export const metadata = { title: 'Import applicants' }
export const dynamic = 'force-dynamic'

type Report = { id: string; filename: string | null; status: string; notice: string | null; row_count: number; imported: number; skipped: number; duplicates: number; row_errors: RowError[] }
type History = { id: string; filename: string | null; status: string; notice: string | null; row_count: number; imported: number; skipped: number; duplicates: number; created_at: string; error_count: number }

export default async function ImportApplicants({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const { agencies, report, history, freshness } = await withUser(session, async db => {
    const agencies = await db.query<{ id: string; name: string }>('select id, name from agencies order by name')
    const agencyId = sp.agency ?? agencies[0]?.id
    const report = sp.import ? await db.one<Report>("select id, filename, status, notice, row_count, imported, skipped, duplicates, row_errors from imports where id = $1 and kind = 'applicants'", [sp.import]) : null
    const history = agencyId ? await db.query<History>("select id, filename, status, notice, row_count, imported, skipped, duplicates, created_at, jsonb_array_length(row_errors) as error_count from imports where agency_id = $1 and kind = 'applicants' order by created_at desc limit 10", [agencyId]) : []
    const freshness = agencyId ? await lastSuccessfulImport(db, 'applicants', agencyId) : null
    return { agencies, report, history, freshness }
  }, { ip })
  const spec = IMPORT_SPECS.applicants
  return (
    <>
      <PageHeader title="Import applicants" sub="CSV with first_name, last_name, phone, email. Rows are validated one by one, duplicates (same phone, else same name) are skipped, and the screening worker proposes the 4-question text right after. SMS consent is never set by an import."
        actions={<a className="btn ghost sm" href="/api/imports/template/applicants"><Icon name="download" size={15} />CSV template</a>} />
      {sp.error === 'baa-not-signed' && <div className="mb-5"><Banner tone="warn"><strong>BAA not signed for this agency.</strong> Mark the BAA signed on the assessment page before importing client data.</Banner></div>}
      {sp.error === 'file-required' && <div className="mb-5"><Banner tone="warn"><strong>Nothing to import.</strong> Choose a CSV file or paste rows.</Banner></div>}
      {report && report.status === 'already_imported' && <div className="mb-5"><Banner tone="warn" icon="file"><strong>Already imported.</strong> {report.notice}. Nothing was added.</Banner></div>}
      {report && report.status === 'committed' && <div className="mb-5"><Banner icon="check"><strong>{report.imported} applicant{report.imported === 1 ? '' : 's'} imported</strong> of {report.row_count} rows · {report.duplicates} duplicate{report.duplicates === 1 ? '' : 's'} · {report.skipped} skipped{sp.ran ? ` · ${sp.ran} screening proposal(s) drafted` : ''}. <Link href="/staff/actions?worker=applicant_screening" className="underline text-ink">Review proposals</Link>.</Banner></div>}
      {report && report.row_errors.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg">Row errors · {report.filename ?? report.id.slice(0, 8)}</h2>
          <RowErrorList errors={report.row_errors} />
        </section>
      )}
      {freshness && <div className="mb-5"><ImportFreshness kind="applicants" info={freshness} /></div>}
      <form action={importApplicants} className="flex max-w-2xl flex-col gap-4">
        <Field label="Agency" htmlFor="agency_id"><Select id="agency_id" name="agency_id" defaultValue={sp.agency}>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="CSV file" htmlFor="file"><input id="file" name="file" type="file" accept=".csv,text/csv" className="input" /></Field>
        <Field label="…or paste CSV" htmlFor="csv"><Textarea id="csv" name="csv" rows={6} placeholder={'first_name,last_name,phone,email\nAvery,Okafor,+16145550199,avery@example.com'} /></Field>
        <div><Button type="submit">Import and screen</Button></div>
      </form>

      <section className="mt-10">
        <h2 className="mb-2 text-lg">Fields</h2>
        <div className="table-wrap">
          <table className="dg-table">
            <thead><tr><th>Field</th><th>Required</th><th>Type</th><th>Meaning</th></tr></thead>
            <tbody>{spec.fields.map(f => <tr key={f.key}><td className="ink">{f.key}</td><td>{f.required ? <Badge tone="warn">required</Badge> : 'optional'}</td><td>{f.type}</td><td className="max-w-[50ch]">{f.doc}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      {history.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg">Recent imports</h2>
          <ul className="flex flex-col gap-2">
            {history.map(h => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-4 py-3 text-[14px]">
                <span className="text-ink">{h.filename ?? h.id.slice(0, 8)}{h.status === 'already_imported' && <Badge tone="warn">already imported</Badge>}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {h.status === 'committed' ? <span>{h.imported} imported, {h.duplicates} duplicates, {h.skipped} skipped of {h.row_count}</span> : <span>{h.notice ?? h.status}</span>}
                  {h.error_count > 0 && <Link href={`/staff/actions/applicants/import?agency=${sp.agency ?? ''}&import=${h.id}`} className="underline text-ink">{h.error_count} row error{h.error_count === 1 ? '' : 's'}</Link>}
                  <span className="text-grey-h">{new Date(h.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
