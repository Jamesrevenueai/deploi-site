'use client'
/**
 * Competitor & Trend Watcher screens: setup from the template, watched-store management with source health,
 * the findings feed (each finding labelled Observed / Inferred / Unavailable, with evidence, period and
 * limitations), the product comparison view, price and availability history, and the handoff of a finding
 * to a Supplier Chaser as a draft.
 */
import { useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Input, Select, Textarea } from '@/components/ui/Field'
import { Sheet } from '@/components/ui/Sheet'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Loading, Panel, Section, Chips, useStore } from './bits'
import { fmtTime } from './format'
import { isEmailAddress } from './AgentForm'
import type { AgentPolicy, AgentsResponse, AgentTemplateView, EditAgentResponse } from './types'

// ------------------------------------------------------------------ types (API shapes)

type Basis = 'observed' | 'inferred' | 'unavailable'
type Insight = {
  id: string; kind: string; headline: string; basis: Basis; facts: string[]; stores: { id: string; label: string }[]
  products: { storeId: string; store: string; title: string; url: string | null; observedAt: string; note?: string }[]
  sources: { url: string; observedAt: string }[]; period_start: string; period_end: string; inference: string | null; limitations: string[]
  next_action: string; meaningful: boolean; status: 'new' | 'dismissed' | 'handed_off'; handoff: { supplier_agent: string; message_status: string; at: string } | null; created_at: string
}
type WatchedStore = {
  id: string; origin: string; domain: string; label: string; status: string; status_reason: string | null; currency: string | null; baseline_at: string | null
  last_check_complete: boolean; bestseller_observed: boolean; last_attempt_at: string | null; last_success_at: string | null; consecutive_failures: number; products_listed: number
  last_check: { outcome: string; reason: string | null; product_count: number; requests_used: number; bestseller_status: string | null; finished_at: string } | null
}
type Overview = { ok: true; stores: WatchedStore[]; insights: Insight[]; sources: { key: string; label: string; coverage: string[] }[]; providers: { key: string; label: string; reason: string }[] }
type ProductRow = { id: string; store_id: string; store: string; title: string; url: string; product_type: string; currency: string | null; price_min: string | null; price_max: string | null; on_sale: boolean; available_count: number; availability_known: number; bestseller_rank: number | null; first_seen_at: string; in_baseline: boolean; listed: boolean; last_seen_at: string }
type History = { ok: true; product: { title: string; url: string; store: string; currency: string | null }; history: { observed_at: string; last_confirmed_at: string; currency: string | null; price_min: string | null; price_max: string | null; on_sale: boolean; available_count: number; availability_known: number; bestseller_rank: number | null }[]; checks: { outcome: string; reason: string | null; finished_at: string }[] }

// ------------------------------------------------------------------ words

export const BASIS_WORDS: Record<Basis, { label: string; tone: 'ok' | 'warn' | 'muted'; hint: string }> = {
  observed: { label: 'Observed', tone: 'ok', hint: 'Read from the store’s public page at the time shown.' },
  inferred: { label: 'Inferred', tone: 'warn', hint: 'A pattern across observations. The reasoning is shown; it is not a measured fact.' },
  unavailable: { label: 'Unavailable', tone: 'muted', hint: 'Deploi could not observe this.' },
}
const STORE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  pending: { label: 'Not checked yet', tone: 'muted' }, supported: { label: 'Readable', tone: 'ok' }, unsupported: { label: 'Not supported', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'danger' }, rate_limited: { label: 'Rate limited', tone: 'warn' }, error: { label: 'Last check failed', tone: 'warn' },
}
const money = (v: string | null, c: string | null) => (v === null ? 'not observed' : `${Number(v).toFixed(2)} ${c ?? '(currency not stated)'}`)
const range = (a: string | null, b: string | null, c: string | null) => (a === null ? 'not observed' : a === b || b === null ? money(a, c) : `${Number(a).toFixed(2)}–${Number(b).toFixed(2)} ${c ?? ''}`.trim())
const host = (u: string) => { try { return new URL(u).host } catch { return u } }

