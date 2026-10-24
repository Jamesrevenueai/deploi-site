import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { loadEntries } from '@/lib/economics/queries'
import { LABOR_KINDS, COST_KINDS, REVENUE_KINDS, REVENUE_STATUSES, REF_TYPES, dollars } from '@/lib/economics/calc'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { logLabor, logCost, logRevenue } from '../actions'

export const metadata = { title: 'Log economics' }
export const dynamic = 'force-dynamic'

const label = (s: string) => s.replace(/_/g, ' ')

export default async function LogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const { agencies, entries } = await withUser(session, async db => ({
    agencies: await db.query<{ id: string; name: string }>('select id, name from agencies order by name'),
    entries: await loadEntries(db),
  }), { ip: await requestIp() })
  const agencyName = (id: string | null | undefined) => agencies.find(a => a.id === id)?.name ?? 'unassigned'
  const today = new Date().toISOString().slice(0, 10)

  const AgencySelect = ({ id, required }: { id: string; required?: boolean }) => (
    <Field label={required ? 'Agency' : 'Agency (optional)'} htmlFor={id}>
      <Select id={id} name="agency_id" defaultValue={required ? agencies[0]?.id : ''} required={required}>
        {!required && <option value="">General / unassigned</option>}
        {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
    </Field>
  )
  const RefFields = ({ prefix, def }: { prefix: string; def: string }) => (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Reference type" htmlFor={`${prefix}_ref_type`}><Select id={`${prefix}_ref_type`} name="ref_type" defaultValue={def}>{REF_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Select></Field>
      <Field label="Reference id" htmlFor={`${prefix}_ref_id`} hint="engagement / assessment / website id"><Input id={`${prefix}_ref_id`} name="ref_id" placeholder="optional" /></Field>
    </div>
  )

  return (
    <>
      <PageHeader title="Log labor, costs and revenue" eyebrow="Internal · staff only" sub="Manual entries only. Mock payments are recorded for demos and are never counted as collected."
        actions={<Button variant="ghost" size="sm" href="/staff/economics">Back to economics</Button>} />
      {sp.saved && <div className="mb-4"><Banner icon="check"><strong>Saved {sp.saved} entry.</strong></Banner></div>}
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not save.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}

      <div className="grid gap-6 lg:grid-cols-3">
        <form action={logLabor} className="flex flex-col gap-3 rounded-[20px] border border-line p-5">
          <h2 className="text-lg">Labor</h2>
          <Field label="Kind" htmlFor="labor_kind"><Select id="labor_kind" name="kind" defaultValue="review">{LABOR_KINDS.map(k => <option key={k} value={k}>{k}</option>)}</Select></Field>
          <Field label="Hours" htmlFor="labor_hours"><Input id="labor_hours" name="hours" type="number" min="0.25" max="999" step="0.25" required inputMode="decimal" /></Field>
          <AgencySelect id="labor_agency" />
          <RefFields prefix="labor" def="agency" />
          <Field label="Date" htmlFor="labor_on"><Input id="labor_on" name="logged_on" type="date" defaultValue={today} /></Field>
          <Field label="Note" htmlFor="labor_note" hint="No names or client details."><Textarea id="labor_note" name="note" rows={2} /></Field>
          <div><button type="submit" className="btn ghost sm">Log labor</button></div>
        </form>

        <form action={logCost} className="flex flex-col gap-3 rounded-[20px] border border-line p-5">
          <h2 className="text-lg">Cost</h2>
          <Field label="Kind" htmlFor="cost_kind" hint="Credits and refunds are stored as negative amounts."><Select id="cost_kind" name="kind" defaultValue="hosting">{COST_KINDS.map(k => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
          <Field label="Amount ($)" htmlFor="cost_amount"><Input id="cost_amount" name="amount" type="number" step="0.01" required inputMode="decimal" /></Field>
          <AgencySelect id="cost_agency" />
          <RefFields prefix="cost" def="agency" />
          <Field label="Date" htmlFor="cost_on"><Input id="cost_on" name="incurred_on" type="date" defaultValue={today} /></Field>
          <Field label="Note" htmlFor="cost_note"><Textarea id="cost_note" name="note" rows={2} /></Field>
          <div><button type="submit" className="btn ghost sm">Log cost</button></div>
        </form>

        <form action={logRevenue} className="flex flex-col gap-3 rounded-[20px] border border-line p-5">
          <h2 className="text-lg">Revenue</h2>
          <Field label="Kind" htmlFor="rev_kind"><Select id="rev_kind" name="kind" defaultValue="monthly_fee">{REVENUE_KINDS.map(k => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
          <Field label="Amount ($)" htmlFor="rev_amount"><Input id="rev_amount" name="amount" type="number" min="0.01" step="0.01" required inputMode="decimal" /></Field>
          <Field label="Status" htmlFor="rev_status" hint="Projected and invoiced are shown separately from collected."><Select id="rev_status" name="status" defaultValue="projected">{REVENUE_STATUSES.filter(s => s !== 'mock').map(s => <option key={s} value={s}>{s}</option>)}</Select></Field>
          <label className="flex items-center gap-2 text-[14px] text-grey"><input type="checkbox" name="is_mock" /> Mock payment (demo only; never counted as collected)</label>
          <AgencySelect id="rev_agency" required />
          <RefFields prefix="rev" def="agency" />
          <Field label="Collected on" htmlFor="rev_on" hint="Used when status is collected."><Input id="rev_on" name="collected_on" type="date" defaultValue={today} /></Field>
          <Field label="Note" htmlFor="rev_note"><Textarea id="rev_note" name="note" rows={2} /></Field>
          <div><Button type="submit" size="sm">Log revenue</Button></div>
        </form>
      </div>

      <section className="mt-8 grid gap-6 lg:grid-cols-3">
        <div>
          <h2 className="mb-2 text-base">Recent labor</h2>
          {entries.labor.length === 0 ? <p className="text-grey text-[14px]">None yet.</p> : <ul className="flex flex-col gap-2 text-[14px]">{entries.labor.slice(0, 15).map(l => <li key={l.id} className="rounded-2xl border border-line p-3"><span className="text-ink">{l.hours} h {l.kind}</span> · {agencyName(l.agency_id)} · {l.logged_on}{l.note ? <div className="text-grey">{l.note}</div> : null}</li>)}</ul>}
        </div>
        <div>
          <h2 className="mb-2 text-base">Recent costs</h2>
          {entries.costs.length === 0 ? <p className="text-grey text-[14px]">None yet.</p> : <ul className="flex flex-col gap-2 text-[14px]">{entries.costs.slice(0, 15).map(c => <li key={c.id} className="rounded-2xl border border-line p-3"><span className="text-ink">{dollars(c.amount_cents)}</span> {label(c.kind)} · {agencyName(c.agency_id)} · {c.incurred_on}{c.note ? <div className="text-grey">{c.note}</div> : null}</li>)}</ul>}
        </div>
        <div>
          <h2 className="mb-2 text-base">Recent revenue</h2>
          {entries.revenue.length === 0 ? <p className="text-grey text-[14px]">None yet.</p> : <ul className="flex flex-col gap-2 text-[14px]">{entries.revenue.slice(0, 15).map(r => <li key={r.id} className="rounded-2xl border border-line p-3"><span className="text-ink">{dollars(r.amount_cents)}</span> {label(r.kind)} · {agencyName(r.agency_id)} <Badge tone={r.is_mock || r.status === 'mock' ? 'muted' : r.status === 'collected' ? 'ok' : 'none'}>{r.is_mock || r.status === 'mock' ? 'mock · excluded' : r.status}</Badge>{r.note ? <div className="text-grey">{r.note}</div> : null}</li>)}</ul>}
        </div>
      </section>
    </>
  )
}
