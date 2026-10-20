import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { FIELDS, FIELD_LABELS, REQUIRED, type Mapping } from '@/lib/evv/mappers'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { stageImport, commitImport, discardImport } from './actions'

export const metadata = { title: 'Import EVV visits' }
export const dynamic = 'force-dynamic'

type Staged = { id: string; agency_id: string; source: string; filename: string | null; headers: string[]; mapping: Mapping; raw: Record<string, string>[]; row_count: number }
type History = { id: string; source: string; filename: string | null; status: string; row_count: number; imported: number; updated: number; exceptions_opened: number; created_at: string }

export default async function ImportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const { agencies, staged, history } = await withUser(session, async db => {
    const agencies = await db.query<{ id: string; name: string }>('select id, name from agencies order by name')
    const staged = sp.id ? await db.one<Staged>(`select id, agency_id, source, filename, headers, mapping, (select jsonb_agg(x) from (select x from jsonb_array_elements(raw) x limit 5) s) as raw, row_count from evv_imports where id = $1 and status = 'staged'`, [sp.id]) : null
    const agencyId = sp.agency ?? agencies[0]?.id
    const history = agencyId ? await db.query<History>(`select id, source, filename, status, row_count, imported, updated, exceptions_opened, created_at from evv_imports where agency_id = $1 and status <> 'staged' order by created_at desc limit 10`, [agencyId]) : []
    return { agencies, staged, history }
  })
  const agencyId = staged?.agency_id ?? sp.agency ?? agencies.find(a => a.name.startsWith('Buckeye'))?.id ?? agencies[0]?.id
  const err = sp.error

  return (
    <>
      <PageHeader eyebrow={<Link href={`/staff/evv?agency=${agencyId}`} className="inline-flex items-center gap-1"><Icon name="arrow-right" size={14} className="rotate-180" />EVV exceptions</Link>} title="Import visits" sub="Upload a Sandata visit export or any vendor's CSV. We match clients and aides by name, write the visits, and open exceptions." />

      {sp.done && <div className="mb-5"><Banner icon="check"><strong>Import complete.</strong> {sp.done} <Link href={`/staff/evv?agency=${agencyId}`} className="underline text-ink">See exceptions</Link>.</Banner></div>}
      {err && <div className="mb-5"><Banner tone="warn"><strong>Could not import.</strong> {err.startsWith('map-') ? `Map the required columns: ${err.slice(4).replace(/-/g, ', ')}.` : err.replace(/-/g, ' ')}</Banner></div>}

      {!staged ? (
        <form action={stageImport} className="flex max-w-xl flex-col gap-4" encType="multipart/form-data">
          <Field label="Agency" htmlFor="agency">
            <Select id="agency" name="agency" defaultValue={agencyId}>{agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
          </Field>
          <Field label="Vendor" htmlFor="source" hint="Sandata uses the preset column names. Any other vendor goes through the generic mapper; you confirm the columns on the next step.">
            <Select id="source" name="source" defaultValue="sandata">
              <option value="sandata">Sandata visit export</option>
              <option value="generic">Other vendor (AlayaCare, HHAeXchange, WellSky, …)</option>
            </Select>
          </Field>
          <Field label="CSV file" htmlFor="file" hint="One row per visit. Up to 8 MB.">
            <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
          </Field>
          <div><Button type="submit"><Icon name="upload" size={16} />Upload and review</Button></div>
        </form>
      ) : (
        <form action={commitImport} className="flex flex-col gap-6">
          <input type="hidden" name="id" value={staged.id} />
          <Banner icon="file"><strong>{staged.filename ?? 'upload'}</strong> · {staged.row_count.toLocaleString()} rows · {staged.source === 'sandata' ? 'Sandata preset' : 'generic mapper'}. Confirm which column feeds each field, then import.</Banner>
          <div className="grid gap-4 md:grid-cols-2">
            {FIELDS.map(f => (
              <Field key={f} label={`${FIELD_LABELS[f]}${REQUIRED.includes(f) ? ' *' : ''}`} htmlFor={`map_${f}`}>
                <Select id={`map_${f}`} name={`map_${f}`} defaultValue={staged.mapping[f] ?? ''}>
                  <option value="">— not in this file —</option>
                  {staged.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <div>
            <h2 className="mb-2 text-lg">First rows</h2>
            <div className="table-wrap">
              <table className="dg-table">
                <thead><tr>{staged.headers.slice(0, 8).map(h => <th key={h}>{h}</th>)}{staged.headers.length > 8 && <th>…</th>}</tr></thead>
                <tbody>{(staged.raw ?? []).map((r, i) => <tr key={i}>{staged.headers.slice(0, 8).map(h => <td key={h}>{r[h]}</td>)}{staged.headers.length > 8 && <td>…</td>}</tr>)}</tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit"><Icon name="check" size={16} />Import {staged.row_count.toLocaleString()} rows</Button>
            <Button type="submit" variant="ghost" formAction={discardImport} formNoValidate>Discard</Button>
            <input type="hidden" name="agency" value={staged.agency_id} />
          </div>
        </form>
      )}

      {history.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-lg">Recent imports</h2>
          <ul className="flex flex-col gap-2">
            {history.map(h => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-4 py-3 text-[14px]">
                <span className="text-ink">{h.filename ?? h.id.slice(0, 8)} <span className="text-grey-h">· {h.source}</span></span>
                <span>{h.status === 'committed' ? `${h.imported} imported, ${h.updated} updated, ${h.exceptions_opened} exceptions` : h.status} · {new Date(h.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