export function BasisBadge({ basis }: { basis: Basis }) {
  const w = BASIS_WORDS[basis] ?? BASIS_WORDS.unavailable
  return <span title={w.hint}><Badge tone={w.tone}>{w.label}</Badge></span>
}

// ------------------------------------------------------------------ setup (template start)

type StoreDraft = { url: string; label: string; bestsellerCollection: string }
const blankStore = (): StoreDraft => ({ url: '', label: '', bestsellerCollection: '' })
const splitList = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean)
const looksLikeDomain = (s: string) => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(s.trim())

export function CompetitorTemplateStart({ template, connectionId, busy, onCreate }: { template: AgentTemplateView; connectionId: string; busy: boolean; onCreate: (input: Record<string, unknown>) => void }) {
  const [name, setName] = useState(template.name)
  const [stores, setStores] = useState<StoreDraft[]>([blankStore()])
  const [keywords, setKeywords] = useState('')
  const [categories, setCategories] = useState('')
  const [region, setRegion] = useState('')
  const [currency, setCurrency] = useState('')
  const [frequency, setFrequency] = useState('daily')
  const [notify, setNotify] = useState('')
  const [launches, setLaunches] = useState(true)
  const [promos, setPromos] = useState(true)
  const [availability, setAvailability] = useState(false)
  const [pct, setPct] = useState('15')
  const [showProblems, setShowProblems] = useState(false)
  const filled = stores.filter(s => s.url.trim())
  const problems: string[] = []
  if (!name.trim()) problems.push('Give the agent a name.')
  if (!filled.length) problems.push('Add at least one store to watch.')
  for (const s of filled) if (!looksLikeDomain(s.url)) problems.push(`"${s.url}" is not a web address.`)
  if (filled.length > 25) problems.push('Watch at most 25 stores.')
  if (notify.trim() && !isEmailAddress(notify.trim().toLowerCase())) problems.push('The alert address is not a valid email address.')
  if (currency.trim() && !/^[A-Za-z]{3}$/.test(currency.trim())) problems.push('Currency is a three-letter code, e.g. USD.')
  const p = Number(pct)
  if (!(p >= 1 && p <= 90)) problems.push('The price change alert threshold must be 1 to 90 percent.')

  function submit() {
    setShowProblems(true)
    if (problems.length) return
    onCreate({
      name: name.trim(), notify: notify.trim(), connectionId,
      competitor: {
        stores: filled.map(s => ({ url: s.url.trim(), label: s.label.trim() || undefined, bestsellerCollection: s.bestsellerCollection.trim() || null })),
        keywords: splitList(keywords), categories: splitList(categories), region: region.trim() || null, currency: currency.trim().toUpperCase() || null,
        everyHours: frequency === 'daily' ? null : Number(frequency),
        alerts: { newLaunches: launches, promotions: promos, availability, priceChangePct: p, bestsellers: true },
      },
    })
  }

  return (
    <Panel>
      <form className="flex flex-col gap-5" onSubmit={e => { e.preventDefault(); submit() }}>
        <div className="flex flex-wrap items-center gap-2"><Badge tone="muted">Template</Badge><h2 className="text-[1.1rem]">{template.name}</h2></div>
        <p className="text-[15px] text-grey">&ldquo;{template.job}&rdquo;</p>
        <div className="flex flex-wrap gap-2"><Badge tone="muted">Public web pages: read only</Badge><Badge tone="muted">Your store: no access</Badge><Badge tone="muted">Email: drafts only, optional</Badge></div>
        <Banner>What Deploi can see: what each store shows publicly (products, prices, sale prices, availability, its own bestseller collection). What it cannot see: their sales, revenue, units or stock. Findings say which is which.</Banner>

        <div className="flex flex-col gap-1">
          <label htmlFor="cw-name" className="text-[14px] text-grey">Agent name</label>
          <Input id="cw-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-[14px] text-grey">Stores to watch (their public web address)</legend>
          {stores.map((s, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-[14px] border border-line p-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
              <div className="flex flex-col gap-1"><label htmlFor={`cw-url-${i}`} className="text-[13px] text-grey-h">Web address</label>
                <Input id={`cw-url-${i}`} value={s.url} placeholder="www.example-store.com" inputMode="url" onChange={e => setStores(stores.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} /></div>
              <div className="flex flex-col gap-1"><label htmlFor={`cw-label-${i}`} className="text-[13px] text-grey-h">Name (optional)</label>
                <Input id={`cw-label-${i}`} value={s.label} maxLength={80} onChange={e => setStores(stores.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} /></div>
              <div className="flex flex-col gap-1"><label htmlFor={`cw-best-${i}`} className="text-[13px] text-grey-h">Bestseller collection (optional)</label>
                <Input id={`cw-best-${i}`} value={s.bestsellerCollection} placeholder="best-sellers" onChange={e => setStores(stores.map((x, j) => j === i ? { ...x, bestsellerCollection: e.target.value } : x))} /></div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setStores(stores.length > 1 ? stores.filter((_, j) => j !== i) : [blankStore()])} aria-label={`Remove store ${i + 1}`}><Icon name="x" size={14} />Remove</Button>
            </div>
          ))}
          {stores.length < 25 && <div><Button type="button" size="sm" variant="ghost" onClick={() => setStores([...stores, blankStore()])}><Icon name="plus" size={14} />Add a store</Button></div>}
          <p className="text-[13px] text-grey-h">Supported today: Shopify storefronts that publish their product feed. Other stores are shown as &ldquo;Not supported&rdquo;; Deploi never logs in to, or works around blocks on, any store.</p>
        </fieldset>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1"><label htmlFor="cw-kw" className="text-[14px] text-grey">Keywords (comma separated, optional)</label>
            <Input id="cw-kw" value={keywords} placeholder="travel organizer, packing cube" onChange={e => setKeywords(e.target.value)} /></div>
          <div className="flex flex-col gap-1"><label htmlFor="cw-cat" className="text-[14px] text-grey">Categories (optional)</label>
            <Input id="cw-cat" value={categories} placeholder="bags, accessories" onChange={e => setCategories(e.target.value)} /></div>
          <div className="flex flex-col gap-1"><label htmlFor="cw-region" className="text-[14px] text-grey">Region (for your reference)</label>
            <Input id="cw-region" value={region} placeholder="United States" onChange={e => setRegion(e.target.value)} /></div>
          <div className="flex flex-col gap-1"><label htmlFor="cw-cur" className="text-[14px] text-grey">Your currency (optional)</label>
            <Input id="cw-cur" value={currency} maxLength={3} placeholder="USD" onChange={e => setCurrency(e.target.value)} /></div>
          <div className="flex flex-col gap-1"><label htmlFor="cw-freq" className="text-[14px] text-grey">How often</label>
            <Select id="cw-freq" value={frequency} onChange={e => setFrequency(e.target.value)}>
              <option value="daily">Once a day</option><option value="12">Every 12 hours</option><option value="6">Every 6 hours</option><option value="168">Once a week</option>
            </Select></div>
          <div className="flex flex-col gap-1"><label htmlFor="cw-notify" className="text-[14px] text-grey">Email alerts to (optional; drafted to you, never sent without your permission)</label>
            <Input id="cw-notify" type="email" value={notify} placeholder="you@your-store.com" onChange={e => setNotify(e.target.value)} /></div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[14px] text-grey">Alert me about</legend>
          <label className="flex items-center gap-2 text-[15px] text-grey"><input type="checkbox" checked={launches} onChange={e => setLaunches(e.target.checked)} />New launches</label>
          <label className="flex items-center gap-2 text-[15px] text-grey"><input type="checkbox" checked={promos} onChange={e => setPromos(e.target.checked)} />New sale prices</label>
          <label className="flex items-center gap-2 text-[15px] text-grey"><input type="checkbox" checked={availability} onChange={e => setAvailability(e.target.checked)} />Products shown as unavailable</label>
          <div className="flex flex-wrap items-center gap-2 text-[15px] text-grey"><label htmlFor="cw-pct">Price changes of at least</label><Input id="cw-pct" value={pct} inputMode="numeric" className="input w-20" onChange={e => setPct(e.target.value)} />%</div>
          <p className="text-[13px] text-grey-h">Patterns across 2 or more of your stores, and changes to their bestseller collections, are always shown.</p>
        </fieldset>
        {showProblems && problems.length > 0 && <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] text-warn" role="alert">{problems.map(x => <li key={x}>{x}</li>)}</ul>}
        <p className="text-[13px] text-grey-h">Nothing is granted yet. Next you read exactly what this agent may do, then grant it. The first check records a baseline; changes are reported from the second check on.</p>
        <div><Button type="submit" disabled={busy}><Icon name="shield" size={16} />{busy ? 'Preparing…' : 'Review authorization'}</Button></div>
      </form>
    </Panel>
  )
}

// ------------------------------------------------------------------ agent detail sections

export function CompetitorSections({ agentId, policy, canEdit, agentActive, refreshKey, onChanged }: { agentId: string; policy: AgentPolicy; canEdit: boolean; agentActive: boolean; refreshKey: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => storeFetch<Overview>(`/api/store/agents/${encodeURIComponent(agentId)}/competitors`), `${agentId}:${refreshKey}`)
  const [filter, setFilter] = useState<'all' | 'meaningful' | 'handed_off'>('all')
  const [handoff, setHandoff] = useState<Insight | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: ReactNode } | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)

  if (loading && !data) return <Section id="competitors" title="Watched stores"><Loading label="Loading findings" /></Section>
  if (error && !data) return <Section id="competitors" title="Watched stores"><ErrorState error={error} onRetry={reload} /></Section>
  if (!data) return null
  const shown = data.insights.filter(i => filter === 'all' ? true : filter === 'meaningful' ? i.meaningful : i.status === 'handed_off')
  const neverChecked = data.stores.every(s => !s.last_attempt_at)

  async function dismiss(i: Insight) {
    setErr(null)
    try { await storeFetch(`/api/store/competitor-insights/${i.id}/dismiss`, { method: 'POST', body: {} }); await reload() } catch (e) { setErr(asApiError(e)) }
  }

  return (
    <>
      <div aria-live="polite" className="flex flex-col gap-3">
        {notice && <Banner tone={notice.ok ? 'info' : 'warn'} icon={notice.ok ? 'check' : 'alert'}>{notice.text}</Banner>}
        {err && <ErrorState error={err} />}
      </div>
      <Section id="competitors" title="Watched stores" sub="Source health for each store: when it was last read in full, and why not when it could not be.">
        <WatchedStores stores={data.stores} policy={policy} agentId={agentId} canEdit={canEdit} onSaved={r => { setNotice({ ok: true, text: r.requiresGrant ? <>Saved as version {r.version}. Adding stores or raising the budget needs your grant: see Authorization above. The current version keeps running until then.</> : 'Saved. The change applies from the next check.' }); onChanged(); void reload() }} onError={setErr} />
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.sources.map(s => (
            <Panel key={s.key}><h3 className="text-[1rem]">Source: {s.label}</h3><ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[14px] text-grey">{s.coverage.map(c => <li key={c}>{c}</li>)}</ul></Panel>
          ))}
          <Panel>
            <h3 className="text-[1rem]">Wider market trends</h3>
            <div className="mt-2 flex flex-col gap-2">{data.providers.map(p => <p key={p.key} className="text-[14px] text-grey"><Badge tone="muted">Unavailable</Badge> {p.label}: {p.reason}</p>)}</div>
            <p className="pt-2 text-[13px] text-grey-h">Patterns shown here are among the stores you follow only.</p>
          </Panel>
        </div>
      </Section>

      <Section id="findings" title="Findings" sub="Each finding says what was observed, what is only inferred, the evidence and its limits." actions={<Chips label="Filter findings" value={filter} onChange={setFilter} options={[['all', 'All'], ['meaningful', 'Meaningful'], ['handed_off', 'Handed off']]} />}>
        {shown.length === 0 ? (
          <Empty title={neverChecked ? 'Not checked yet' : 'No findings'}>{neverChecked ? (agentActive ? 'Press Run now, or wait for the schedule. The first check records a baseline.' : 'Grant the authorization to start checking.') : filter === 'all' ? 'No changes since the last check.' : 'Nothing in this filter.'}</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {shown.map(i => <InsightCard key={i.id} i={i} canAct={canEdit} onHandoff={() => { setNotice(null); setHandoff(i) }} onDismiss={() => void dismiss(i)} />)}
          </ul>
        )}
      </Section>

      <Comparison agentId={agentId} stores={data.stores} refreshKey={refreshKey} onHistory={setHistory} />

      {handoff && <HandoffSheet insight={handoff} onClose={() => setHandoff(null)} onDone={(text, ok) => { setHandoff(null); setNotice({ ok, text }); void reload(); onChanged() }} />}
      {history && <HistorySheet agentId={agentId} productId={history} onClose={() => setHistory(null)} />}
    </>
  )
}

