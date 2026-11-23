'use client'
/**
 * Plan and billing (/store/plan): the published plans from lib/pricing/catalog.json — the same numbers as getdeploi.com
 * and the Shopify listing. Store plans are billed through Shopify (Billing API, usage charges up to the cap you set);
 * Office plans through Stripe (optional setup, 20% off with a Store plan). Monthly or yearly (2 months free). This
 * month's metered usage and the overage cap are the server's (GET/POST /api/billing/cap).
 */
import { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, useStore } from '@/components/store/bits'
import { css } from '@/components/dp/css'
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/dp/bits'
import { CATALOG, STORE_PLANS, OFFICE_PLANS, dollars, priceCents, officePriceCents, setupFeeCents, type Interval, type PlanKey } from '@/lib/pricing'
import type { UsageState } from '@/lib/metering'
import type { PlanResponse } from './types'

type CapResponse = { ok: true; usage: UsageState; pending: { kind: string; amountCents: number }[] }
type Suite = 'store' | 'office'

const CARD = 'border: 1px solid #E0E7FF; border-radius: 18px; padding: 24px; display: flex; flex-direction: column; gap: 12px; background: #FFFFFF;'
const SEG = 'min-height: 44px; padding: 0 16px; border-radius: 10px; border: 0; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer;'
const n = (v: number) => v.toLocaleString('en-US')

