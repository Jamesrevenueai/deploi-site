'use client'
/**
 * Agent packs: the business-type picker (also on the setup page), the list of packs the business type turned
 * on, and each pack's page: its agents and what each did, its settings, and its records.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { Empty } from '@/components/ui/Empty'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'

type Overview = {
  businessType: string | null; trade: string; config: Record<string, unknown>
  businessTypes: { key: string; label: string; hint: string }[]; trades: string[]
  packs: { key: string; name: string; agents: number; done30d: number; attention: number }[]
}
type Agent = { key: string; name: string; job: string; triggers: string[]; status: 'working' | 'synthetic_only' | 'planned'; done: number; attention: number; lastActive: string | null }
type Activity = { id: string; agent_key: string; status: string; title: string; what_happened: string; what_i_did: string[]; proof: { label: string; value: string }[]; error: string | null; updated_at: string }
type View = {
  pack: { key: string; name: string; on: boolean }; config: Record<string, unknown>; trade: string
  agents: Agent[]; activity: Activity[]; cases: { ref: string; title: string; status: string }[]
  records: Record<string, Record<string, unknown>[] | Record<string, unknown>>
}

const STATUS_LABEL: Record<string, [string, 'ok' | 'warn' | 'danger' | 'muted' | 'info']> = {
  done: ['Done and checked', 'ok'], not_verified: ['Done, check failed', 'warn'], blocked: ['Needs you', 'warn'], failed: ['Could not finish', 'danger'], waiting_for_owner: ['Waiting for your OK', 'info'],
}
const AGENT_STATUS: Record<Agent['status'], [string, 'ok' | 'warn' | 'muted']> = { working: ['Working', 'ok'], synthetic_only: ['Test data only', 'warn'], planned: ['Planned', 'muted'] }
const TRADE_LABEL: Record<string, string> = { construction: 'Construction', hvac: 'Heating and cooling (HVAC)', roofing: 'Roofing', landscaping: 'Landscaping', cleaning: 'Cleaning', general: 'Other trade' }
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not yet')
const money = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

async function post(body: Record<string, unknown>) { return storeFetch<Overview & { result: unknown }>('/api/store/packs', { method: 'POST', body }) }

/** The business-type choice: turns the matching packs on. */
export function BusinessTypePicker({ compact = false, onSaved }: { compact?: boolean; onSaved?: (o: Overview) => void }) {
  const { data, error, loading, setData } = useLoad(() => storeFetch<Overview>('/api/store/packs'), 'packs-overview')
  const [type, setType] = useState<string | null>(null)
  const [trade, setTrade] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  if (loading && !data) return <Loading label="Loading your business type" />
  if (error && !data) return null
  const d = data!
  const chosen = type ?? d.businessType ?? ''
  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setNote(null)
    try {
      const r = await post({ op: 'business-type', businessType: chosen, trade: chosen === 'home_services' ? (trade ?? d.trade) : null })
      setData(r); onSaved?.(r)
      setNote({ tone: 'ok', text: `Saved. ${r.packs.map(p => p.name).join(', ')} ${r.packs.length === 1 ? 'is' : 'are'} on.` })
    } catch (err) { setNote({ tone: 'warn', text: asApiError(err).message }) } finally { setBusy(false) }
  }
  return (
    <Panel className={compact ? '' : 'mt-4'}>
      <form onSubmit={save} aria-label="Your business type">
        <h2 className="text-[1.05rem]">What kind of business is this?</h2>
        <p className="pt-1 text-[14px] text-grey-h">Your AI team is set up for your kind of work. You can change this at any time.</p>
        <fieldset className="mt-3 grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Business type</legend>
          {d.businessTypes.map(b => (
            <label key={b.key} className={`flex cursor-pointer gap-3 rounded-[12px] border p-3 ${chosen === b.key ? 'border-[var(--c-accent)] bg-sunken' : 'border-line'}`}>
              <input type="radio" name="business-type" value={b.key} checked={chosen === b.key} onChange={() => setType(b.key)} />
              <span><span className="block text-ink">{b.label}</span><span className="block text-[13px] text-grey-h">{b.hint}</span></span>
            </label>
          ))}
        </fieldset>
        {chosen === 'home_services' && (
          <div className="mt-3 max-w-sm"><Field label="Your trade" htmlFor="trade"><Select id="trade" value={trade ?? d.trade} onChange={e => setTrade(e.target.value)}>{d.trades.map(t => <option key={t} value={t}>{TRADE_LABEL[t] ?? t}</option>)}</Select></Field></div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!chosen || busy}>{busy ? 'Saving' : 'Save'}</Button>
          <div aria-live="polite">{note && <span className={`text-[14px] ${note.tone === 'warn' ? 'text-warn' : 'text-ok'}`}>{note.text}</span>}</div>
        </div>
      </form>
    </Panel>
  )
}