function WatchedStores({ stores, policy, agentId, canEdit, onSaved, onError }: { stores: WatchedStore[]; policy: AgentPolicy; agentId: string; canEdit: boolean; onSaved: (r: EditAgentResponse) => void; onError: (e: StoreApiError) => void }) {
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const c = policy.competitor!
  async function save(next: NonNullable<AgentPolicy['competitor']>['stores']) {
    setBusy(true)
    try {
      const r = await storeFetch<EditAgentResponse>(`/api/store/agents/${agentId}`, { method: 'PUT', body: { policy: { ...policy, competitor: { ...c, stores: next } } } })
      setAdding(''); onSaved(r)
    } catch (e) { onError(asApiError(e)) } finally { setBusy(false) }
  }
  const byOrigin = new Map(stores.map(s => [s.origin, s]))
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {c.stores.map(st => {
          const s = byOrigin.get(st.url)
          const w = STORE_STATUS[s?.status ?? 'pending'] ?? STORE_STATUS.pending
          return (
            <li key={st.url}>
              <Panel>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium text-ink break-all">{st.label}</span><Badge tone={w.tone}>{w.label}</Badge>
                    {s?.last_check && s.status === 'supported' && <Badge tone="muted">{s.last_check.outcome === 'complete' ? 'Last check complete' : 'Last check partial'}</Badge>}
                  </div>
                  {canEdit && c.stores.length > 1 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(c.stores.filter(x => x.url !== st.url))} aria-label={`Stop watching ${st.label}`}>Stop watching</Button>}
                </div>
                <div className="mt-2 grid grid-cols-1 gap-1 text-[14px] text-grey sm:grid-cols-2">
                  <span><a href={st.url} target="_blank" rel="noopener noreferrer nofollow" className="underline break-all">{host(st.url)}</a></span>
                  <span>Last successful check: {s?.last_success_at ? fmtTime(s.last_success_at) : 'never'}</span>
                  <span>Baseline: {s?.baseline_at ? fmtTime(s.baseline_at) : 'not recorded yet'}</span>
                  <span>Products listed: {s?.products_listed ?? 0}{s?.currency ? ` · prices in ${s.currency}` : ''}</span>
                  <span>Bestseller collection: {s?.bestseller_observed ? 'observed' : 'not available'}</span>
                  {s?.last_check && <span>Requests used last check: {s.last_check.requests_used}</span>}
                </div>
                {s?.status_reason && <p className={`pt-2 text-[14px] ${s.status === 'supported' ? 'text-grey-h' : 'text-warn'}`}>{s.status_reason.charAt(0).toUpperCase() + s.status_reason.slice(1)}</p>}
              </Panel>
            </li>
          )
        })}
      </ul>
      {canEdit && c.stores.length < 25 && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (looksLikeDomain(adding)) void save([...c.stores, { url: adding.trim(), label: '', bestsellerCollection: null }]) }}>
          <div className="flex min-w-[220px] flex-1 flex-col gap-1"><label htmlFor="cw-add" className="text-[13px] text-grey-h">Watch another store</label>
            <Input id="cw-add" value={adding} placeholder="www.another-store.com" inputMode="url" onChange={e => setAdding(e.target.value)} /></div>
          <Button type="submit" size="sm" variant="ghost" disabled={busy || !looksLikeDomain(adding)}><Icon name="plus" size={14} />{busy ? 'Saving…' : 'Add (needs a new grant)'}</Button>
        </form>
      )}
    </div>
  )
}

