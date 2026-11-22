/** Shared setup for the billing lifecycle tests: test-mode env, organizations with an owner, the fake Stripe, signed webhook delivery. */
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { invalidatePlanCache } from '../../lib/plans/catalog'
import { signStripePayload } from '../../lib/billing/stripe'
import { FakeStripe, type FakeEvent } from './fake-stripe'

export const WH = ['whsec', 'p5lifecycle', 'notreal'].join('_')
export const BILLING_ENV: Record<string, string> = {
  BILLING_MODE: 'test', STRIPE_SECRET_KEY: ['sk', 'test', 'p5notreal'].join('_'), STRIPE_WEBHOOK_SECRET: WH,
  STRIPE_PRICE_STARTER_MONTHLY: 'price_P5Starter', STRIPE_PRICE_GROWTH_MONTHLY: 'price_P5Growth', STRIPE_PRICE_PRO_MONTHLY: 'price_P5Pro', BILLING_GRACE_DAYS: '7', STRIPE_MAX_RETRIES: '0',
}
export const PRICES = [
  { id: 'price_P5Starter', unit_amount: 2900, currency: 'usd', nickname: 'Starter' },
  { id: 'price_P5Growth', unit_amount: 7900, currency: 'usd', nickname: 'Growth' },
  { id: 'price_P5Pro', unit_amount: 19900, currency: 'usd', nickname: 'Pro' },
  { id: 'price_P5Trial', unit_amount: 14900, currency: 'usd', nickname: 'Office Trial' },
]
/** A plan with a 14-day trial, created for these tests and removed after them (hypothesis like every seeded plan). */
export const TRIAL_PLAN = 'p5_trial_plan'

export function useBillingEnv() {
  const saved: Record<string, string | undefined> = {}
  return {
    on() { for (const [k, v] of Object.entries(BILLING_ENV)) { saved[k] = process.env[k]; process.env[k] = v } },
    off() { for (const k of Object.keys(BILLING_ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } },
  }
}

export type TestOrg = { org: string; owner: { uid: string; email: string }; member: { uid: string; email: string }; conn: string }

/** A merchant organization billed by Stripe (a WooCommerce store, not Shopify) with an owner and a member. */
export async function makeOrg(tag: string, opts: { email?: string } = {}): Promise<TestOrg> {
  const org = uuidFrom(`p5-billing-org:${tag}`)
  const owner = { uid: uuidFrom(`p5-billing-owner:${tag}`), email: opts.email ?? `owner.${tag}@p5-billing.example` }
  const member = { uid: uuidFrom(`p5-billing-member:${tag}`), email: `member.${tag}@p5-billing.example` }
  const conn = uuidFrom(`p5-billing-conn:${tag}`)
  await admin(async db => {
    await dropOrg(org, db)
    await db.query(`insert into agencies (id, name, org_type, plan_tier) values ($1, $2, 'merchant', 'starter')`, [org, `P5 Billing ${tag}`])
    await db.query(`insert into org_products (org_id, product, enabled_by) values ($1, 'commerce', 'test') on conflict do nothing`, [org])
    await db.query(`insert into store_connections (id, org_id, platform, external_id, display_name, status, is_synthetic) values ($1,$2,'woocommerce',$3,$4,'active',true)`, [conn, org, `https://${tag}.p5-billing.example`, `${tag} store`])
    for (const [p, role] of [[owner, 'owner'], [member, 'member']] as const) {
      await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing', [p.uid, p.email])
      await db.query(`insert into profiles (id, email, role, agency_id, org_role) values ($1,$2,'client',$3,$4) on conflict (id) do update set agency_id = excluded.agency_id, email = excluded.email`, [p.uid, p.email, org, role])
      await db.query('update profiles set org_role = $2 where id = $1', [p.uid, role])
    }
  })
  return { org, owner, member, conn }
}

async function dropOrg(org: string, db: Parameters<Parameters<typeof admin>[0]>[0]) {
  await db.query(`delete from auth.users where id in (select id from profiles where agency_id = $1)`, [org])
  await db.query('delete from agencies where id = $1', [org])
}
export const removeOrg = (o: TestOrg) => admin(db => dropOrg(o.org, db))

export async function addTrialPlan() {
  await admin(db => db.query(`insert into plans (key, suite, display_name, monthly_price_cents, stripe_price_id, tier_key, limits, trial_days, status)
    values ($1, 'both', 'Trial Plan', 14900, 'price_P5Trial', 'growth', '{"maxAgents":12,"monthlyActions":400,"monthlyEmails":1000,"aiBudgetUsd":15}', 14, 'hypothesis')
    on conflict (key) do update set trial_days = 14, active = true, status = 'hypothesis'`, [TRIAL_PLAN]))
  invalidatePlanCache()
}
export async function removeTrialPlan() {
  await admin(async db => { await db.query('delete from plan_changes where plan_key = $1', [TRIAL_PLAN]); await db.query('delete from plans where key = $1', [TRIAL_PLAN]) })
  invalidatePlanCache()
}

export const newFake = () => new FakeStripe(PRICES)

/** Deliver events to the signed webhook route, in order; returns each response body. */
export async function deliverAll(webhook: (req: Request) => Promise<Response>, events: (FakeEvent | Record<string, unknown>)[], secret = WH) {
  const out: Record<string, unknown>[] = []
  for (const ev of events) {
    const raw = JSON.stringify(ev)
    const res = await webhook(new Request('http://localhost/api/billing/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': signStripePayload(raw, secret), 'content-type': 'application/json' }, body: raw }))
    out.push({ status: res.status, ...(await res.json() as Record<string, unknown>) })
  }
  return out
}

export const subRow = (org: string) => admin(db => db.one<{ status: string; plan: string | null; plan_key: string | null; external_id: string; cancel_at_period_end: boolean; cancel_reason: string | null; cancel_comment: string | null; past_due_since: string | null; trial_end: string | null; ended_at: string | null; pending_plan_key: string | null; schedule_external_id: string | null; current_period_end: string | null }>(
  `select status, plan, plan_key, external_id, cancel_at_period_end, cancel_reason, cancel_comment, past_due_since::text, trial_end::text, ended_at::text, pending_plan_key, schedule_external_id, current_period_end::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [org]))
export const notices = (org: string) => admin(db => db.query<{ kind: string; recipient: string | null; status: string; subject: string; body: string; link: string | null; dedupe_key: string }>(`select kind, recipient, status, subject, body, link, dedupe_key from billing_notices where org_id = $1 order by created_at, kind`, [org]))
