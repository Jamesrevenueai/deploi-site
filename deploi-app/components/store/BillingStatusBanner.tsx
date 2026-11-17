'use client'
/**
 * The in-app billing banner for Stripe-billed organizations: payment failed (with the grace date), read-only
 * after the grace period or an ended subscription, a trial ending within three days, or a cancellation
 * scheduled. The words come from the server (lib/billing/messages.ts billingBanner); nothing shows while
 * billing is off, for Shopify-billed stores (they have BillingBanner) or on the billing page itself.
 */
import { usePathname } from 'next/navigation'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { storeFetch } from './api'
import { useLoad } from './useLoad'

type Resp = { banner: { tone: 'warn' | 'danger' | 'info'; message: string; cta: string } | null }

export function BillingStatusBanner() {
  const path = usePathname()
  const { data } = useLoad(() => storeFetch<Resp>('/api/billing/status'), 'billing-status')
  const b = data?.banner
  if (!b || path?.startsWith('/store/billing')) return null
  return (
    <div className="mb-4" data-testid="billing-banner">
      <Banner tone={b.tone === 'info' ? 'info' : 'warn'} icon={b.tone === 'info' ? 'calendar' : 'alert'}>
        {b.message}
        <div className="mt-2"><Button size="xs" href="/store/billing">{b.cta}</Button></div>
      </Banner>
    </div>
  )
}
