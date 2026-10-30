'use client'
/**
 * Setting up a Competitor & Trend Watcher: name, competitor store addresses (validated, and checked
 * on request), keywords, how often, which alerts, and an optional email summary. Explains exactly
 * which sources Deploi can read and what it can never know. Nothing is granted here.
 */
import { useId, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input, Textarea } from '@/components/ui/Field'
import { normalizeStoreUrl, MAX_COMPETITOR_STORES } from '@/lib/competitors/url'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { ErrorState, Panel } from './bits'
import { COMPETITOR_ALERTS, COMPETITOR_ALERT_WORDS, templateToolWords, type CompetitorAlertKey } from './format'
import { isEmailAddress } from './AgentForm'
import type { AgentTemplateView } from './types'

export type CompetitorSetupInput = { name: string; notify: string; supplierAddress: string; connectionId: string
  competitor: { stores: string[]; keywords: string[]; cadence: 'daily' | 'weekly'; alerts: CompetitorAlertKey[]; minPriceChangePct: number; emailSummary: boolean } }
type Probe = { status: 'supported' | 'unsupported' | 'blocked_robots' | 'unreachable'; reason: string }
type CheckResponse = { ok: true; stores: ({ input: string; ok: true; url: string; host: string; probe: Probe | null } | { input: string; ok: false; reason: string; probe: null })[] }

const PROBE_WORDS: Record<Probe['status'], { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  supported: { label: 'Can be monitored', tone: 'ok' },
  unsupported: { label: 'Not supported', tone: 'warn' },
  blocked_robots: { label: 'Asks not to be read (robots.txt)', tone: 'warn' },
  unreachable: { label: 'Could not be reached', tone: 'warn' },
}

const lines = (s: string) => [...new Set(s.split(/[\n,]/).map(x => x.trim()).filter(Boolean))]

export function SupportedSources() {
  return (
    <div className="rounded-[14px] border border-line p-4 text-[14px] text-grey">
      <h3 className="text-[1rem] text-ink">What Deploi can read</h3>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        <li><span className="text-ink">Shopify storefronts</span> that publish Shopify&rsquo;s public product feed, which most do: products, prices, &ldquo;was&rdquo; prices shown as discounts, and whether each product can be bought.</li>
        <li>The store&rsquo;s own public collections it names as <span className="text-ink">best sellers, featured, new or on sale</span>, in the order the store chooses to show them.</li>
        <li>Other platforms are <span className="text-ink">not supported yet</span>. Deploi tells you and checks nothing; it never guesses from page layouts.</li>
      </ul>
      <h3 className="mt-3 text-[1rem] text-ink">How it reads them</h3>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        <li>The competitor installs nothing. Deploi reads the same public pages any visitor can see, follows each store&rsquo;s robots.txt, and sends at most one request per second to a store.</li>
        <li>It never logs in, buys, fills in forms or contacts the store, and never gets around a block.</li>
      </ul>
      <h3 className="mt-3 text-[1rem] text-ink">What it can never tell you</h3>
      <p className="mt-1">Another store&rsquo;s sales, revenue, units sold, conversion rate or exact sales ranking. Your own Shopify connection does not show other merchants&rsquo; data. A best-seller collection is the order the store chooses to display, not a measured ranking.</p>
    </div>
  )
}

