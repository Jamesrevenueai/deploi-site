import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import type { RuleSet } from '@/lib/evv/window'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { saveRuleSet, deleteRuleSet } from './actions'

export const metadata = { title: 'EVV rule sets' }
export const dynamic = 'force-dynamic'

type Row = RuleSet & { agency_name: string | null; updated_at: string }

export default async function RulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const { rules, agencies } = await withUser(session, async db => ({
    rules: await db.query<Row>(
      `select r.id, r.agency_id, g.name as agency_name, r.program, r.payer, r.jurisdiction, r.effective_from::text, r.effective_to::text, r.correction_window_days, r.unit_minutes, r.unit_rounding,
              r.duration_tolerance_min, r.source_name, r.source_url, r.source_version, r.verified, r.notes, r.updated_at
       from evv_rule_sets r left join agencies g on g.id = r.agency_id order by r.jurisdiction, g.name nulls first, r.program nulls first, r.effective_from nulls first`),
    agencies: await db.query<{ id: string; name: string; state: string }>('select id, name, state from agencies order by name'),
  }), { ip: await requestIp() })
  const editing = sp.edit ? rules.find(r => r.id === sp.edit) ?? null : null
  const adding = sp.new === '1' || Boolean(editing)

  return (
    <>
      <PageHeader eyebrow={<Link href="/staff/evv" className="inline-flex items-center gap-1"><Icon name="arrow-right" size={14} className="rotate-180" />EVV exceptions</Link>} title="EVV rule sets"
        sub="Correction windows, unit length, rounding and duration tolerance per state, program, payer and agency, each with its source and version. A deadline is shown only where one of these rows matches; there is no default."
        actions={!adding && <Button size="sm" href="/staff/evv/rules?new=1"><Icon name="plus" size={15} />Add rule set</Button>} />

      {sp.saved && <div className="mb-5"><Banner icon="check"><strong>Saved.</strong> Exceptions imported from now on use this rule; existing deadlines are not rewritten.</Banner></div>}
      {sp.deleted && <div className="mb-5"><Banner icon="check"><strong>Deleted.</strong></Banner></div>}
      {sp.error && <div className="mb-5"><Banner tone="warn"><strong>Not saved.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}
      <div className="mb-5"><Banner tone="warn"><strong>Unverified rows are working assumptions.</strong> Tick &ldquo;verified&rdquo; only after confirming the figure with the program or payer and recording where it came from. Everything downstream is advisory; review with your biller before holding or billing any visit.</Banner></div>

      {adding && (
        <form action={saveRuleSet} className="mb-8 grid gap-4 rounded-[20px] border border-line p-5 md:grid-cols-3">
          <input type="hidden" name="id" value={editing?.id ?? ''} />
          <Field label="Scope: agency" htmlFor="agency_id" hint="Blank = global for the state.">
            <Select id="agency_id" name="agency_id" defaultValue={editing?.agency_id ?? ''}><option value="">All agencies (global)</option>{agencies.map(a => <option key={a.id} value={a.id}>{a.name} · {a.state}</option>)}</Select>
          </Field>
          <Field label="State (jurisdiction)" htmlFor="jurisdiction"><Input id="jurisdiction" name="jurisdiction" defaultValue={editing?.jurisdiction ?? 'OH'} maxLength={2} required /></Field>
          <Field label="Program" htmlFor="program" hint="PASSPORT, OHCW, MyCare, DODD … Blank = any program."><Input id="program" name="program" defaultValue={editing?.program ?? ''} /></Field>
          <Field label="Payer" htmlFor="payer" hint="Blank = any payer."><Input id="payer" name="payer" defaultValue={editing?.payer ?? ''} /></Field>
          <Field label="Effective from" htmlFor="effective_from"><Input id="effective_from" name="effective_from" type="date" defaultValue={editing?.effective_from ?? ''} /></Field>
          <Field label="Effective to" htmlFor="effective_to" hint="Blank = open-ended."><Input id="effective_to" name="effective_to" type="date" defaultValue={editing?.effective_to ?? ''} /></Field>
          <Field label="Correction window (days)" htmlFor="correction_window_days" hint="Leave blank if unknown: the UI then says 'deadline not configured' instead of guessing."><Input id="correction_window_days" name="correction_window_days" type="number" min={0} defaultValue={editing?.correction_window_days ?? ''} /></Field>
          <Field label="Unit length (minutes)" htmlFor="unit_minutes"><Input id="unit_minutes" name="unit_minutes" type="number" min={1} defaultValue={editing?.unit_minutes ?? 15} required /></Field>
          <Field label="Unit rounding" htmlFor="unit_rounding"><Select id="unit_rounding" name="unit_rounding" defaultValue={editing?.unit_rounding ?? 'nearest'}><option value="nearest">nearest</option><option value="down">down</option><option value="up">up</option></Select></Field>
          <Field label="Duration tolerance (minutes)" htmlFor="duration_tolerance_min"><Input id="duration_tolerance_min" name="duration_tolerance_min" type="number" min={0} defaultValue={editing?.duration_tolerance_min ?? 15} required /></Field>
          <Field label="Source name" htmlFor="source_name" hint="Who says so: ODM rule, payer manual, 'Working assumption, confirm with ODM' …"><Input id="source_name" name="source_name" defaultValue={editing?.source_name ?? ''} /></Field>
          <Field label="Source version / date" htmlFor="source_version"><Input id="source_version" name="source_version" defaultValue={editing?.source_version ?? ''} placeholder="2026-01" /></Field>
          <div className="md:col-span-2"><Field label="Source URL" htmlFor="source_url"><Input id="source_url" name="source_url" type="url" defaultValue={editing?.source_url ?? ''} /></Field></div>
          <label className="flex items-center gap-3 self-end rounded-2xl border border-line p-3 cursor-pointer"><input type="checkbox" name="verified" defaultChecked={editing?.verified ?? false} className="h-6 w-6 accent-white" /><span className="text-ink">Verified with the source</span></label>
          <div className="md:col-span-3"><Field label="Notes" htmlFor="notes"><Textarea id="notes" name="notes" rows={2} defaultValue={editing?.notes ?? ''} /></Field></div>
          <div className="flex flex-wrap gap-2 md:col-span-3">
            <Button type="submit"><Icon name="check" size={16} />{editing ? 'Save changes' : 'Add rule set'}</Button>
            <Button variant="ghost" href="/staff/evv/rules">Cancel</Button>
          </div>
        </form>
      )}

      {rules.length === 0 ? (
        <Empty title="No rule sets">Every exception shows &ldquo;deadline not configured&rdquo; until a rule set is added. Nothing is assumed.</Empty>
      ) : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Scope</th><th>State</th><th>Program</th><th>Payer</th><th>Effective</th><th>Window</th><th>Units</th><th>Tolerance</th><th>Source</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id}>
                    <td className="ink">{r.agency_name ?? 'Global'}</td><td>{r.jurisdiction}</td><td>{r.program ?? 'any'}</td><td>{r.payer ?? 'any'}</td>
                    <td className="whitespace-nowrap">{r.effective_from ?? '…'} → {r.effective_to ?? 'open'}</td>
                    <td>{r.correction_window_days == null ? <Badge tone="muted">not set</Badge> : `${r.correction_window_days} d`}</td>
                    <td className="whitespace-nowrap">{r.unit_minutes} min · {r.unit_rounding}</td><td>±{r.duration_tolerance_min} min</td>
                    <td className="max-w-[28ch]">{r.source_name ?? '—'}{r.source_version ? ` · v${r.source_version}` : ''}{r.source_url && <> · <a className="underline" href={r.source_url} target="_blank" rel="noopener noreferrer">link</a></>}</td>
                    <td>{r.verified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">unverified</Badge>}</td>
                    <td className="whitespace-nowrap"><span className="flex gap-2"><Link className="btn ghost xs" href={`/staff/evv/rules?edit=${r.id}`}><Icon name="edit" size={13} />Edit</Link><form action={deleteRuleSet}><input type="hidden" name="id" value={r.id} /><button className="btn ghost xs" type="submit"><Icon name="x" size={13} />Delete</button></form></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-3 md:hidden">
            {rules.map(r => (
              <li key={r.id} className="rounded-2xl border border-line p-4 text-[14px]">
                <div className="flex items-center justify-between gap-2"><span className="text-ink font-medium">{r.agency_name ?? 'Global'} · {r.jurisdiction} · {r.program ?? 'any program'}</span>{r.verified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">unverified</Badge>}</div>
                <div className="mt-1">{r.correction_window_days == null ? 'window not set' : `${r.correction_window_days}-day window`} · {r.unit_minutes}-min units, {r.unit_rounding} · ±{r.duration_tolerance_min} min</div>
                <div className="mt-1 text-[13px] text-grey-h">{r.effective_from ?? '…'} → {r.effective_to ?? 'open'} · {r.source_name ?? 'no source'}{r.source_version ? ` v${r.source_version}` : ''}</div>
                <div className="mt-3 flex gap-2"><Link className="btn ghost sm" href={`/staff/evv/rules?edit=${r.id}`}><Icon name="edit" size={14} />Edit</Link><form action={deleteRuleSet}><input type="hidden" name="id" value={r.id} /><button className="btn ghost sm" type="submit"><Icon name="x" size={14} />Delete</button></form></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
