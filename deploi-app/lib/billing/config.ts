/**
 * Stripe subscription billing for customers who are NOT billed through Shopify (WooCommerce stores and
 * Deploi Office). Shopify App Store merchants must keep paying through Shopify (lib/connectors/shopify/billing.ts);
 * lib/billing/provider.ts routes them there.
 *
 *   BILLING_MODE                 off (default: the free beta, nothing is charged or checked) | test | live
 *   STRIPE_SECRET_KEY            sk_test_/rk_test_ in test mode; sk_live_/rk_live_ in live mode (never commit)
 *   STRIPE_WEBHOOK_SECRET        whsec_ signing secret of the webhook endpoint /api/billing/stripe/webhook
 *   STRIPE_PRICE_STARTER_MONTHLY, STRIPE_PRICE_GROWTH_MONTHLY, STRIPE_PRICE_PRO_MONTHLY
 *                                Stripe Price ids (price_...) of the three monthly plans. The amounts live in
 *                                Stripe, not here: the app never shows a price it invented.
 *   BILLING_GRACE_DAYS           days a past_due subscription keeps full service before read-only (default 7)
 *
 * Live mode is refused at start-up (instrumentation.ts) unless BILLING_MODE=live is set explicitly, the
 * deployment is production, and the key is a live key. Test mode refuses a live key.
 */
import { isProductionDeployment } from '../auth-guard'
import type { TierKey } from '../library/config'

type Env = Record<string, string | undefined>
const v = (e: Env, k: string) => (e[k] ?? '').trim()

export type BillingMode = 'off' | 'test' | 'live'
export function billingMode(e: Env = process.env): BillingMode {
  const m = v(e, 'BILLING_MODE').toLowerCase()
  return m === 'test' || m === 'live' ? m : 'off'
}

export const PLAN_PRICE_ENV: Record<TierKey, string> = {
  starter: 'STRIPE_PRICE_STARTER_MONTHLY',
  growth: 'STRIPE_PRICE_GROWTH_MONTHLY',
  pro: 'STRIPE_PRICE_PRO_MONTHLY',
}

export const stripeConfig = {
  get mode() { return billingMode() },
  get secretKey() { return v(process.env, 'STRIPE_SECRET_KEY') },
  get webhookSecret() { return v(process.env, 'STRIPE_WEBHOOK_SECRET') },
  get graceDays() { const n = Number(v(process.env, 'BILLING_GRACE_DAYS')); return Number.isInteger(n) && n >= 0 && n <= 60 ? n : 7 },
  get configured() { return Boolean(this.secretKey && this.webhookSecret) },
}

/** The Stripe Price id for a plan, or null when not configured. */
export function priceIdFor(plan: TierKey, e: Env = process.env): string | null {
  const id = v(e, PLAN_PRICE_ENV[plan])
  return /^price_[A-Za-z0-9]+$/.test(id) ? id : null
}

/** The plan a Stripe Price id belongs to (null for a price that is not one of ours). */
export function planForPrice(priceId: string | null | undefined, e: Env = process.env): TierKey | null {
  if (!priceId) return null
  for (const plan of Object.keys(PLAN_PRICE_ENV) as TierKey[]) if (priceIdFor(plan, e) === priceId) return plan
  return null
}

const isLiveKey = (k: string) => /^(sk|rk)_live_/.test(k)
const isTestKey = (k: string) => /^(sk|rk)_test_/.test(k)

export class BillingConfigError extends Error { constructor(message: string) { super(message); this.name = 'BillingConfigError' } }

/** Problems with the billing configuration for this environment ([] when it may run). */
export function billingConfigProblems(e: Env = process.env): string[] {
  const mode = billingMode(e)
  const raw = v(e, 'BILLING_MODE').toLowerCase()
  const key = v(e, 'STRIPE_SECRET_KEY')
  const out: string[] = []
  if (raw && !['off', 'test', 'live'].includes(raw)) out.push(`BILLING_MODE=${raw.slice(0, 20)} is not one of off, test, live`)
  if (mode === 'off') {
    if (isLiveKey(key)) out.push('a live Stripe key is set while BILLING_MODE is off; remove it or set BILLING_MODE=live deliberately')
    return out
  }
  if (!key) out.push(`BILLING_MODE=${mode} needs STRIPE_SECRET_KEY`)
  if (!v(e, 'STRIPE_WEBHOOK_SECRET').startsWith('whsec_')) out.push(`BILLING_MODE=${mode} needs STRIPE_WEBHOOK_SECRET (whsec_...)`)
  if (mode === 'test' && key && !isTestKey(key)) out.push('BILLING_MODE=test refuses a key that is not a test key (sk_test_/rk_test_)')
  if (mode === 'live') {
    if (key && !isLiveKey(key)) out.push('BILLING_MODE=live needs a live key (sk_live_/rk_live_)')
    if (!isProductionDeployment(e)) out.push('BILLING_MODE=live is allowed only on the production deployment')
  }
  return out
}

/** Called at server start (instrumentation.ts): refuse to run with an unsafe billing configuration. */
export function assertBillingStartup(e: Env = process.env) {
  const problems = billingConfigProblems(e)
  if (problems.length) throw new BillingConfigError(`Refusing to start: ${problems.join('; ')}`)
}
