'use client'
/**
 * Billing (/store/billing): who bills this organization, the subscription state, the plan's limits, and
 * the buttons to subscribe (Stripe Checkout) or manage the subscription (Stripe customer portal).
 * Shopify App Store stores are billed by Shopify and are pointed there. While BILLING_MODE is off the
 * page says the private beta is free. Prices are shown only on Stripe's own checkout page.
 */
import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'

type Limits = { maxAgents: number; maxCompetitorStores: number; monthlyActions: number; monthlyEmails: number; officeSeats: number; officeConnections: number }
type BillingResp = {
  mode: 'off' | 'test' | 'live'; configured: boolean; hasPortal: boolean; pricingStatus: string
  billing: { provider: 'stripe' | 'shopify'; status: string; plan: string | null; readOnly: boolean; reason: string | null; graceEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }
  plan: { tier: string; label: string; priced: boolean; writesAllowed: boolean; limits: Limits }
  plans: { key: string; name: string; available: boolean }[]
}

export function BillingScreen() {
  const params = useSearchParams()
  const returned = params.get('checkout')
  const { data, error, loading, reload } = useLoad(() => storeFetch<BillingResp>('/api/billing'), 'billing')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const header = <PageHeader title="Billing" sub="Your subscription, what your plan includes, and where to change it." />
  if (loading && !data) return <>{header}<Loading label="Loading billing" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const b = data.billing
  async function go(path: string, body?: unknown, key = path) {
    setBusy(key); setNote(null)
    try { const r = await storeFetch<{ url: string }>(path, { method: 'POST', body: body ?? {} }); window.location.assign(r.url) }
    catch (e) { setNote(asApiError(e).message); setBusy(null) }
  }
  const l = data.plan.limits
  return (
    <>
      {header}
      {data.mode === 'test' && <div className="mb-4"><Banner tone="warn">Test mode: Stripe test cards only. Nothing is charged.</Banner></div>}
      {returned === 'success' && <div className="mb-4"><Banner tone="info" icon="check">Thanks. Your subscription starts as soon as Stripe confirms the payment (usually a few seconds).</Banner></div>}
      {note && <div className="mb-4" aria-live="polite"><Banner tone="warn">{note}</Banner></div>}
      {data.mode === 'off' ? (
        <section className="au-panel p-4"><p className="text-[14px]">The private beta is free. Nothing is charged and no payment details are needed. Paid plans start after the beta; you will see the price and agree to it before any charge.</p></section>
      ) : b.provider === 'shopify' ? (
        <section className="au-panel p-4"><p className="text-[14px]">Your store is billed through Shopify. Choose or change your plan in the Shopify admin (Apps → Deploi → plan), not here.</p></section>
      ) : (
        <section className="au-panel p-4" aria-label="Subscription">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={b.readOnly ? 'danger' : b.status === 'past_due' ? 'warn' : 'ok'}>{b.status === 'none' ? 'No subscription' : b.status.replace('_', ' ')}</Badge>
            {b.plan && <Badge tone="muted">{data.plans.find(p => p.key === b.plan)?.name ?? b.plan}</Badge>}
            {b.currentPeriodEnd && <span className="text-[13px] text-grey">{b.cancelAtPeriodEnd ? 'ends' : 'renews'} {b.currentPeriodEnd.slice(0, 10)}</span>}
          </div>
          {b.reason && <p className="mt-2 text-[14px]">{b.reason}</p>}
          {b.readOnly && <p className="mt-1 text-[13px] text-grey">Read-only: agents do not change your store or send email. Everything stays visible.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {['none', 'canceled', 'incomplete'].includes(b.status) && data.plans.map(p => (
              <Button key={p.key} type="button" size="sm" disabled={!p.available || !data.configured || busy !== null} onClick={() => go('/api/billing/checkout', { plan: p.key }, p.key)}>{busy === p.key ? 'Opening Stripe' : `Subscribe to ${p.name}`}</Button>
            ))}
            {data.hasPortal && <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => go('/api/billing/portal')}>{busy === '/api/billing/portal' ? 'Opening' : 'Manage subscription'}</Button>}
          </div>
          {!data.configured && <p className="mt-2 text-[13px] text-grey">Billing is not configured in this environment.</p>}
        </section>
      )}
      <section className="au-panel mt-4 p-4" aria-label="Plan limits">
        <h2 className="text-[1.05rem]">{data.plan.label}</h2>
        <dl className="au-kv mt-2">
          <dt>Agents</dt><dd>{l.maxAgents}</dd>
          <dt>Watched competitor stores</dt><dd>{l.maxCompetitorStores}</dd>
          <dt>Agent actions a month</dt><dd>{l.monthlyActions}</dd>
          <dt>Emails a month</dt><dd>{l.monthlyEmails}</dd>
          <dt>Office seats / connections</dt><dd>{l.officeSeats} / {l.officeConnections}</dd>
        </dl>
      </section>
    </>
  )
}