function InsightCard({ i, canAct, onHandoff, onDismiss }: { i: Insight; canAct: boolean; onHandoff: () => void; onDismiss: () => void }) {
  const [open, setOpen] = useState(false)
  const handable = canAct && i.basis !== 'unavailable' && i.products.length > 0 && i.kind !== 'baseline'
  return (
    <li>
      <Panel tone={i.basis === 'unavailable' ? 'warn' : undefined}>
        <div className="flex flex-wrap items-center gap-2"><BasisBadge basis={i.basis} />{i.meaningful && <Badge tone="warn">Meaningful</Badge>}{i.status === 'handed_off' && <Badge tone="muted">Handed off</Badge>}</div>
        <h3 className="pt-2 text-[1.05rem] break-words">{i.headline}</h3>
        <p className="pt-1 text-[13px] text-grey-h">Compared {fmtTime(i.period_start)} → {fmtTime(i.period_end)} · {i.stores.map(s => s.label).join(', ')}</p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[15px] text-grey">{i.facts.map(f => <li key={f} className="break-words">{f}</li>)}</ul>
        {i.inference && <p className="pt-2 text-[15px] text-grey"><span className="text-ink">Inference: </span>{i.inference}</p>}
        <p className="pt-2 text-[15px] text-ink"><span className="text-grey-h">Suggested next step: </span>{i.next_action}</p>
        {i.handoff && <p className="pt-2 text-[14px] text-grey">Handed to {i.handoff.supplier_agent} on {fmtTime(i.handoff.at)} as a {i.handoff.message_status === 'draft' ? 'draft (not sent)' : 'message waiting for your approval (not sent)'}.</p>}
        <button type="button" className="mt-2 text-[14px] text-ink underline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide evidence' : `Evidence and limitations (${i.products.length} product${i.products.length === 1 ? '' : 's'}, ${i.sources.length} source${i.sources.length === 1 ? '' : 's'})`}</button>
        {open && (
          <div className="mt-2 flex flex-col gap-3">
            {i.products.length > 0 && (
              <div className="table-wrap"><table className="dg-table"><caption className="sr-only">Products in this finding</caption>
                <thead><tr><th scope="col">Product</th><th scope="col">Store</th><th scope="col">Observed</th><th scope="col">Note</th></tr></thead>
                <tbody>{i.products.map((p, n) => (
                  <tr key={n}><td className="ink break-words">{p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{p.title}</a> : p.title}</td><td>{p.store}</td><td className="whitespace-nowrap">{fmtTime(p.observedAt)}</td><td>{p.note ?? ''}</td></tr>
                ))}</tbody></table></div>
            )}
            {i.sources.length > 0 && <div><h4 className="text-[14px] text-ink">Sources</h4><ul className="mt-1 flex flex-col gap-1 text-[13px] text-grey">{i.sources.map((s, n) => <li key={n} className="break-all"><a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{s.url}</a> · {fmtTime(s.observedAt)}</li>)}</ul></div>}
            <div><h4 className="text-[14px] text-ink">Limitations</h4><ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[14px] text-grey">{i.limitations.map(l => <li key={l}>{l}</li>)}</ul></div>
          </div>
        )}
        {(handable || (canAct && i.status === 'new')) && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
            {handable && i.status !== 'handed_off' && <Button size="sm" variant="ghost" onClick={onHandoff}><Icon name="mail" size={14} />Draft a sourcing request</Button>}
            {i.status === 'new' && <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
          </div>
        )}
      </Panel>
    </li>
  )
}