export function PacksHome() {
  const { data, error, loading, reload, setData } = useLoad(() => storeFetch<Overview>('/api/store/packs'), 'packs-home')
  const header = <PageHeader title="Your AI team, by kind of work" sub="Each pack is a set of agents that see the work, do it, check it and tell you. They act on their own unless you ask them to check with you first." />
  if (loading && !data) return <>{header}<Loading label="Loading your packs" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  return (
    <>
      {header}
      {!d.businessType && <BusinessTypePicker onSaved={o => setData(o)} />}
      <Section id="packs" title="Your packs" sub={d.businessType ? 'Turned on by your business type.' : 'Choose your business type to turn packs on.'}>
        {d.packs.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {d.packs.map(p => (
              <li key={p.key}><Panel>
                <div className="flex items-start justify-between gap-2"><h3 className="text-[1rem] text-ink">{p.name}</h3>{p.attention > 0 && <Badge tone="warn">{p.attention} need{p.attention === 1 ? 's' : ''} you</Badge>}</div>
                <p className="pt-1 text-[14px] text-grey-h">{p.agents} agents · {p.done30d} jobs done and checked in the last 30 days</p>
                <div className="mt-3"><Button href={`/store/packs/${p.key}`} variant="ghost" size="sm">Open</Button></div>
              </Panel></li>
            ))}
          </ul>
        ) : <Empty title="No packs on yet">Pick your business type above.</Empty>}
      </Section>
      {d.businessType && <Section id="type" title="Business type"><BusinessTypePicker compact onSaved={o => setData(o)} /></Section>}
    </>
  )
}

