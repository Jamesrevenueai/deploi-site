/**
 * Billing for App Store apps must go through Shopify. Shopify App Pricing (formerly Managed Pricing)
 * is the default for new public apps: plans are defined in the Partner Dashboard, Shopify hosts the
 * plan-selection page, and subscription status is read from the Partner API (activeSubscription).
 * App Pricing sends no APP_SUBSCRIPTIONS_UPDATE webhooks (since 2026-04-28), so status is polled.
 * Not live here: no plans or prices have been decided, and no Partner API credentials exist. Until
 * then every merchant runs under an "early_access" record and BILLING_REQUIRED stays false.
 * See docs/platform-research/shopify.md section 10.
 */
import type { Db } from '../../db'
import { audit } from '../../engine/audit'

const e = (k: string) => (process.env[k] ?? '').trim()

export const billingConfig = {
  /** the app handle from the Partner Dashboard (used in the hosted plan page URL) */
  get appHandle() { return e('SHOPIFY_APP_HANDLE') },
  get partnerApiConfigured() { return Boolean(e('SHOPIFY_PARTNER_API_TOKEN') && e('SHOPIFY_PARTNER_ORG_ID') && e('SHOPIFY_PARTNER_APP_ID')) },
}

/** The Shopify-hosted plan selection page for a shop. */
export function pricingPlansUrl(shopDomain: string, appHandle = billingConfig.appHandle): string | null {
  const store = shopDomain.replace(/\.myshopify\.com$/, '')
  if (!appHandle || !/^[a-z0-9][a-z0-9-]*$/.test(store)) return null
  return `https://admin.shopify.com/store/${store}/charges/${encodeURIComponent(appHandle)}/pricing_plans`
}

export type ShopifySubscriptionStatus = 'ACTIVE' | 'PENDING' | 'DECLINED' | 'EXPIRED' | 'FROZEN' | 'CANCELLED' | 'ACCEPTED'

/** Map Shopify subscription status to ours. */
export function mapStatus(s: string): 'pending' | 'active' | 'declined' | 'expired' | 'frozen' | 'cancelled' {
  switch (s.toUpperCase()) {
    case 'ACTIVE': return 'active'
    case 'ACCEPTED': case 'PENDING': return 'pending'
    case 'DECLINED': return 'declined'
    case 'EXPIRED': return 'expired'
    case 'FROZEN': return 'frozen'
    default: return 'cancelled'
  }
}

/** Record a subscription state read from Shopify (Partner API poll or legacy Billing API). */
export async function recordSubscription(db: Db, input: { orgId: string; connectionId: string; externalId: string; planKey: string; status: string; isTest: boolean; currentPeriodEnd?: string | null; actor: string }) {
  const status = mapStatus(input.status)
  await db.query(
    `insert into app_subscriptions (org_id, connection_id, provider, plan_key, status, external_id, is_test, current_period_end)
     values ($1,$2,'shopify_billing',$3,$4,$5,$6,$7)
     on conflict (provider, external_id) where external_id is not null do update set plan_key = excluded.plan_key, status = excluded.status, is_test = excluded.is_test, current_period_end = excluded.current_period_end`,
    [input.orgId, input.connectionId, input.planKey, status, input.externalId, input.isTest, input.currentPeriodEnd ?? null])
  if (status === 'active') await db.query(`update app_subscriptions set status = 'cancelled' where connection_id = $1 and provider = 'early_access' and status = 'active'`, [input.connectionId])
  await audit(db, { orgId: input.orgId, connectionId: input.connectionId, entityType: 'subscription', entityId: input.externalId, event: `subscription.${status}`, actor: input.actor, detail: { plan_key: input.planKey, is_test: input.isTest } })
}
