'use client'
/**
 * Plan banner. Shown only when billing is required and the store has no active plan. Plans are
 * chosen on Shopify's own plan page (Shopify App Pricing), opened at the top level of the admin,
 * never inside the app frame. After the plan page redirects back with plan_handle, the plan is re-read.
 */
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { storeFetch } from './api'
import { useLoad } from './useLoad'
import type { BillingResponse } from './types'

export function BillingBanner({ connectionId, canAct }: { connectionId: string; canAct: boolean }) {
  const returned = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('plan_handle')
  const { data } = useLoad(() => storeFetch<BillingResponse>(`/api/store/billing?connection=${encodeURIComponent(connectionId)}${returned ? '&refresh=1' : ''}`), `billing:${connectionId}`)
  const b = data?.billing
  if (!b || !b.required || b.active) return null
  return (
    <div className="mb-6">
      <Banner tone="warn">
        <strong>Choose a plan to let Deploi make changes.</strong> Scans and reviews keep working. Plans and billing are handled by Shopify; you can change or cancel your plan there at any time.
        {b.checkFailed && <> We could not reach Shopify to check your plan just now; try again shortly.</>}
        {canAct && b.plansUrl && (
          <div className="mt-3">
            <Button size="sm" type="button" onClick={() => window.open(b.plansUrl!, '_top')}>View plans in Shopify</Button>
          </div>
        )}
      </Banner>
    </div>
  )
}