export function CompetitorStart({ template, connectionId, busy, onCreate }: { template: AgentTemplateView; connectionId: string; busy: boolean; onCreate: (input: CompetitorSetupInput) => void }) {
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const [name, setName] = useState(template.name)
  const [storesText, setStoresText] = useState('')
  const [keywords, setKeywords] = useState('')
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily')
  const [alerts, setAlerts] = useState<Record<CompetitorAlertKey, boolean>>(() => Object.fromEntries(COMPETITOR_ALERTS.map(a => [a, true])) as Record<CompetitorAlertKey, boolean>)
  const [minPct, setMinPct] = useState('5')
  const [emailSummary, setEmailSummary] = useState(false)
  const [notify, setNotify] = useState('')
  const [checked, setChecked] = useState<CheckResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [err, setErr] = useState<StoreApiError | null>(null)

  const entries = useMemo(() => lines(storesText).map(raw => ({ raw, n: normalizeStoreUrl(raw) })), [storesText])
  const valid = entries.filter(e => e.n.ok)
  const invalid = entries.filter(e => !e.n.ok)
  const chosenAlerts = COMPETITOR_ALERTS.filter(a => alerts[a])
  const pct = Number(minPct)
  const problems = [
    ...(!name.trim() ? ['Give the agent a name.'] : []),
    ...(!valid.length ? ['Add at least one competitor store address.'] : []),
    ...(entries.length > MAX_COMPETITOR_STORES ? [`At most ${MAX_COMPETITOR_STORES} stores.`] : []),
    ...invalid.map(e => `${e.raw}: ${!e.n.ok ? e.n.reason : ''}.`),
    ...(!chosenAlerts.length ? ['Choose at least one kind of alert.'] : []),
    ...(!(minPct.trim() && pct >= 0 && pct <= 100) ? ['The smallest price change must be a number from 0 to 100 (%).'] : []),
    ...(emailSummary && !isEmailAddress(notify.trim().toLowerCase()) ? ['Enter the email address for summaries, or turn the summary off.'] : []),
  ]

  async function check() {
    setChecking(true); setErr(null)
    try { setChecked(await storeFetch<CheckResponse>('/api/store/competitors/check', { method: 'POST', body: { urls: entries.map(e => e.raw).slice(0, MAX_COMPETITOR_STORES), probe: true } })) }
    catch (e) { setErr(asApiError(e)) } finally { setChecking(false) }
  }

  return (
    <Panel>
      <form className="flex flex-col gap-5" onSubmit={e => { e.preventDefault(); if (!problems.length) onCreate({ name: name.trim(), notify: emailSummary ? notify.trim() : '', supplierAddress: '', connectionId,
        competitor: { stores: valid.map(v => (v.n.ok ? v.n.url : '')), keywords: lines(keywords).map(k => k.toLowerCase()), cadence, alerts: chosenAlerts, minPriceChangePct: pct, emailSummary } }) }}>
        <div className="flex flex-wrap items-center gap-2"><Badge tone="muted">Template</Badge><h2 className="text-[1.1rem]">{template.name}</h2></div>
        <p className="text-[15px] text-grey">&ldquo;{template.job}&rdquo;</p>
        <div className="flex flex-wrap gap-2">{template.tools.map(x => <Badge key={x} tone="muted">{templateToolWords(x, { optionalEmail: true })}</Badge>)}</div>

        <div className="flex flex-col gap-1">
          <label htmlFor={id('name')} className="text-[14px] text-grey">Agent name</label>
          <Input id={id('name')} value={name} maxLength={80} onChange={e => setName(e.target.value)} />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] text-grey">Competitor stores (up to {MAX_COMPETITOR_STORES})</legend>
          <Textarea id={id('stores')} aria-label="Competitor store addresses, one per line" rows={4} value={storesText} placeholder={'competitor-one.com\nhttps://www.competitor-two.com'} onChange={e => { setStoresText(e.target.value); setChecked(null) }} aria-describedby={id('stores-hint')} />
          <span id={id('stores-hint')} className="text-[13px] text-grey-h">One per line. Any page of the store works; Deploi keeps just the store&rsquo;s address. Use web addresses only: no IP addresses or private sites.</span>
          {entries.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label="Store addresses as Deploi reads them">
              {entries.map(e => {
                const c = checked?.stores.find(s => s.input === e.raw)
                return (
                  <li key={e.raw} className="flex flex-wrap items-center gap-2 text-[14px]">
                    {e.n.ok ? <span className="break-all text-ink">{e.n.host}</span> : <span className="break-all text-grey">{e.raw}</span>}
                    {!e.n.ok ? <Badge tone="warn">Not valid: {e.n.reason}</Badge>
                      : c?.probe ? <><Badge tone={PROBE_WORDS[c.probe.status].tone}>{PROBE_WORDS[c.probe.status].label}</Badge><span className="text-[13px] text-grey-h">{c.probe.reason}</span></>
                      : <Badge tone="muted">Valid address</Badge>}
                  </li>
                )
              })}
            </ul>
          )}
          <div><Button type="button" size="sm" variant="ghost" onClick={check} disabled={!valid.length || checking || busy}><Icon name="search" size={15} />{checking ? 'Checking…' : 'Check these stores'}</Button></div>
          {err && <ErrorState error={err} />}
          <p className="text-[13px] text-grey-h">Checking reads each store&rsquo;s robots.txt and one product from its public feed. Stores that cannot be monitored can still be listed: they are reported as skipped and never read.</p>
        </fieldset>

        <SupportedSources />

        <div className="flex flex-col gap-1">
          <label htmlFor={id('keywords')} className="text-[14px] text-grey">Categories or keywords to focus on (optional)</label>
          <Input id={id('keywords')} value={keywords} placeholder="e.g. linen, kitchen, candles" onChange={e => setKeywords(e.target.value)} aria-describedby={id('kw-hint')} />
          <span id={id('kw-hint')} className="text-[13px] text-grey-h">Comma separated. Only products whose name, type or tags mention one of these are recorded. Leave empty to watch every product.</span>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] text-grey">How often</legend>
          {(['daily', 'weekly'] as const).map(c => (
            <label key={c} className="flex cursor-pointer items-center gap-3 text-[15px] text-ink">
              <input type="radio" name={id('cadence')} className="h-5 w-5 accent-white" checked={cadence === c} onChange={() => setCadence(c)} />
              {c === 'daily' ? 'Every day (early morning, your store’s time zone)' : 'Once a week'}
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] text-grey">Alert me about</legend>
          {COMPETITOR_ALERTS.map(a => (
            <label key={a} className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
              <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={alerts[a]} onChange={e => setAlerts({ ...alerts, [a]: e.target.checked })} />
              <span>{COMPETITOR_ALERT_WORDS[a]}</span>
            </label>
          ))}
          {alerts.price_changes && (
            <div className="flex flex-wrap items-center gap-2 pl-8 text-[14px] text-grey">
              <label htmlFor={id('pct')}>Ignore price changes smaller than</label>
              <span className="w-20"><Input id={id('pct')} inputMode="decimal" value={minPct} onChange={e => setMinPct(e.target.value)} /></span>%
            </div>
          )}
          <p className="text-[13px] text-grey-h">Alerts appear in Deploi: on this agent&rsquo;s page, and as a count on the Agents page. The first check only records a starting point, so nothing on it is reported as new.</p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] text-grey">Email summary (optional)</legend>
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={emailSummary} onChange={e => setEmailSummary(e.target.checked)} />
            <span>Also write me a summary after each check<span className="block text-[13px] text-grey-h">From the agent&rsquo;s own address. It starts as a draft you can read; sending needs a wider permission and a new grant.</span></span>
          </label>
          {emailSummary && (
            <div className="flex flex-col gap-1 pl-8">
              <label htmlFor={id('notify')} className="text-[14px] text-grey">Your email address (the only address it may write to)</label>
              <Input id={id('notify')} type="email" value={notify} placeholder="you@your-store.com" onChange={e => setNotify(e.target.value)} />
            </div>
          )}
        </fieldset>

        {problems.length > 0 && entries.length > 0 && <Banner tone="warn"><strong>Before you continue:</strong><ul className="mt-1 list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul></Banner>}
        <p className="text-[13px] text-grey-h">Nothing is granted yet. Next you read exactly what this agent may do, then grant it. It can never change your store.</p>
        <div><Button type="submit" disabled={problems.length > 0 || busy}><Icon name="shield" size={16} />{busy ? 'Preparing…' : 'Review authorization'}</Button></div>
      </form>
    </Panel>
  )
}
