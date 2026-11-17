'use client'
/**
 * Plan inside the Shopify admin (/shopify/plan, shown only while BILLING_REQUIRED is on). Shopify App Pricing
 * hosts plan selection: the merchant upgrades, downgrades or cancels on Shopify's own plan page, opened at
 * the top of the admin (never in the app frame, never an external checkout). Coming back with plan_handle
 * re-reads the subscription from Shopify.
 */
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { storeFetch } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, NoStore, Panel, useStore } from './bits'
import type { BillingResponse, OverviewResponse } from './types'

export function ShopifyPlanScreen() {
  const { embedded } = useStore()
  const returned = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('plan_handle')
  const { data, error, loading, reload } = useLoad(async () => {
    const o = await storeFetch<OverviewResponse>('/api/store/overview')
    const conn = o.connections.find(c => c.platform === 'shopify' && c.status === 'active') ?? null
    const b = conn ? await storeFetch<BillingResponse>(`/api/store/billing?connection=${encodeURIComponent(conn.id)}${returned ? '&refresh=1' : ''}`) : null
    return { o, billing: b?.billing ?? null }
  }, 'shopify-plan')
  const header = <PageHeader title="Plan" sub="Your Deploi plan is billed by Shopify, on your Shopify invoice. Change or cancel it on Shopify's plan page at any time." />
  if (loading && !data) return <>{header}<Loading label="Loading your plan" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  if (!data.billing) return <>{header}<NoStore /></>
  const b = data.billing
  const canAct = data.o.actor.canApprove
  return (
    <>
      {header}
      {returned && <div className="mb-4"><Banner icon="check">Back from Shopify&apos;s plan page. Your plan was re-read from Shopify.</Banner></div>}
      {b.checkFailed && <div className="mb-4"><Banner tone="warn">We could not reach Shopify to check your plan just now; try again shortly.</Banner></div>}
      <Panel>
        <Facts items={[
          ['Plan', b.active && b.planHandle ? <Badge key="p" tone="ok">{b.planHandle}</Badge> : <Badge key="p" tone="warn">No plan chosen</Badge>],
          ['Billed by', 'Shopify (App Pricing)'],
          ['Without a plan', 'Scans, issues and drafts keep working; changes to your store wait until you choose a plan.'],
        ]} />
        {canAct && b.plansUrl && embedded && (
          <div className="mt-4"><Button size="sm" type="button" onClick={() => window.open(b.plansUrl!, '_top')}>{b.active ? 'Change plan in Shopify' : 'Choose a plan in Shopify'}</Button></div>
        )}
        {!b.plansUrl && <p className="mt-3 text-[14px] text-grey-h">This store has no Shopify plan page (a demo store, or the app handle is not configured).</p>}
      </Panel>
    </>
  )
}