function HandoffSheet({ insight, onClose, onDone }: { insight: Insight; onClose: () => void; onDone: (text: ReactNode, ok: boolean) => void }) {
  const { base } = useStore()
  const agents = useLoad(() => storeFetch<AgentsResponse>('/api/store/agents'), 'handoff-agents')
  const chasers = (agents.data?.agents ?? []).filter(a => a.status === 'active' && a.is_supplier_chaser)
  const [chosen, setChosen] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const pick = chosen || chasers[0]?.id || ''
  async function send() {
    setBusy(true); setErr(null)
    try {
      const r = await storeFetch<{ status: string; duplicate: boolean }>(`/api/store/competitor-insights/${insight.id}/handoff`, { method: 'POST', body: { supplierAgentId: pick, note: note.trim() || undefined } })
      const name = chasers.find(a => a.id === pick)?.name ?? 'your Supplier Chaser'
      onDone(<>{r.duplicate ? 'Already handed off: ' : ''}A sourcing request was {r.status === 'draft' ? <>drafted for {name}. It is a draft only (that agent may not send); read it on the agent&apos;s page.</> : <>prepared for {name} and is <strong>waiting for your approval</strong> in <a className="underline" href={`${base}/inbox`}>Approvals</a>. Nothing has been sent.</>}</>, true)
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(false) }
  }
  return (
    <Sheet open onClose={onClose} title="Draft a sourcing request">
      <div className="flex flex-col gap-3">
        <p className="text-[15px] text-grey">Creates a message to your supplier from a Supplier Chaser, with this finding&apos;s products, links and observation times attached as evidence. It is never sent automatically: it stays a draft, or waits for your approval of the exact text if that agent may send after approval.</p>
        {agents.loading && !agents.data ? <Loading rows={1} /> : agents.error ? <ErrorState error={agents.error} onRetry={agents.reload} /> : chasers.length === 0 ? (
          <Banner tone="warn">No active Supplier Chaser with a supplier address. <a className="underline" href={`${base}/agents/new?template=supplier_chaser`}>Create one from the template</a> and grant it first.</Banner>
        ) : (
          <>
            <div className="flex flex-col gap-1"><label htmlFor="ho-agent" className="text-[14px] text-grey">Supplier Chaser</label>
              <Select id="ho-agent" value={pick} onChange={e => setChosen(e.target.value)}>{chasers.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></div>
            <div className="flex flex-col gap-1"><label htmlFor="ho-note" className="text-[14px] text-grey">Note to include (optional)</label>
              <Textarea id="ho-note" rows={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. We are looking at 200 units for spring." /></div>
            {err && <ErrorState error={err} />}
            <div className="flex flex-wrap gap-2"><Button onClick={() => void send()} disabled={busy || !pick}><Icon name="mail" size={15} />{busy ? 'Preparing…' : 'Prepare the request'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
          </>
        )}
      </div>
    </Sheet>
  )
}

function Comparison({ agentId, stores, refreshKey, onHistory }: { agentId: string; stores: WatchedStore[]; refreshKey: string; onHistory: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')
  const [store, setStore] = useState('')
  const list = useLoad(() => storeFetch<{ ok: true; products: ProductRow[] }>(`/api/store/agents/${encodeURIComponent(agentId)}/competitors/products?q=${encodeURIComponent(applied)}${store ? `&store=${store}` : ''}`), `${agentId}:${applied}:${store}:${refreshKey}`)
  const rows = list.data?.products ?? []
  const currencies = new Set(rows.map(r => r.currency ?? '?'))
  return (
    <Section id="compare" title="Compare products" sub="Products currently seen at the stores you follow. Prices are shown in each store's own currency and are never converted.">
      <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); setApplied(q.trim()) }}>
        <div className="flex min-w-[200px] flex-1 flex-col gap-1"><label htmlFor="cmp-q" className="text-[13px] text-grey-h">Word in title, type or tag</label><Input id="cmp-q" value={q} onChange={e => setQ(e.target.value)} placeholder="organizer" /></div>
        <div className="flex flex-col gap-1"><label htmlFor="cmp-store" className="text-[13px] text-grey-h">Store</label>
          <Select id="cmp-store" value={store} onChange={e => setStore(e.target.value)}><option value="">All stores</option>{stores.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></div>
        <Button type="submit" size="sm" variant="ghost"><Icon name="search" size={14} />Show</Button>
      </form>
      {currencies.size > 1 && <div className="mb-3"><Banner tone="warn">These stores price in different currencies ({[...currencies].join(', ')}). Compare prices only within the same currency.</Banner></div>}
      {list.loading && !list.data ? <Loading rows={2} /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : rows.length === 0 ? <Empty title="No products">{applied ? 'Nothing matches that word.' : 'Products appear after the first successful check.'}</Empty> : (
        <div className="table-wrap"><table className="dg-table"><caption className="sr-only">Products at watched stores</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Store</th><th scope="col">Price</th><th scope="col">Sale shown</th><th scope="col">Availability</th><th scope="col">Bestseller position</th><th scope="col">First seen</th><th scope="col"><span className="sr-only">History</span></th></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id}>
              <td className="ink break-words"><a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{r.title}</a>{!r.listed && <span className="text-grey-h"> (no longer listed)</span>}</td>
              <td>{r.store}</td><td className="whitespace-nowrap">{range(r.price_min, r.price_max, r.currency)}</td><td>{r.on_sale ? 'Yes' : 'No'}</td>
              <td>{r.availability_known ? `${r.available_count} of ${r.availability_known} variants shown available` : 'not shown'}</td>
              <td>{r.bestseller_rank ?? '—'}</td><td className="whitespace-nowrap">{r.in_baseline ? 'baseline' : fmtTime(r.first_seen_at)}</td>
              <td><button type="button" className="text-ink underline" onClick={() => onHistory(r.id)}>History</button></td>
            </tr>
          ))}</tbody></table></div>
      )}
      <p className="pt-2 text-[13px] text-grey-h">Availability is what the store&apos;s feed shows; it is not a stock count and not evidence of sales.</p>
    </Section>
  )
}

