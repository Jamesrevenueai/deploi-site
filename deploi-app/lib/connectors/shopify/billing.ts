/**
 * Billing for App Store apps must go through Shopify. Shopify App Pricing (formerly Managed Pricing)
 * is the default for new public apps: plans are defined in the Partner Dashboard, Shopify hosts the
 * plan-selection page, and the app never creates charges itself (no appSubscriptionCreate).
 * Subscription status is read from the Partner API `activeSubscription(appId, shopId)`, which returns
 * null when the shop has no active subscription. App Pricing sends no webhooks for subscription
 * changes (since 2026-04-28), so status is re-read when the merchant opens the app, after the plan
 * page redirects back (plan_handle), and at most every few minutes otherwise.
 * Not live yet: no plans or prices have been decided and no Partner API token exists, so
 * BILLING_REQUIRED stays false and nothing is charged. See docs/platform-research/shopify-app-store.md §6.
 */
import type { Db } from '../../db'
import { audit } from '../../engine/audit'
import { assertApprovedHost } from '../../net/outbound'

const e = (k: string) => (process.env[k] ?? '').trim()

export const billingConfig = {
  /** the app handle from the Partner Dashboard (used in the hosted plan page URL) */
  get appHandle() { return e('SHOPIFY_APP_HANDLE') },
  /** the number in the Partner Dashboard URL (not the Dev Dashboard organization id) */
  get partnerId() { return e('SHOPIFY_PARTNER_ID') },
  /** the app's numeric id; used as gid://shopify/App/<id> */
  get partnerAppId() { return e('SHOPIFY_PARTNER_APP_ID') },
  get partnerApiVersion() { return e('SHOPIFY_PARTNER_API_VERSION') || '2026-10' },
  get partnerApiConfigured() { return Boolean(e('SHOPIFY_PARTNER_API_TOKEN') && /^\d+$/.test(this.partnerId) && /^\d+$/.test(this.partnerAppId)) },
  /** confirmed subscriptions are re-read at most this often */
  cacheMs: 5 * 60e3,
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

export type ActiveSubscription = { planHandle: string; trialEndsAt: string | null; periodEnd: string | null; cancelAtEndOfCycle: boolean }

const Q_ACTIVE_SUBSCRIPTION = /* GraphQL */ `
  query DeploiActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle { endTime }
      items { handle }
    }
  }
`

/** Partner API: the shop's active App Pricing subscription, or null when it has none. */
export async function fetchActiveSubscription(shopGid: string, fetchImpl: typeof fetch = fetch): Promise<ActiveSubscription | null> {
  if (!billingConfig.partnerApiConfigured) throw new Error('Partner API is not configured')
  if (!/^gid:\/\/shopify\/Shop\/\d+$/.test(shopGid)) throw new Error('invalid shop id')
  const url = `https://partners.shopify.com/${billingConfig.partnerId}/api/${billingConfig.partnerApiVersion}/graphql.json`
  assertApprovedHost(url, 'shopify_partners')
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': e('SHOPIFY_PARTNER_API_TOKEN') },
    body: JSON.stringify({ query: Q_ACTIVE_SUBSCRIPTION, variables: { appId: `gid://shopify/App/${billingConfig.partnerAppId}`, shopId: shopGid } }),
  })
  if (!res.ok) throw new Error(`Partner API request failed: HTTP ${res.status}`)
  const json = await res.json() as { data?: { activeSubscription?: { cancelAtEndOfCycle?: boolean; trialEndsAt?: string | null; currentBillingCycle?: { endTime?: string } | null; items?: { handle?: string }[] } | null }; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(`Partner API error: ${json.errors[0].message.slice(0, 160)}`)
  const sub = json.data?.activeSubscription
  if (!sub) return null
  return { planHandle: sub.items?.find(i => i.handle)?.handle ?? 'unknown', trialEndsAt: sub.trialEndsAt ?? null, periodEnd: sub.currentBillingCycle?.endTime ?? null, cancelAtEndOfCycle: Boolean(sub.cancelAtEndOfCycle) }
}

type SubConn = { id: string; org_id: string; external_id: string; shop_gid: string | null; is_synthetic: boolean }

/**
 * Re-read the shop's subscription from the Partner API and record it (one App Pricing record per
 * shop). Skipped while a confirmed active record is younger than the cache window, unless forced.
 */
export async function syncSubscription(db: Db, conn: SubConn, opts: { force?: boolean; fetchImpl?: typeof fetch; actor?: string } = {}): Promise<{ active: boolean; planHandle: string | null; checked: boolean }> {
  const externalId = `app_pricing:${conn.external_id}`
  const existing = await db.one<{ status: string; plan_key: string; updated_at: string }>(`select status, plan_key, updated_at from app_subscriptions where provider = 'shopify_billing' and external_id = $1`, [externalId])
  if (!opts.force && existing?.status === 'active' && Date.now() - new Date(existing.updated_at).getTime() < billingConfig.cacheMs) return { active: true, planHandle: existing.plan_key, checked: false }
  if (conn.is_synthetic || !conn.shop_gid || !billingConfig.partnerApiConfigured) return { active: existing?.status === 'active', planHandle: existing?.plan_key ?? null, checked: false }
  const sub = await fetchActiveSubscription(conn.shop_gid, opts.fetchImpl)
  if (!sub && !existing) return { active: false, planHandle: null, checked: true }
  await recordSubscription(db, {
    orgId: conn.org_id, connectionId: conn.id, externalId, planKey: sub?.planHandle ?? existing!.plan_key,
    status: sub ? 'ACTIVE' : 'CANCELLED', isTest: false, currentPeriodEnd: sub?.periodEnd ?? null, actor: opts.actor ?? 'system:billing-sync',
  })
  await db.query(`update app_subscriptions set updated_at = now() where provider = 'shopify_billing' and external_id = $1`, [externalId])
  return { active: Boolean(sub), planHandle: sub?.planHandle ?? null, checked: true }
}
