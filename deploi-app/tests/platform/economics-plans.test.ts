/**
 * Unit economics math and report; workflow cost counters; the plans table drives entitlements; staff
 * plan edits are audited and need owner approval; hypothesis plans are refused for live checkout.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, HB } from '../merchant/helpers'
import { computeEconomics, economicsReport, monthRange, unitPrices, currentMonth } from '../../lib/platform/economics'
import { countWorkflow, flushWorkflowCounters, pendingWorkflowCounts, recordWorkflow, monthOf } from '../../lib/ai/meter'
import { orgEntitlements, planLimits } from '../../lib/plans/entitlements'
import { checkoutRefusal, editPlan, invalidatePlanCache, loadPlans, PlanEditError } from '../../lib/plans/catalog'
import { createCheckoutSession } from '../../lib/billing/checkout'
import { enqueue, runDueJobs } from '../../lib/jobs/queue'
import { registerJobHandler } from '../../lib/jobs/queue'
import { restoreLimits, setLimit } from '../plans/limits'

const ready = await prepareDb()
const ENV_KEYS = ['BILLING_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_STARTER_MONTHLY', 'PRICING_APPROVER_EMAILS', 'VERCEL_ENV']
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
let savedPlans: unknown[] = []

const inputs = { orgId: 'o', orgName: 'Org', plan: 'x', subscriptionStatus: 'active', aiCalls: 10, providerCalls: {}, jobRuns: 0, emailsSent: 0 }

describe('unit economics math', () => {
  const p = unitPrices({ ECON_JOB_RUN_USD: '0.001', ECON_PROVIDER_CALL_USD: '0.0005', ECON_PROVIDER_CALL_USD_SHOPIFY: '0.001', ECON_EMAIL_USD: '0.002' })
  it('variable cost, cost per verified resolution and gross margin', () => {
    const e = computeEconomics({ ...inputs, revenueCents: 24900, aiCostUsd: 10, jobRuns: 1000, providerCalls: { shopify: 2000, woocommerce: 1000 }, emailsSent: 500, verifiedResolutions: 20 }, p)
    // 10 + (2000 * 0.001 + 1000 * 0.0005) + 1000 * 0.001 + 500 * 0.002 = 10 + 2.5 + 1 + 1 = 14.5
    expect(e).toMatchObject({ revenueUsd: 249, aiCostUsd: 10, providerCostUsd: 2.5, jobCostUsd: 1, emailCostUsd: 1, variableCostUsd: 14.5, costPerResolutionUsd: 0.725, grossMarginPct: 94.2, flags: [] })
    expect(e.target).toEqual({ minUsd: 15, maxUsd: 40 })
  })
  it('flags: above the $15-$40 band for a $249 plan (scaled by price), negative margin, cost without revenue', () => {
    expect(computeEconomics({ ...inputs, revenueCents: 24900, aiCostUsd: 41, verifiedResolutions: 0 }, p)).toMatchObject({ flags: ['above_target'], costPerResolutionUsd: null })
    expect(computeEconomics({ ...inputs, revenueCents: 24900, aiCostUsd: 39, verifiedResolutions: 1 }, p).flags).toEqual([])
    // a $49.80 plan (one fifth of $249): the band is $3-$8
    const small = computeEconomics({ ...inputs, revenueCents: 4980, aiCostUsd: 9, verifiedResolutions: 1 }, p)
    expect(small.target).toEqual({ minUsd: 3, maxUsd: 8 })
    expect(small.flags).toEqual(['above_target'])
    expect(computeEconomics({ ...inputs, revenueCents: 1000, aiCostUsd: 12, verifiedResolutions: 1 }, p).flags).toEqual(['above_target', 'negative_margin'])
    expect(computeEconomics({ ...inputs, revenueCents: 0, aiCostUsd: 1, verifiedResolutions: 1 }, p)).toMatchObject({ flags: ['no_revenue_with_cost'], grossMarginPct: null })
  })
  it('months are UTC calendar months', () => {
    expect(monthRange('2026-12')).toEqual(['2026-12-01', '2027-01-01'])
    expect(() => monthRange('2026-13')).toThrow()
  })
})

describe.skipIf(!ready)('metering, report and plans', () => {
  beforeEach(async () => {
    restoreEnv(); invalidatePlanCache()
    savedPlans = await admin(db => db.query('select * from plans'))
    await admin(async db => {
      for (const t of ['ai_usage', 'workflow_costs', 'billing_subscriptions', 'billing_customers']) await db.query(`delete from ${t} where org_id = any($1::uuid[])`, [[NW.org, HB.org]])
      await db.query(`update agencies set plan_tier = 'starter', plan_key = null where id = any($1::uuid[])`, [[NW.org, HB.org]])
    })
  })
  afterEach(async () => {
    restoreEnv()
    await admin(async db => {
      await db.query('delete from plan_changes')
      await db.query(`delete from plans where key not in (select (p->>'key') from jsonb_array_elements($1::jsonb) p)`, [JSON.stringify(savedPlans)])
      for (const p of savedPlans as Record<string, unknown>[]) await db.query(`update plans set monthly_price_cents = $2, limits = $3, status = $4, approved_by = $5, approved_at = $6, stripe_price_id = $7, active = $8, version = $9 where key = $1`,
        [p.key, p.monthly_price_cents, JSON.stringify(p.limits), p.status, p.approved_by, p.approved_at, p.stripe_price_id, p.active, p.version])
    })
    await restoreLimits(); invalidatePlanCache()
  })
  afterAll(async () => { if (ready) await admin(db => db.query('delete from workflow_costs where org_id = any($1::uuid[])', [[NW.org, HB.org]])) })

  it('workflow counters: job runs from the queue, provider calls in memory then flushed, emails in the sending transaction', async () => {
    registerJobHandler('test.platform.meter', async () => { countWorkflow(NW.org, 'provider_call', 'shopify', 3); return {} }, { agentWork: false })
    await enqueue({ kind: 'test.platform.meter', orgId: NW.org, idempotencyKey: `m-${Date.now()}` })
    await runDueJobs({ kinds: ['test.platform.meter'] })
    countWorkflow(HB.org, 'provider_call', 'woocommerce', 2)
    expect(pendingWorkflowCounts().get(`${HB.org}|provider_call|woocommerce`)).toBe(2)
    await flushWorkflowCounters()
    expect(pendingWorkflowCounts().size).toBe(0)
    await admin(db => recordWorkflow(db, NW.org, 'email_sent', '', 4))
    const rows = await admin(db => db.query<{ org_id: string; metric: string; connector: string; count: string; month: string }>(`select org_id, metric, connector, count::text, month::text from workflow_costs where org_id = any($1::uuid[]) order by org_id, metric, connector`, [[NW.org, HB.org]]))
    const month = monthOf(new Date())
    expect(rows).toEqual(expect.arrayContaining([
      { org_id: NW.org, metric: 'job_run', connector: '', count: '1', month },
      { org_id: NW.org, metric: 'provider_call', connector: 'shopify', count: '3', month },
      { org_id: NW.org, metric: 'email_sent', connector: '', count: '4', month },
      { org_id: HB.org, metric: 'provider_call', connector: 'woocommerce', count: '2', month },
    ]))
    countWorkflow('not-an-org', 'job_run'); countWorkflow(null, 'job_run')
    expect(pendingWorkflowCounts().size).toBe(0)
  })

  it('the report: revenue from the subscription and the plans table, AI cost, workflow cost, verified resolutions, flags', async () => {
    const month = currentMonth()
    await admin(async db => {
      await db.query(`insert into billing_subscriptions (org_id, provider, external_id, status, plan) values ($1, 'stripe', 'sub_econ', 'active', 'growth')`, [NW.org])
      await db.query(`insert into ai_usage (org_id, agent_ref, purpose, tier, model, input_tokens, output_tokens, cost_usd, outcome) values ($1,'engine:a','x.y','routine','m',1,1,50,'ok'), ($1,'engine:a','x.y','routine','m',0,0,0,'refused'), ($2,'engine:b','x.y','routine','m',1,1,0.5,'ok')`, [NW.org, HB.org])
      await recordWorkflow(db, NW.org, 'email_sent', '', 1000)
    })
    const r = await admin(db => economicsReport(db, month))
    const nw = r.orgs.find(o => o.orgId === NW.org)!, hb = r.orgs.find(o => o.orgId === HB.org)!
    expect(nw).toMatchObject({ plan: 'growth', revenueUsd: 79, aiCostUsd: 50, aiCalls: 1, emailsSent: 1000, flags: ['above_target'] })
    expect(nw.variableCostUsd).toBeCloseTo(50 + 1000 * unitPrices().emailUsd, 4)
    expect(hb).toMatchObject({ revenueUsd: 0, aiCostUsd: 0.5, flags: ['no_revenue_with_cost'] })
    expect(r.orgs[0].orgId).toBe(NW.org) // highest cost first
    expect(r.totals.flagged).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(r)).not.toMatch(/owner@|@northwind|ciphertext/)
  })

  it('the plans table drives entitlements (cached; constants when a limit is missing); env overrides are kept with billing off', async () => {
    expect(await admin(db => planLimits(db, 'starter'))).toMatchObject({ maxAgents: 5, monthlyActions: 150, aiBudgetUsd: 5, planKey: 'starter' })
    await setLimit('starter', 'monthlyEmails', 321)
    expect((await admin(db => orgEntitlements(db, NW.org))).monthlyEmails).toBe(321)
    // a limit missing from the row falls back to the constant
    await admin(db => db.query(`update plans set limits = limits - 'officeSeats' where key = 'starter'`)); invalidatePlanCache()
    expect((await admin(db => planLimits(db, 'starter'))).officeSeats).toBe(2)
    // an organization on one of the suites gets that plan's limits
    await admin(db => db.query(`update agencies set plan_key = 'business_workforce' where id = $1`, [NW.org]))
    expect(await admin(db => orgEntitlements(db, NW.org))).toMatchObject({ maxAgents: 10, monthlyActions: 3000, aiBudgetUsd: 40 }) // maxAgents: PLAN_MAX_AGENTS default while billing is off
    // an empty table: the constants (inside a transaction that is rolled back)
    invalidatePlanCache()
    const seen = await admin(async db => {
      await db.query('delete from plans')
      const l = await planLimits(db, 'growth')
      throw Object.assign(new Error('rollback'), { l })
    }).catch((e: { l?: unknown }) => e.l)
    invalidatePlanCache()
    expect(seen).toMatchObject({ maxAgents: 12, monthlyActions: 500, aiBudgetUsd: 12, planKey: null })
    const all = await admin(db => db.query('select * from plans'))
    expect(all.length).toBe(6)
    expect((await loadPlans()).filter(p => p.status === 'hypothesis').map(p => p.key).sort()).toEqual(['business_workforce', 'commerce_operations', 'growth', 'office_starter', 'pro', 'starter'])
  })

  it('staff edits are versioned and audited; only an owner approves; a price change returns an approved plan to hypothesis; subscriptions are untouched', async () => {
    await admin(db => db.query(`insert into billing_subscriptions (org_id, provider, external_id, status, plan) values ($1, 'stripe', 'sub_keep', 'active', 'starter')`, [NW.org]))
    process.env.PRICING_APPROVER_EMAILS = 'owner@getdeploi.com'
    await expect(admin(db => editPlan(db, { key: 'office_starter', patch: { status: 'approved' }, staffEmail: 'hello@getdeploi.com' }))).rejects.toBeInstanceOf(PlanEditError)
    const v0 = (await loadPlans()).find(p => p.key === 'office_starter')!.version
    const a = await admin(db => editPlan(db, { key: 'office_starter', patch: { status: 'approved' }, staffEmail: 'owner@getdeploi.com' }))
    expect(a).toMatchObject({ status: 'approved', approved_by: 'staff:owner@getdeploi.com', version: v0 + 1 })
    const b = await admin(db => editPlan(db, { key: 'office_starter', patch: { monthlyPriceCents: 15900 }, staffEmail: 'hello@getdeploi.com' }))
    expect(b).toMatchObject({ status: 'hypothesis', monthly_price_cents: 15900, approved_by: null, version: v0 + 2 })
    await expect(admin(db => editPlan(db, { key: 'office_starter', patch: { limits: { bogus: 1 } }, staffEmail: 'hello@getdeploi.com' }))).rejects.toMatchObject({ code: 'invalid_input' })
    const changes = await admin(db => db.query<{ version: number; actor: string }>(`select version, actor from plan_changes where plan_key = 'office_starter' order by id`))
    expect(changes).toEqual([{ version: v0 + 1, actor: 'staff:owner@getdeploi.com' }, { version: v0 + 2, actor: 'staff:hello@getdeploi.com' }])
    expect(await admin(db => db.one(`select count(*)::int as n from engine_audit where entity_id = 'plan:office_starter' and event in ('plan.approved','plan.updated')`))).toMatchObject({ n: expect.any(Number) })
    expect(await admin(db => db.one(`select status, plan, external_id from billing_subscriptions where org_id = $1`, [NW.org]))).toEqual({ status: 'active', plan: 'starter', external_id: 'sub_keep' })
    // a new plan starts as a hypothesis
    expect(await admin(db => editPlan(db, { key: 'agency_pilot', create: true, patch: { suite: 'both', displayName: 'Agency pilot', monthlyPriceCents: 24900, tierKey: 'pro' }, staffEmail: 'hello@getdeploi.com' }))).toMatchObject({ status: 'hypothesis' })
  })

  it('a hypothesis plan is refused for live Stripe checkout and allowed in test mode; an approved plan can be sold live', async () => {
    expect(checkoutRefusal({ key: 'pro', status: 'hypothesis', active: true }, 'live')).toMatch(/hypothesis/)
    expect(checkoutRefusal({ key: 'pro', status: 'hypothesis', active: true }, 'test')).toBeNull()
    expect(checkoutRefusal({ key: 'pro', status: 'approved', active: true }, 'live')).toBeNull()
    expect(checkoutRefusal({ key: 'pro', status: 'approved', active: false }, 'live')).toMatch(/not on sale/)
    // through createCheckoutSession: live mode refuses the hypothesis before any Stripe call
    Object.assign(process.env, { BILLING_MODE: 'live', VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PRICE_STARTER_MONTHLY: 'price_Live1' })
    let called = 0
    const fetchImpl = (async () => { called++; return new Response('{}', { status: 500 }) }) as unknown as typeof fetch
    await expect(admin(db => createCheckoutSession(db, { orgId: HB.org, plan: 'office_starter', actor: 'test', appUrl: 'https://app.example', fetchImpl }))).rejects.toMatchObject({ status: 409, code: 'plan_not_approved' })
    await expect(admin(db => createCheckoutSession(db, { orgId: HB.org, plan: 'starter', actor: 'test', appUrl: 'https://app.example', fetchImpl }))).rejects.toMatchObject({ code: 'plan_not_approved' })
    expect(called).toBe(0)
    // test mode: the hypothesis passes the approval check (this Shopify store is then sent to Shopify billing)
    Object.assign(process.env, { BILLING_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x' }); delete process.env.VERCEL_ENV
    await expect(admin(db => createCheckoutSession(db, { orgId: HB.org, plan: 'starter', actor: 'test', appUrl: 'https://app.example', fetchImpl }))).rejects.toMatchObject({ code: 'use_shopify_billing' })
  })
})