export function PlanScreen() {
  const { base } = useStore()
  const params = useSearchParams()
  const highlight = params.get('upgrade')
  const [suite, setSuite] = useState<Suite>(params.get('suite') === 'office' ? 'office' : 'store')
  const [interval, setPeriod] = useState<Interval>('month')
  const [capUsd, setCapUsd] = useState('50')
  const [setup, setSetup] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const plan = useLoad(() => storeFetch<PlanResponse>('/api/store/plan'), 'plan')
  const usage = useLoad(() => storeFetch<CapResponse>('/api/billing/cap').catch(() => null), 'plan-usage')

  const header = (
    <header style={css('display: flex; flex-direction: column; gap: 6px; max-width: 680px;')}>
      <span style={css('font-size: 13px; font-weight: 600; color: #4F46E5;')}>Plan and billing</span>
      <h1 style={css('margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.025em; color: #1E1B4B;')}>Plans</h1>
      <p style={css('margin: 0; font-size: 15px; line-height: 1.55; color: #3730A3;')}>One monthly fee with a bundle of agent actions included. Need more? Add them as you go — you set a spending cap.</p>
    </header>
  )
  if (plan.loading && !plan.data) return <div style={css('display: flex; flex-direction: column; gap: 24px;')}>{header}<Loading label="Loading plans" /></div>
  if (plan.error && !plan.data) return <div style={css('display: flex; flex-direction: column; gap: 24px;')}>{header}<ErrorState error={plan.error} onRetry={plan.reload} /></div>
  const current = usage.data?.usage.plan ?? plan.data?.usage.tier ?? null

  async function subscribe(key: PlanKey) {
    setBusy(key); setNote(null)
    try {
      const body = suite === 'store' ? { plan: key, interval, capCents: Math.round(Number(capUsd) * 100) } : { plan: key, interval, setup }
      const r = await storeFetch<{ url: string | null }>('/api/billing/subscribe', { method: 'POST', body })
      if (r.url) window.location.assign(r.url)
      else setNote({ tone: 'ok', text: 'Started. Approve it on the next page.' })
    } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }
  async function saveCap(e: React.FormEvent) {
    e.preventDefault(); setBusy('cap'); setNote(null)
    try { await storeFetch('/api/billing/cap', { method: 'POST', body: { actionCapCents: Math.round(Number(capUsd) * 100) } }); setNote({ tone: 'ok', text: `Overage cap saved: up to $${Number(capUsd).toFixed(0)} a month.` }); await usage.reload() }
    catch (err) { setNote({ tone: 'warn', text: asApiError(err).message }) } finally { setBusy(null) }
  }

  const u = usage.data?.usage
  const plans = suite === 'store'
    ? STORE_PLANS.map(p => ({ key: p.key as PlanKey, name: p.name, cents: priceCents(p.key, interval), lines: [`${n(p.actions)} actions / month`, `${p.agents.length} agents`, p.customAgents === null ? 'Unlimited custom agents' : `${p.customAgents} custom agent${p.customAgents === 1 ? '' : 's'}`, p.stores === null ? 'Multiple stores' : '1 store'] }))
    : OFFICE_PLANS.map(p => ({ key: p.key as PlanKey, name: p.name, cents: officePriceCents(p.key, interval, false), lines: [`${n(p.actions)} actions / month`, `${n(p.texts)} texts / month`, p.crew === null ? 'Unlimited crew' : p.crew ? `Up to ${p.crew} crew` : 'Just you', p.customAgents === null ? 'Unlimited custom agents' : `${p.customAgents} custom agent${p.customAgents === 1 ? '' : 's'}`, setupFeeCents(p.key) ? `Optional setup ${dollars(setupFeeCents(p.key))}` : 'Setup included'] }))

  return (
    <div style={css('display: flex; flex-direction: column; gap: 24px; min-width: 0;')} data-testid="plan-screen">
      {header}
      <div aria-live="polite">{note && <p role={note.tone === 'warn' ? 'alert' : 'status'} style={css(`margin: 0; padding: 12px 16px; border-radius: 12px; font-size: 14px; font-weight: 600; background: ${note.tone === 'ok' ? '#EEF2FF' : '#FFF1EB'}; color: ${note.tone === 'ok' ? '#312E81' : '#9A3412'};`)}>{note.text}</p>}</div>

      {u && (
        <section aria-labelledby="usage-h" style={css(CARD)} data-testid="metered-usage">
          <h2 id="usage-h" style={css('margin: 0; font-size: 17px; font-weight: 800; color: #1E1B4B;')}>This month</h2>
          <p style={css('margin: 0; font-size: 14px; color: #3730A3;')}>{n(u.actions.used)} of {n(u.actions.included)} actions used{u.actions.overage ? ` · ${n(u.actions.overage)} over` : ''}{u.texts ? ` · ${n(u.texts.used)} of ${n(u.texts.included)} texts` : ''}. Watching, scanning and checking are free.</p>
          <form onSubmit={saveCap} style={css('display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px;')}>
            <label style={css('display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 700; color: #1E1B4B;')}>Monthly overage cap (USD)
              <input type="number" min={0} step={5} value={capUsd} onChange={e => setCapUsd(e.target.value)} style={css('min-height: 44px; width: 160px; padding: 0 12px; border: 1px solid #C7D2FE; border-radius: 12px; font: inherit; font-size: 14px;')} />
            </label>
            <button type="submit" className="dp-btn" disabled={busy !== null} style={css(BTN_SECONDARY)}>{busy === 'cap' ? 'Saving…' : 'Save cap'}</button>
            <span style={css('font-size: 13px; color: #3730A3;')}>At the cap, non-urgent work pauses and you are told. Replies to waiting customers still go out.</span>
          </form>
        </section>
      )}

      <div style={css('display: flex; flex-wrap: wrap; gap: 12px; align-items: center;')}>
        <div role="group" aria-label="Which side" style={css('display: inline-flex; gap: 4px; padding: 4px; border: 1px solid #E0E7FF; border-radius: 14px;')}>
          {(['store', 'office'] as Suite[]).map(s => <button key={s} type="button" aria-pressed={suite === s} onClick={() => setSuite(s)} style={css(SEG + (suite === s ? 'background: #4F46E5; color: #FFFFFF;' : 'background: transparent; color: #3730A3;'))}>{s === 'store' ? 'Store · Shopify' : 'Office'}</button>)}
        </div>
        <div role="group" aria-label="Billing period" style={css('display: inline-flex; gap: 4px; padding: 4px; border: 1px solid #E0E7FF; border-radius: 14px;')}>
          {(['month', 'year'] as Interval[]).map(i => <button key={i} type="button" aria-pressed={interval === i} onClick={() => setPeriod(i)} style={css(SEG + (interval === i ? 'background: #4F46E5; color: #FFFFFF;' : 'background: transparent; color: #3730A3;'))}>{i === 'month' ? 'Monthly' : 'Yearly · 2 months free'}</button>)}
        </div>
        {suite === 'office' && <label style={css('display: inline-flex; align-items: center; gap: 8px; min-height: 44px; font-size: 14px; color: #1E1B4B;')}><input type="checkbox" checked={setup} onChange={e => setSetup(e.target.checked)} style={css('width: 20px; height: 20px;')} />Add done-with-you setup ({dollars(CATALOG.office.setup.priceCents)}, Solo and Team)</label>}
      </div>

      <section aria-label={suite === 'store' ? 'Store plans' : 'Office plans'} style={css('display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 16px;')}>
        {plans.map(p => (
          <article key={p.key} data-plan={p.key} style={css(CARD + (highlight === p.key || p.key === 'growth' || p.key === 'team' ? ' border: 2px solid #4F46E5;' : ''))}>
            <div style={css('display: flex; justify-content: space-between; align-items: center; gap: 8px;')}>
              <h2 style={css('margin: 0; font-size: 20px; font-weight: 800; color: #1E1B4B;')}>{p.name}</h2>
              {current === p.key && <span style={css('font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #EEF2FF; color: #3730A3;')}>Your plan</span>}
            </div>
            <p style={css('margin: 0; display: flex; align-items: baseline; gap: 6px;')}><span style={css('font-size: 40px; font-weight: 800; letter-spacing: -0.03em; color: #1E1B4B;')} data-testid="plan-price">{dollars(p.cents)}</span><span style={css('font-size: 15px; font-weight: 600; color: #4F46E5;')}>/ {interval}</span></p>
            <ul style={css('margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: #3730A3;')}>{p.lines.map(l => <li key={l}>✓ {l}</li>)}</ul>
            <button type="button" className="dp-btn" onClick={() => void subscribe(p.key)} disabled={busy !== null || current === p.key} style={css(BTN_PRIMARY + ' justify-content: center; margin-top: auto;')}>{busy === p.key ? 'Starting…' : current === p.key ? 'Current plan' : 'Start 14-day free trial'}</button>
          </article>
        ))}
      </section>
      <p style={css('margin: 0; font-size: 13px; line-height: 1.55; color: #3730A3;')}>
        {suite === 'store'
          ? <>Billed through Shopify. Extra actions: {dollars(CATALOG.store.overage.priceCents)} per {CATALOG.store.overage.unitActions} as a Shopify usage charge, up to the cap you approve. Yearly plans have no usage charges: work pauses at the allowance.</>
          : <>Billed by card through Stripe. Extra actions {dollars(CATALOG.office.overage.actionPriceCents)} per {CATALOG.office.overage.unitActions}, extra texts {dollars(CATALOG.office.overage.textPriceCents)} per {CATALOG.office.overage.unitTexts}, up to your cap. {CATALOG.office.bundleDiscountPercent}% off Office with a Store plan.</>}
        {' '}<Link href={`${base}/team`} style={css('color: #4F46E5; font-weight: 700;')}>Back to the agent library</Link>
      </p>
    </div>
  )
}