function Table({ cols, rows, empty }: { cols: [string, (r: Record<string, unknown>) => ReactNode][]; rows: Record<string, unknown>[]; empty: string }) {
  if (!rows.length) return <p className="text-[14px] text-grey-h">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-[14px]">
        <thead><tr className="text-grey-h">{cols.map(([h]) => <th key={h} className="py-2 pr-3 font-normal">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={String(r.id ?? i)} className="border-t border-line">{cols.map(([h, f]) => <td key={h} className="py-2 pr-3 text-ink">{f(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function QuickForm({ title, op, fields, onDone, extra = {} }: { title: string; op: string; fields: { name: string; label: string; type?: string; options?: [string, string][] }[]; onDone: () => void; extra?: Record<string, unknown> }) {
  const [vals, setVals] = useState<Record<string, string>>({})
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault(); setNote(null)
    const body: Record<string, unknown> = { op, ...extra }
    for (const f of fields) body[f.name] = f.type === 'number' ? Number(vals[f.name] ?? '') : f.type === 'checkbox' ? vals[f.name] === 'on' : f.type === 'list' ? (vals[f.name] ?? '').split(',').map(x => x.trim()).filter(Boolean) : (vals[f.name] ?? '')
    try { await post(body); setVals({}); setNote({ tone: 'ok', text: 'Saved.' }); onDone() } catch (err) { setNote({ tone: 'warn', text: asApiError(err).message }) }
  }
  return (
    <form onSubmit={submit} className="mt-3 rounded-[12px] border border-line p-3" aria-label={title}>
      <h4 className="text-[14px] text-ink">{title}</h4>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {fields.map(f => (
          <Field key={f.name} label={f.label} htmlFor={`${op}-${f.name}`}>
            {f.options ? <Select id={`${op}-${f.name}`} value={vals[f.name] ?? ''} onChange={e => setVals({ ...vals, [f.name]: e.target.value })}><option value="">Choose</option>{f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              : <Input id={`${op}-${f.name}`} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : f.type === 'checkbox' ? 'checkbox' : 'text'} step={f.type === 'number' ? '0.01' : undefined}
                value={f.type === 'checkbox' ? undefined : vals[f.name] ?? ''} onChange={e => setVals({ ...vals, [f.name]: f.type === 'checkbox' ? (e.target.checked ? 'on' : '') : e.target.value })} />}
          </Field>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3"><Button type="submit" size="sm">Add</Button><span aria-live="polite" className={`text-[13px] ${note?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}>{note?.text}</span></div>
    </form>
  )
}

function Settings({ config, onSaved }: { config: Record<string, unknown>; onSaved: () => void }) {
  const [v, setV] = useState({ senderName: String(config.senderName ?? ''), reviewUrl: String(config.reviewUrl ?? ''), applicationUrl: String(config.applicationUrl ?? ''), dayStart: String(config.dayStart ?? '09:00'), dayEnd: String(config.dayEnd ?? '17:00') })
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  async function save(e: FormEvent) {
    e.preventDefault(); setNote(null)
    try { await post({ op: 'settings', patch: { senderName: v.senderName, dayStart: v.dayStart, dayEnd: v.dayEnd, reviewUrl: v.reviewUrl || null, applicationUrl: v.applicationUrl || null } }); setNote({ tone: 'ok', text: 'Saved.' }); onSaved() }
    catch (err) { setNote({ tone: 'warn', text: asApiError(err).message }) }
  }
  return (
    <Panel>
      <form onSubmit={save} aria-label="Pack settings">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name your customers see" htmlFor="ps-sender"><Input id="ps-sender" value={v.senderName} onChange={e => setV({ ...v, senderName: e.target.value })} /></Field>
          <Field label="Review link (sent after a paid job)" htmlFor="ps-review" hint="Starts with https://"><Input id="ps-review" value={v.reviewUrl} onChange={e => setV({ ...v, reviewUrl: e.target.value })} /></Field>
          <Field label="Application link (sent to renters)" htmlFor="ps-app" hint="Starts with https://"><Input id="ps-app" value={v.applicationUrl} onChange={e => setV({ ...v, applicationUrl: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Visits from" htmlFor="ps-start"><Input id="ps-start" value={v.dayStart} onChange={e => setV({ ...v, dayStart: e.target.value })} /></Field>
            <Field label="Visits until" htmlFor="ps-end"><Input id="ps-end" value={v.dayEnd} onChange={e => setV({ ...v, dayEnd: e.target.value })} /></Field>
          </div>
        </div>
        <p className="pt-3 text-[13px] text-grey-h">Agents act on their own and tell you after. To have an agent check with you first for a kind of action (for example sending invoices), change it in Settings.</p>
        <div className="mt-3 flex items-center gap-3"><Button type="submit" size="sm">Save settings</Button><span aria-live="polite" className={`text-[13px] ${note?.tone === 'warn' ? 'text-warn' : 'text-ok'}`}>{note?.text}</span></div>
      </form>
    </Panel>
  )
}

function Records({ pack, r, reload }: { pack: string; r: View['records']; reload: () => void }) {
  const list = (k: string) => (Array.isArray(r[k]) ? r[k] as Record<string, unknown>[] : [])
  if (pack === 'home_services' || pack === 'office') {
    const crew = list('crew')
    return (
      <>
        <Section id="jobs" title="Jobs and quotes"><Panel>
          <Table rows={list('jobs')} empty="No jobs yet. Add a quote you sent and the follow-ups start on their own." cols={[['Job', x => String(x.ref)], ['Customer', x => String(x.customer_name ?? '')], ['Status', x => <Badge tone="muted">{String(x.status)}</Badge>], ['Amount', x => money(x.amount)], ['Invoice', x => String(x.invoice_number ?? '')], ['Open balance', x => money(x.invoice_balance)]]} />
          <QuickForm title="Add a quote you sent" op="quote" extra={{ pack }} onDone={reload} fields={[{ name: 'customerName', label: 'Customer' }, { name: 'customerEmail', label: 'Customer email' }, { name: 'customerPhone', label: 'Phone' }, { name: 'address', label: 'Job address' }, { name: 'description', label: 'Work' }, { name: 'amount', label: 'Amount', type: 'number' }]} />
          {crew.length > 0 && <QuickForm title="Schedule a job" op="schedule" onDone={reload} fields={[{ name: 'workOrderId', label: 'Job', options: list('jobs').filter(j => ['quoted', 'accepted', 'quiet', 'scheduled'].includes(String(j.status))).map(j => [String(j.id), `${j.ref} ${j.customer_name ?? ''}`]) }, { name: 'crewMemberId', label: 'Crew member', options: crew.map(c => [String(c.id), String(c.name)]) }, { name: 'start', label: 'Start', type: 'datetime' }]} />}
        </Panel></Section>
        <Section id="crew" title="Crew"><Panel>
          <Table rows={crew} empty="No crew members yet." cols={[['Name', x => String(x.name)], ['Email', x => String(x.email ?? '')], ['Phone', x => String(x.phone ?? '')], ['Role', x => String(x.role ?? '')]]} />
          <QuickForm title="Add a crew member" op="crew" onDone={reload} fields={[{ name: 'name', label: 'Name' }, { name: 'email', label: 'Email' }, { name: 'phone', label: 'Phone (e.g. +15551234567)' }, { name: 'role', label: 'Role', options: [['field', 'Field crew'], ['packer', 'Packer'], ['warehouse', 'Warehouse'], ['other', 'Other']] }]} />
          <p className="mt-2 text-[13px] text-grey-h">This is the same crew as Settings, Crew: one list for job messages and Mark done links.</p>
        </Panel></Section>
      </>
    )
  }
  if (pack === 'leasing') {
    const week = (r.week ?? {}) as Record<string, number>
    const props = list('properties')
    return (
      <>
        <Section id="commission" title="Commission" sub="The last seven days, and everything still owed.">
          <div className="grid gap-3 sm:grid-cols-3">
            {([['Invoiced', week.invoiced], ['Collected', week.collected], ['Owed', week.owed]] as const).map(([k, v]) => <Panel key={k}><div className="text-[13px] text-grey-h">{k}</div><div className="text-[1.4rem] text-ink">{money(v ?? 0)}</div></Panel>)}
          </div>
          <Panel className="mt-3">
            <h3 className="text-[1rem]">Commission invoices</h3>
            <Table rows={list('invoices')} empty="No invoices yet. They are built on their own once a move-in date arrives." cols={[['Invoice', x => String(x.number)], ['Property', x => String(x.property ?? '')], ['Due', x => String(x.due_date)], ['Total', x => money(x.total)], ['Paid', x => money(x.paid_amount)], ['Status', x => <Badge tone={x.status === 'paid' ? 'ok' : x.status === 'partial' ? 'info' : 'muted'}>{String(x.status)}</Badge>]]} />
            <QuickForm title="Record a payment" op="payment" onDone={reload} fields={[{ name: 'invoiceId', label: 'Invoice', options: list('invoices').filter(i => ['sent', 'partial'].includes(String(i.status))).map(i => [String(i.id), `${i.number} ${i.property ?? ''}`]) }, { name: 'amount', label: 'Amount', type: 'number' }, { name: 'receivedOn', label: 'Received on', type: 'date' }]} />
          </Panel>
          <Panel className="mt-3">
            <h3 className="text-[1rem]">Move-ins</h3>
            <Table rows={list('placements')} empty="No move-ins yet." cols={[['Tenant', x => String(x.tenant_name)], ['Property', x => String(x.property ?? '')], ['Unit', x => String(x.unit)], ['Move-in', x => String(x.move_in_date)], ['Rent', x => money(x.monthly_rent)], ['Commission', x => money(x.commission_amount)], ['Status', x => <Badge tone="muted">{String(x.status)}</Badge>]]} />
            {props.length > 0 && <QuickForm title="Add a move-in" op="placement" onDone={reload} fields={[{ name: 'propertyId', label: 'Property', options: props.map(p => [String(p.id), String(p.name)]) }, { name: 'tenantName', label: 'Tenant' }, { name: 'tenantEmail', label: 'Tenant email' }, { name: 'unit', label: 'Unit' }, { name: 'moveInDate', label: 'Move-in date', type: 'date' }, { name: 'monthlyRent', label: 'Monthly rent', type: 'number' }]} />}
          </Panel>
          <Panel className="mt-3">
            <h3 className="text-[1rem]">Properties</h3>
            <Table rows={props} empty="No properties yet." cols={[['Property', x => String(x.name)], ['Managing company', x => String(x.company ?? '')], ['Commission', x => (x.commission_type === 'flat' ? `${money(x.commission_value)} flat` : `${Number(x.commission_value)}% of one month`)], ['Invoices go to', x => String(x.bill_to ?? 'not set')]]} />
            <QuickForm title="Add a property" op="property" onDone={reload} fields={[{ name: 'name', label: 'Property' }, { name: 'company', label: 'Managing company' }, { name: 'companyEmail', label: 'Company billing email' }, { name: 'billingEmail', label: 'Property billing email' }, { name: 'commissionType', label: 'Commission', options: [['percent', 'Percent of one month'], ['flat', 'Flat fee']] }, { name: 'commissionValue', label: 'Percent or amount', type: 'number' }]} />
          </Panel>
        </Section>
        <Section id="leads" title="Renter leads" sub="Everyone is asked the same four questions: budget, move-in date, bedrooms and pets."><Panel>
          <Table rows={list('leads')} empty="No renter leads yet." cols={[['Name', x => String(x.name ?? '')], ['From', x => String(x.source).replace('_', '.')], ['Status', x => <Badge tone="muted">{String(x.status)}</Badge>], ['Received', x => when(String(x.created_at))]]} />
        </Panel></Section>
      </>
    )
  }
  if (pack === 'property_management') return (
    <>
      <Section id="requests" title="Maintenance requests"><Panel>
        <Table rows={list('requests')} empty="No maintenance requests yet." cols={[['Unit', x => String(x.unit ?? '')], ['Issue', x => `${x.category}${x.urgency === 'emergency' ? ' (emergency)' : ''}`], ['Tenant', x => String(x.tenant_name ?? '')], ['Vendor', x => String(x.vendor ?? '')], ['Status', x => <Badge tone={x.status === 'escalated' ? 'warn' : x.status === 'confirmed' ? 'ok' : 'muted'}>{String(x.status)}</Badge>]]} />
      </Panel></Section>
      <Section id="vendors" title="Vendors"><Panel>
        <Table rows={list('vendors')} empty="No vendors yet. Add the people you send work to." cols={[['Vendor', x => String(x.name)], ['Email', x => String(x.email ?? '')], ['Trades', x => (x.trades as string[]).join(', ')]]} />
        <QuickForm title="Add a vendor" op="vendor" onDone={reload} fields={[{ name: 'name', label: 'Name' }, { name: 'email', label: 'Email' }, { name: 'phone', label: 'Phone' }, { name: 'trades', label: 'Trades (plumbing, electrical, hvac, appliance, pest, locks, general)', type: 'list' }]} />
      </Panel></Section>
    </>
  )
  return (
    <Section id="leads" title="Leads"><Panel>
      <Table rows={list('leads')} empty="No leads yet." cols={[['Name', x => String(x.name ?? '')], ['Type', x => String(x.intent)], ['From', x => String(x.source).replace('_', '.')], ['Status', x => <Badge tone="muted">{String(x.status)}</Badge>], ['In your CRM', x => (x.crm_record_id ? 'yes' : 'not yet')]]} />
    </Panel></Section>
  )
}

export function PackDashboard({ pack }: { pack: string }) {
  const { data, error, loading, reload } = useLoad(() => storeFetch<View>(`/api/store/packs/${encodeURIComponent(pack)}`), `pack-${pack}`)
  const back = <Link href="/store/packs" className="text-[14px] text-grey-h">All packs</Link>
  if (loading && !data) return <>{back}<Loading label="Loading the pack" /></>
  if (error && !data) return <>{back}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  const name = Object.fromEntries(d.agents.map(a => [a.key, a.name]))
  return (
    <>
      {back}
      <PageHeader title={d.pack.name} sub="These agents see the work, do it, check it and tell you." />
      {!d.pack.on && <Banner tone="warn">This pack is off for your business type. Change your business type on the packs page to turn it on.</Banner>}
      {d.agents.some(a => a.status === 'synthetic_only') && <div className="mt-3"><Banner tone="warn">Agents marked “Test data only” run against Deploi&apos;s test providers until your mail, calendar, CRM, accounting or property system is connected.</Banner></div>}
      <Section id="agents" title="Agents">
        <ul className="grid gap-3 sm:grid-cols-2">
          {d.agents.map(a => (
            <li key={a.key}><Panel>
              <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="text-[1rem] text-ink">{a.name}</h3><Badge tone={AGENT_STATUS[a.status][1]}>{AGENT_STATUS[a.status][0]}</Badge></div>
              <p className="pt-1 text-[14px] text-grey">{a.job}</p>
              <p className="pt-2 text-[13px] text-grey-h">{a.done} done and checked{a.attention ? ` · ${a.attention} need you` : ''} · last active {when(a.lastActive)}</p>
            </Panel></li>
          ))}
        </ul>
      </Section>
      <Section id="activity" title="What they did">
        {d.activity.length ? (
          <ul className="grid gap-2">
            {d.activity.map(x => (
              <li key={x.id}><Panel tone={x.status === 'done' ? undefined : 'warn'}>
                <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_LABEL[x.status]?.[1] ?? 'muted'}>{STATUS_LABEL[x.status]?.[0] ?? x.status}</Badge><span className="text-[13px] text-grey-h">{name[x.agent_key] ?? x.agent_key} · {when(x.updated_at)}</span></div>
                <p className="pt-1 text-ink">{x.title}</p>
                {x.what_happened && <p className="text-[14px] text-grey">{x.what_happened}</p>}
                {x.error && <p className="text-[14px] text-warn">{x.error}</p>}
                {x.proof.length > 0 && <details className="pt-1 text-[13px] text-grey-h"><summary>Proof</summary><ul>{x.proof.map((p, i) => <li key={i}>{p.label}: {p.value}</li>)}</ul></details>}
              </Panel></li>
            ))}
          </ul>
        ) : <Empty title="Nothing yet">When work comes in, every step shows here with its proof.</Empty>}
        {d.cases.length > 0 && <Panel className="mt-3"><h3 className="text-[1rem]">Cases</h3><ul className="pt-2 text-[14px]">{d.cases.map(c => <li key={c.ref}><Link href={`/store/work/${encodeURIComponent(c.ref)}`}>{c.ref}</Link> {c.title} <Badge tone="muted">{c.status}</Badge></li>)}</ul></Panel>}
      </Section>
      <Records pack={d.pack.key} r={d.records} reload={reload} />
      <Section id="settings" title="Settings"><Settings config={d.config} onSaved={reload} /></Section>
    </>
  )
}