function HistorySheet({ agentId, productId, onClose }: { agentId: string; productId: string; onClose: () => void }) {
  const h = useLoad(() => storeFetch<History>(`/api/store/agents/${encodeURIComponent(agentId)}/competitors/products/${encodeURIComponent(productId)}`), productId)
  return (
    <Sheet open onClose={onClose} title="Price and availability history">
      {h.loading && !h.data ? <Loading rows={2} /> : h.error ? <ErrorState error={h.error} onRetry={h.reload} /> : h.data && (
        <div className="flex flex-col gap-3">
          <p className="text-[15px] text-ink break-words"><a href={h.data.product.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{h.data.product.title}</a> · {h.data.product.store}</p>
          <p className="text-[13px] text-grey-h">Each row is a state Deploi observed, from when it was first seen to when it was last confirmed. Gaps between checks are not observed.</p>
          <div className="table-wrap"><table className="dg-table"><caption className="sr-only">Observed history</caption>
            <thead><tr><th scope="col">From</th><th scope="col">Last confirmed</th><th scope="col">Price</th><th scope="col">Sale shown</th><th scope="col">Available</th><th scope="col">Bestseller</th></tr></thead>
            <tbody>{h.data.history.map((r, n) => (
              <tr key={n}><td className="whitespace-nowrap">{fmtTime(r.observed_at)}</td><td className="whitespace-nowrap">{fmtTime(r.last_confirmed_at)}</td><td className="whitespace-nowrap">{range(r.price_min, r.price_max, r.currency)}</td>
                <td>{r.on_sale ? 'Yes' : 'No'}</td><td>{r.availability_known ? `${r.available_count}/${r.availability_known}` : 'not shown'}</td><td>{r.bestseller_rank ?? '—'}</td></tr>
            ))}</tbody></table></div>
          {h.data.checks.some(c => c.outcome !== 'complete') && <p className="text-[13px] text-grey-h">Recent checks that were partial or failed: {h.data.checks.filter(c => c.outcome !== 'complete').length}. They are not read as changes.</p>}
        </div>
      )}
    </Sheet>
  )
}
