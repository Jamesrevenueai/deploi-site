'use client'
import { useActionState } from 'react'
import { importStep, type ImportState } from '@/lib/sales/actions'
import { IMPORT_FIELDS } from '@/lib/sales/csv'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { Banner } from '@/components/ui/Banner'

const LABEL: Record<string, string> = { agency_name: 'Agency name (required)', owner_name: 'Owner / contact', email: 'Email', phone: 'Phone', city: 'City', county: 'County', state: 'State', programs: 'Programs', source: 'Source', owner_notes: 'Notes' }

export function ImportWizard() {
  const [state, action, pending] = useActionState<ImportState, FormData>(importStep, { step: 'upload' })

  if (state.step === 'done') {
    return (
      <div className="flex flex-col gap-4">
        <div className="metal tile"><div className="relative"><div className="tile-value">{state.imported} imported / {state.skipped} skipped</div>
          <div className="tile-sub mt-2">{state.rejected > 0 ? `${state.rejected} rows had no agency name. ` : ''}Duplicates on email + agency were skipped.</div></div></div>
        <div className="flex gap-2"><Button href="/staff/pipeline?view=list">Open the list</Button><Button variant="ghost" href="/staff/pipeline/import">Import another</Button></div>
      </div>
    )
  }

  if (state.step === 'map') {
    return (
      <form action={action} className="flex flex-col gap-5" aria-busy={pending}>
        <input type="hidden" name="step" value="import" />
        <input type="hidden" name="csvText" value={state.csvText} />
        {state.error && <Banner tone="warn">{state.error}</Banner>}
        <p className="text-grey">{state.total} rows · {state.headers.length} columns. Match each field to a column; unmapped fields stay empty.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {IMPORT_FIELDS.map(f => (
            <Field key={f} label={LABEL[f]} htmlFor={`map_${f}`}>
              <Select id={`map_${f}`} name={`map_${f}`} defaultValue={state.mapping[f] ?? ''} required={f === 'agency_name'}>
                <option value="">— not in file —</option>
                {state.headers.map(h => <option key={h} value={h}>{h}</option>)}
              </Select>
            </Field>
          ))}
          <Field label="Default source" htmlFor="source" hint="Used when the file has no source column">
            <Input id="source" name="source" defaultValue="csv" />
          </Field>
        </div>
        <div className="table-wrap">
          <table className="dg-table"><thead><tr>{state.headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{state.sample.map((r, i) => <tr key={i}>{state.headers.map(h => <td key={h}>{r[h]}</td>)}</tr>)}</tbody></table>
        </div>
        <div className="flex gap-2"><Button type="submit" disabled={pending}>{pending ? 'Importing…' : `Import ${state.total} rows`}</Button><Button variant="ghost" href="/staff/pipeline/import">Start over</Button></div>
      </form>
    )
  }

  return (
    <form action={action} className="flex max-w-lg flex-col gap-4" aria-busy={pending}>
      <input type="hidden" name="step" value="upload" />
      {state.error && <Banner tone="warn">{state.error}</Banner>}
      <Field label="CSV file" htmlFor="file" hint="Headers in the first row. Up to 5 MB. Columns are mapped on the next step.">
        <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? 'Reading…' : 'Continue'}</Button></div>
    </form>
  )
}
