/**
 * The billing lifecycle end to end against the test database and a fake Stripe that answers the documented
 * request and response shapes and acts on its own clock (trial end, renewals, retries, schedules). Requests go
 * through the real route handlers with a signed-in session; Stripe's events come back through the signed
 * webhook route. Checked: what the owner sees (billing page data, banner, notices) and what agents may do.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin } from '../../lib/db'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'
import type { Session } from '../../lib/session'
import { orgEntitlements } from '../../lib/plans/entitlements'
import { recordingNotifier, setBillingNotifier, deliverNotices } from '../../lib/billing/notify'
import { billingHourly } from '../../lib/billing/jobs'
import { createCheckoutSession } from '../../lib/billing/checkout'
import { invalidatePlanCache } from '../../lib/plans/catalog'
import { useBillingEnv, makeOrg, removeOrg, addTrialPlan, removeTrialPlan, newFake, deliverAll, subRow, notices, TRIAL_PLAN, type TestOrg } from './helpers'
import type { FakeStripe } from './fake-stripe'

let cookieValue: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === DEV_COOKIE_NAME && cookieValue ? { value: cookieValue } : undefined), set: () => {}, delete: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))

const ready = await prepareDb()
const allowDev = process.env.ALLOW_DEV_LOGIN
process.env.ALLOW_DEV_LOGIN = 'true'
const { POST: webhook } = await import('../../app/api/billing/stripe/webhook/route')
const billingRoute = await import('../../app/api/billing/route')
const statusRoute = await import('../../app/api/billing/status/route')
const accountRoute = await import('../../app/api/billing/account/route')
const checkoutRoute = await import('../../app/api/billing/checkout/route')
const changeRoute = await import('../../app/api/billing/change/route')
const cancelRoute = await import('../../app/api/billing/cancel/route')
const reactivateRoute = await import('../../app/api/billing/reactivate/route')
const financeRoute = await import('../../app/api/staff/finance/route')

const ORIGIN = 'http://localhost:3000'
const DAY = 86400
const sessionOf = (o: TestOrg, who: 'owner' | 'member' = 'owner'): Session => ({ uid: o[who].uid, email: o[who].email, role: 'client', agencyId: o.org, orgType: 'merchant' })
const as = (s: Session) => { cookieValue = encodeDevSession(s) }
async function call<T = Record<string, unknown>>(handler: (req: Request) => Promise<Response>, method: 'GET' | 'POST', body?: unknown, path = '/api/billing'): Promise<{ status: number; json: T & { error?: string; message?: string } }> {
  const req = new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = await handler(req)
  return { status: res.status, json: await res.json() as T & { error?: string; message?: string } }
}
type Overview = { provider: string; billing: { status: string; readOnly: boolean; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null }; subscription: { status: string; planKey: string | null; trialDaysLeft: number | null; pendingPlanKey: string | null; pendingChangeAt: string | null; cancelReason: string | null } | null
  plans: { key: string; available: boolean; pilot: boolean; priceCents: number; current: boolean; refusal: string | null }[]; pricingLabel: string | null; banner: { tone: string; message: string; cta: string } | null
  paymentFailure: { count: number; nextAttemptAt: string | null; amountDueCents: number | null } | null; trial: { eligible: boolean; refusal: string | null }; usage: { aiSpendUsd: number; aiBudgetUsd: number | null; actionsLimit: number | null }
  shopify: { planHandle: string | null; plansUrl: string | null } | null }
const overview = async (o: TestOrg) => { as(sessionOf(o)); return (await call<Overview>(billingRoute.GET, 'GET')).json }
const stripePosts = (f: FakeStripe, path: string | RegExp) => f.calls.filter(c => c.method === 'POST' && (typeof path === 'string' ? c.path === path : path.test(c.path)))
const clockDate = (f: FakeStripe) => new Date(f.clock * 1000)

describe.skipIf(!ready)('billing lifecycle (fake Stripe)', () => {
  const env = useBillingEnv()
  let A: TestOrg, B: TestOrg
  let fake: FakeStripe
  let mail: ReturnType<typeof recordingNotifier>
  beforeAll(async () => {
    env.on()
    await addTrialPlan()
    A = await makeOrg('a')
    // the same mailbox as A's owner (plus-addressed): one trial per e-mail address
    B = await makeOrg('b', { email: 'owner.a+second@p5-billing.example' })
    env.off()
  })
  afterAll(async () => {
    cookieValue = undefined
    if (allowDev === undefined) delete process.env.ALLOW_DEV_LOGIN; else process.env.ALLOW_DEV_LOGIN = allowDev
    await removeOrg(A); await removeOrg(B); await removeTrialPlan()
    setBillingNotifier(null)
  })
  beforeEach(() => { env.on(); invalidatePlanCache(); mail = recordingNotifier(); setBillingNotifier(mail) })
  afterEach(() => { vi.unstubAllGlobals(); env.off() })

  it('trial: checkout with the plan\'s trial days and no card; reminder three days before; trial end without a card -> past due -> grace -> read-only -> recovery', async () => {
    fake = newFake()
    vi.stubGlobal('fetch', fake.fetch)
    as(sessionOf(A))
    const before = await overview(A)
    expect(before.trial.eligible).toBe(true)
    expect(before.pricingLabel).toBe('Pilot pricing')
    expect(before.plans.find(p => p.key === TRIAL_PLAN)).toMatchObject({ available: true, pilot: true, priceCents: 14900 })
    const co = await call<{ url: string; trialDays: number }>(checkoutRoute.POST, 'POST', { plan: TRIAL_PLAN })
    expect(co.status).toBe(200)
    expect(co.json).toMatchObject({ trialDays: 14, url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) })
    const cs = stripePosts(fake, '/v1/checkout/sessions')[0].params
    expect(Object.fromEntries(cs)).toMatchObject({ 'subscription_data[trial_period_days]': '14', payment_method_collection: 'if_required', 'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'create_invoice', 'line_items[0][price]': 'price_P5Trial', client_reference_id: A.org })
    // every request: pinned API version; every POST: an idempotency key
    for (const c of fake.calls) { expect(c.headers['stripe-version']).toBe('2025-03-31.basil'); if (c.method === 'POST') expect(c.headers['idempotency-key']).toBeTruthy() }

    // the owner completes Checkout without a card: a trialing subscription
    const sessionId = [...fake.sessions.keys()][0]
    const r = await deliverAll(webhook, fake.completeCheckout(sessionId, { withCard: false }))
    expect(r.every(x => x.status === 200)).toBe(true)
    expect(await subRow(A.org)).toMatchObject({ status: 'trialing', plan_key: TRIAL_PLAN, plan: 'growth' })
    const trial = await admin(db => db.one<{ outcome: string; plan_key: string }>('select outcome, plan_key from billing_trials where org_id = $1', [A.org]))
    expect(trial).toMatchObject({ outcome: 'trialing', plan_key: TRIAL_PLAN })
    const o1 = await overview(A)
    expect(o1.subscription).toMatchObject({ status: 'trialing', trialDaysLeft: 14, planKey: TRIAL_PLAN })
    expect(o1.banner).toBeNull()
    expect(o1.trial.eligible).toBe(false)
    expect((await admin(db => orgEntitlements(db, A.org)))).toMatchObject({ writesAllowed: true, plan: TRIAL_PLAN, monthlyActions: 400 })

    // 11 days in: Stripe's trial_will_end, and the hourly job, remind the owner exactly once
    fake.advance(11 * DAY)
    await deliverAll(webhook, fake.trialWillEnd(fake.subOf(fake.sessions.get(sessionId)!.customer as string)!.id))
    await billingHourly(clockDate(fake))
    await billingHourly(clockDate(fake))
    const reminders = mail.sent.filter(n => n.kind === 'trial_ending')
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toMatchObject({ to: A.owner.email, subject: 'Your Deploi trial ends in 3 days' })
    expect(reminders[0].body).toMatch(/add a payment method: http:\/\/localhost:3000\/store\/billing\?portal=1/)
    // the banner says so (three days or fewer)
    const soon = await admin(async db => (await import('../../lib/billing/overview')).billingOverview(db, A.org, clockDate(fake)))
    expect(soon.banner).toMatchObject({ tone: 'info', message: expect.stringMatching(/trial ends in 3 days/) })

    // the trial ends with no payment method: Stripe invoices, the payment fails, the subscription is past due
    const ended = fake.advance(4 * DAY)
    expect(ended.map(e => e.type)).toEqual(expect.arrayContaining(['customer.subscription.updated', 'invoice.payment_failed']))
    await deliverAll(webhook, ended)
    const pd = await subRow(A.org)
    expect(pd).toMatchObject({ status: 'past_due' })
    expect((await admin(db => db.one<{ outcome: string }>('select outcome from billing_trials where org_id = $1', [A.org])))!.outcome).toBe('lapsed')
    const failed = mail.sent.filter(n => n.kind === 'payment_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].body).toMatch(/\$149 payment \(attempt 1\)\. Stripe will try again on/)
    expect(failed[0].body).toMatch(/Update your payment method: http:\/\/localhost:3000\/store\/billing\?portal=1/)
    expect(failed[0].body).toMatch(/Pay the invoice now: https:\/\/invoice\.stripe\.com\//)
    const inGrace = await admin(async db => (await import('../../lib/billing/overview')).billingOverview(db, A.org, clockDate(fake)))
    expect(inGrace.banner).toMatchObject({ tone: 'warn', message: expect.stringMatching(/^Payment failed\. Update your payment method before \d{4}-\d{2}-\d{2}/) })
    expect(inGrace.paymentFailure).toMatchObject({ count: 1, amountDueCents: 14900 })
    expect((await admin(db => orgEntitlements(db, A.org, clockDate(fake)))).writesAllowed).toBe(true)

    // Stripe retries on its own schedule; after the grace period the account is read-only
    await deliverAll(webhook, fake.advance(8 * DAY))
    const ro = await admin(db => orgEntitlements(db, A.org, clockDate(fake)))
    expect(ro.writesAllowed).toBe(false)
    expect(ro.billing.reason).toMatch(/grace period has ended/)
    const roView = await admin(async db => (await import('../../lib/billing/overview')).billingOverview(db, A.org, clockDate(fake)))
    expect(roView.banner).toMatchObject({ tone: 'danger', cta: 'Update payment method' })
    expect((await admin(db => db.one<{ n: string }>('select count(*)::text as n from billing_payment_failures where org_id = $1', [A.org])))!.n).toBe('3')

    // the owner adds a card: the open invoice is paid, everything recovers, the trial counts as converted
    await deliverAll(webhook, fake.payWithNewCard(fake.subOf(String(fake.sessions.get(sessionId)!.customer))!.customer))
    expect(await subRow(A.org)).toMatchObject({ status: 'active', past_due_since: null })
    expect((await admin(db => orgEntitlements(db, A.org, clockDate(fake)))).writesAllowed).toBe(true)
    expect((await admin(db => db.one<{ outcome: string }>('select outcome from billing_trials where org_id = $1', [A.org])))!.outcome).toBe('converted')
    expect(mail.sent.filter(n => n.kind === 'payment_recovered')).toHaveLength(1)
    expect((await admin(db => db.one<{ n: string }>('select count(*)::text as n from billing_payment_failures where org_id = $1 and recovered_at is null', [A.org])))!.n).toBe('0')
    const after = await admin(async db => (await import('../../lib/billing/overview')).billingOverview(db, A.org, clockDate(fake)))
    expect(after.banner).toBeNull()
    expect(after.paymentFailure).toBeNull()
  })

  it('one trial per e-mail address: another organization with the same mailbox subscribes without a trial', async () => {
    fake = newFake()
    vi.stubGlobal('fetch', fake.fetch)
    as(sessionOf(B))
    const co = await call<{ trialDays: number; trialRefused: string | null }>(checkoutRoute.POST, 'POST', { plan: TRIAL_PLAN })
    expect(co.status).toBe(200)
    expect(co.json).toMatchObject({ trialDays: 0, trialRefused: 'a trial was already used with this billing account' })
    const cs = Object.fromEntries(stripePosts(fake, '/v1/checkout/sessions')[0].params)
    expect(cs['subscription_data[trial_period_days]']).toBeUndefined()
    expect(cs.payment_method_collection).toBeUndefined()
    expect((await overview(B)).trial).toMatchObject({ eligible: false, refusal: 'a trial was already used with this billing account' })
  })

  it('upgrade: Stripe\'s proration preview first; entitlements switch only when Stripe confirms', async () => {
    fake = newFake()
    vi.stubGlobal('fetch', fake.fetch)
    // A is active on the trial plan ($149) from the previous test; move its Stripe state into this fake
    await admin(db => db.query(`delete from billing_customers where org_id = $1`, [A.org]))
    await admin(db => db.query(`delete from billing_subscriptions where org_id = $1`, [A.org]))
    as(sessionOf(A))
    // a former subscriber gets no second trial
    const co = await call<{ trialDays: number }>(checkoutRoute.POST, 'POST', { plan: 'growth' })
    expect(co.json.trialDays).toBe(0)
    // the subscription started ten days ago (the app prorates from now)
    fake.clock -= 10 * DAY
    await deliverAll(webhook, fake.completeCheckout([...fake.sessions.keys()][0]))
    fake.clock += 10 * DAY
    expect(await subRow(A.org)).toMatchObject({ status: 'active', plan_key: 'growth' })
    const subId = (await subRow(A.org))!.external_id

    const pv = await call<{ preview: { changeId: string; direction: string; prorationCents: number; amountDueCents: number; lines: { description: string; amountCents: number; proration: boolean }[]; summary: string } }>(changeRoute.POST, 'POST', { action: 'preview', plan: 'pro' })
    expect(pv.status).toBe(200)
    const p = pv.json.preview
    expect(p.direction).toBe('upgrade')
    // 20 of 30 days left: -2/3 of $79 + 2/3 of $199 = +$80.00, plus the next month at $199
    expect(p.prorationCents).toBe(8000)
    expect(p.amountDueCents).toBe(8000 + 19900)
    expect(p.lines.map(l => l.description)).toEqual([expect.stringMatching(/^Unused time on Growth/), expect.stringMatching(/^Remaining time on Pro/), expect.stringMatching(/^1 × Pro/)])
    expect(p.summary).toMatch(/prorated difference \(80\.00 USD\) is added to your next invoice of 279\.00 USD/)
    const previewCall = stripePosts(fake, '/v1/invoices/create_preview')[0].params
    expect(Object.fromEntries(previewCall)).toMatchObject({ subscription: subId, 'subscription_details[proration_behavior]': 'create_prorations', 'subscription_details[items][0][price]': 'price_P5Pro' })
    // the preview changes nothing
    expect((await admin(db => orgEntitlements(db, A.org))).plan).toBe('growth')

    const ok = await call<{ status: string; message: string }>(changeRoute.POST, 'POST', { action: 'confirm', changeId: p.changeId })
    expect(ok.json).toMatchObject({ status: 'requested', message: expect.stringMatching(/applies as soon as Stripe confirms/) })
    const upd = stripePosts(fake, `/v1/subscriptions/${subId}`).at(-1)!.params
    expect(upd.get('proration_behavior')).toBe('create_prorations')
    expect(upd.get('proration_date')).toBe(previewCall.get('subscription_details[proration_date]'))
    expect(upd.get('items[0][price]')).toBe('price_P5Pro')
    // a second confirmation of the same preview is refused
    expect((await call(changeRoute.POST, 'POST', { action: 'confirm', changeId: p.changeId })).json.error).toBe('already_confirmed')
    // not yet confirmed by Stripe: the old limits still apply
    expect((await admin(db => orgEntitlements(db, A.org)))).toMatchObject({ plan: 'growth', maxAgents: 12 })
    await deliverAll(webhook, fake.drain())
    expect((await admin(db => orgEntitlements(db, A.org)))).toMatchObject({ plan: 'pro', tier: 'pro', maxAgents: 30 })
    expect((await admin(db => db.one<{ status: string }>('select status from billing_plan_changes where id = $1', [p.changeId])))!.status).toBe('applied')
    expect(mail.sent.filter(n => n.kind === 'plan_changed').map(n => n.subject)).toEqual(['You are now on the Pro plan'])
    // the prorated difference lands on the next invoice Stripe issues
    const renewal = fake.advance(20 * DAY + 60)
    const paid = renewal.find(e => e.type === 'invoice.paid')!.data.object as { amount_paid: number }
    expect(paid.amount_paid).toBe(8000 + 19900)
    await deliverAll(webhook, renewal)
    const acct = await call<{ invoices: { amountPaidCents: number; hostedUrl: string; status: string }[]; paymentMethod: { brand: string; last4: string } }>(accountRoute.GET, 'GET')
    expect(acct.json.paymentMethod).toMatchObject({ brand: 'visa', last4: '4242' })
    expect(acct.json.invoices[0]).toMatchObject({ status: 'paid', amountPaidCents: 27900, hostedUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//) })
  })

  it('downgrade at period end through a subscription schedule; the plan switches and the downgrade enforcement runs when Stripe applies it', async () => {
    vi.stubGlobal('fetch', fake.fetch)
    as(sessionOf(A))
    // six active agents: Starter allows five
    const agentIds = await admin(async db => {
      const ids: string[] = []
      for (let i = 0; i < 6; i++) ids.push((await db.one<{ id: string }>(`insert into agents (org_id, connection_id, name, status, created_by, created_at) values ($1,$2,$3,'active','test', now() + ($4 || ' seconds')::interval) returning id`, [A.org, A.conn, `Agent ${i}`, String(i)]))!.id)
      return ids
    })
    const subId = (await subRow(A.org))!.external_id
    const pv = await call<{ preview: { changeId: string; direction: string; effectiveAt: string; amountDueCents: number; prorationCents: number; summary: string } }>(changeRoute.POST, 'POST', { action: 'preview', plan: 'starter' })
    expect(pv.json.preview).toMatchObject({ direction: 'downgrade', prorationCents: 0, amountDueCents: 2900 })
    const periodEnd = fake.subs.get(subId)!.items.data[0].current_period_end
    expect(pv.json.preview.effectiveAt).toBe(new Date(periodEnd * 1000).toISOString())
    expect(pv.json.preview.summary).toMatch(/You keep the Pro plan until .*; then the Starter plan applies/)
    const ok = await call<{ status: string }>(changeRoute.POST, 'POST', { action: 'confirm', changeId: pv.json.preview.changeId })
    expect(ok.json.status).toBe('scheduled')
    const sched = [...fake.schedules.values()][0]
    expect(sched).toMatchObject({ subscription: subId, end_behavior: 'release' })
    expect(sched.phases.map(ph => ph.items[0].price)).toEqual(['price_P5Pro', 'price_P5Starter'])
    expect(sched.phases[0].end_date).toBe(periodEnd)
    await deliverAll(webhook, fake.drain())
    const o = await overview(A)
    expect(o.subscription).toMatchObject({ pendingPlanKey: 'starter', planKey: 'pro' })
    // still Pro until the period ends
    expect((await admin(db => orgEntitlements(db, A.org)))).toMatchObject({ plan: 'pro', maxAgents: 30 })
    const st = await admin(db => db.query<{ status: string }>(`select status from agents where id = any($1) order by created_at`, [agentIds]))
    expect(st.every(a => a.status === 'active')).toBe(true)

    // the period ends: Stripe moves the subscription to Starter
    await deliverAll(webhook, fake.advance(periodEnd - fake.clock + 60))
    expect(await subRow(A.org)).toMatchObject({ plan_key: 'starter', pending_plan_key: null, schedule_external_id: null })
    expect((await admin(db => orgEntitlements(db, A.org)))).toMatchObject({ plan: 'starter', maxAgents: 5 })
    const after = await admin(db => db.query<{ id: string; status: string }>(`select id, status from agents where id = any($1) order by created_at, id`, [agentIds]))
    expect(after.map(a => a.status)).toEqual(['active', 'active', 'active', 'active', 'active', 'paused'])
    expect((await admin(db => db.one<{ status: string }>('select status from billing_plan_changes where id = $1', [pv.json.preview.changeId])))!.status).toBe('applied')
    await admin(db => db.query('delete from agents where id = any($1)', [agentIds]))
  })

  it('a scheduled downgrade can be dropped before it applies', async () => {
    vi.stubGlobal('fetch', fake.fetch)
    as(sessionOf(A))
    const up = await call<{ preview: { changeId: string } }>(changeRoute.POST, 'POST', { action: 'preview', plan: 'growth' })
    await call(changeRoute.POST, 'POST', { action: 'confirm', changeId: up.json.preview.changeId })
    await deliverAll(webhook, fake.drain())
    expect((await subRow(A.org))!.plan_key).toBe('growth')
    const down = await call<{ preview: { changeId: string } }>(changeRoute.POST, 'POST', { action: 'preview', plan: 'starter' })
    await call(changeRoute.POST, 'POST', { action: 'confirm', changeId: down.json.preview.changeId })
    await deliverAll(webhook, fake.drain())
    expect((await subRow(A.org))!.pending_plan_key).toBe('starter')
    expect((await call(changeRoute.POST, 'POST', { action: 'cancel_pending' })).status).toBe(200)
    expect(stripePosts(fake, /\/release$/)).toHaveLength(1)
    await deliverAll(webhook, fake.drain())
    expect(await subRow(A.org)).toMatchObject({ pending_plan_key: null, schedule_external_id: null, plan_key: 'growth' })
    // at period end nothing changes
    const periodEnd = fake.subOf(String((await admin(db => db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [A.org])))!.external_id))!.items.data[0].current_period_end
    await deliverAll(webhook, fake.advance(periodEnd - fake.clock + 60))
    expect((await subRow(A.org))!.plan_key).toBe('growth')
  })

  it('cancel at period end with a reason, reactivate before the end; after the end the account is read-only and the data is kept', async () => {
    vi.stubGlobal('fetch', fake.fetch)
    as(sessionOf(A, 'member'))
    expect((await call(cancelRoute.POST, 'POST', { reason: 'too_expensive' })).status).toBe(403)
    as(sessionOf(A))
    expect((await call(cancelRoute.POST, 'POST', { reason: 'because' })).json.error).toBe('invalid_input')
    const c = await call<{ endsAt: string }>(cancelRoute.POST, 'POST', { reason: 'too_expensive', comment: 'Pilot budget ended' })
    expect(c.status).toBe(200)
    const subId = (await subRow(A.org))!.external_id
    const req = stripePosts(fake, `/v1/subscriptions/${subId}`).at(-1)!.params
    expect(Object.fromEntries(req)).toMatchObject({ cancel_at_period_end: 'true', 'cancellation_details[feedback]': 'too_expensive', 'cancellation_details[comment]': 'Pilot budget ended' })
    await deliverAll(webhook, fake.drain())
    expect(await subRow(A.org)).toMatchObject({ status: 'active', cancel_at_period_end: true, cancel_reason: 'too_expensive', cancel_comment: 'Pilot budget ended' })
    const o = await overview(A)
    expect(o.banner).toMatchObject({ cta: 'Reactivate', message: expect.stringMatching(/^Your subscription ends on/) })
    expect((await admin(db => orgEntitlements(db, A.org))).writesAllowed).toBe(true)
    expect(mail.sent.filter(n => n.kind === 'cancel_scheduled')).toHaveLength(1)

    expect((await call(reactivateRoute.POST, 'POST', {})).status).toBe(200)
    await deliverAll(webhook, fake.drain())
    expect(await subRow(A.org)).toMatchObject({ cancel_at_period_end: false, cancel_reason: null })
    expect((await overview(A)).banner).toBeNull()

    // cancel again and let the period end
    expect((await call(cancelRoute.POST, 'POST', { reason: 'unused' })).status).toBe(200)
    await deliverAll(webhook, fake.drain())
    const end = fake.subs.get(subId)!.items.data[0].current_period_end
    const endEvents = fake.advance(end - fake.clock + 60)
    expect(endEvents.map(e => e.type)).toEqual(['customer.subscription.deleted'])
    await deliverAll(webhook, endEvents)
    const row = await subRow(A.org)
    expect(row).toMatchObject({ status: 'canceled', cancel_reason: 'unused' })
    expect(row!.ended_at).toBeTruthy()
    const e = await admin(db => orgEntitlements(db, A.org))
    expect(e.writesAllowed).toBe(false)
    expect(e.billing.reason).toMatch(/cancelled: the account is read-only/)
    expect((await overview(A)).banner).toMatchObject({ tone: 'danger', cta: 'Choose a plan' })
    expect(mail.sent.filter(n => n.kind === 'subscription_canceled')).toHaveLength(1)
    // data kept: the organization, its store connection and its customer record are all still there
    expect(await admin(db => db.one('select id from store_connections where id = $1', [A.conn]))).toBeTruthy()
    expect((await call(reactivateRoute.POST, 'POST', {})).json.error).toBe('already_ended')
  })

  it('out-of-order and duplicate webhooks: an older event never undoes a newer one, a redelivery queues no second notice', async () => {
    fake = newFake()
    vi.stubGlobal('fetch', fake.fetch)
    await admin(async db => { await db.query('delete from billing_subscriptions where org_id = $1', [B.org]); await db.query('delete from billing_customers where org_id = $1', [B.org]) })
    as(sessionOf(B))
    await call(checkoutRoute.POST, 'POST', { plan: 'growth' })
    await deliverAll(webhook, fake.completeCheckout([...fake.sessions.keys()][0]))
    const customer = [...fake.customers.keys()][0]
    // a renewal fails, then the card is updated and the invoice paid
    fake.declineCards = true
    const failedEvents = fake.advance(31 * DAY)
    const paidEvents = fake.payWithNewCard(customer)
    // Stripe delivers the payment first and the (older) failure after it
    await deliverAll(webhook, paidEvents)
    const late = await deliverAll(webhook, failedEvents)
    expect(late.find(x => x.outcome === 'ignored')).toBeTruthy()
    expect((await subRow(B.org))!.status).toBe('active')
    expect((await overview(B)).banner).toBeNull()
    expect(mail.sent.filter(n => n.kind === 'payment_failed')).toHaveLength(0)
    // a redelivered event is a duplicate and sends nothing
    const again = await deliverAll(webhook, paidEvents)
    expect(again.every(x => x.duplicate === true)).toBe(true)
    // a subscription event older than the last applied one is ignored
    const sub = fake.subOf(customer)!
    const stale = { id: `evt_P5stale${Date.now()}`, object: 'event', type: 'customer.subscription.updated', created: fake.clock - 40 * DAY, livemode: false, data: { object: { ...sub, status: 'canceled' } } }
    const staleR = (await deliverAll(webhook, [stale]))[0]
    expect(staleR, JSON.stringify(staleR)).toMatchObject({ outcome: 'ignored' })
    expect((await subRow(B.org))!.status).toBe('active')
    // a payment failure delivered twice notifies once
    fake.declineCards = true
    const f2 = fake.advance(31 * DAY)
    await deliverAll(webhook, f2)
    await deliverAll(webhook, f2.map(e => ({ ...e, id: `${e.id}x` })))
    expect(mail.sent.filter(n => n.kind === 'payment_failed')).toHaveLength(1)
    expect(await notices(B.org)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'payment_failed', status: 'sent', recipient: 'owner.a+second@p5-billing.example' })]))
  })

  it('a notice that cannot be sent stays queued and is retried; without a wired mailer it is recorded as skipped', async () => {
    await admin(db => db.query(`insert into billing_notices (org_id, kind, dedupe_key, recipient, subject, body) values ($1, 'read_only', 'p5-test-retry', $2, 'x', 'y')`, [B.org, B.owner.email]))
    expect(await deliverNotices({ orgId: B.org, notifier: recordingNotifier({ fail: true }) })).toMatchObject({ failed: 1 })
    expect((await notices(B.org)).find(n => n.dedupe_key === 'p5-test-retry')!.status).toBe('pending')
    setBillingNotifier(null)
    expect(await deliverNotices({ orgId: B.org })).toMatchObject({ skipped: 1 })
    expect((await notices(B.org)).find(n => n.dedupe_key === 'p5-test-retry')!.status).toBe('skipped')
  })

  it('a hypothesis plan is refused in live mode: no checkout, no plan change, and the page says why', async () => {
    const f = newFake()
    vi.stubGlobal('fetch', f.fetch)
    process.env.BILLING_MODE = 'live'
    await expect(admin(db => createCheckoutSession(db, { orgId: A.org, plan: 'growth', actor: 'test', appUrl: ORIGIN }))).rejects.toMatchObject({ status: 409, code: 'plan_not_approved' })
    as(sessionOf(B))
    expect((await call(changeRoute.POST, 'POST', { action: 'preview', plan: 'pro' })).json.error).toBe('plan_not_approved')
    const o = await overview(B)
    expect(o.plans.every(p => !p.available && /pricing hypothesis/.test(p.refusal ?? ''))).toBe(true)
    expect(f.calls).toHaveLength(0)
  })

  it('a Shopify-billed organization sees its Shopify subscription and is sent to Shopify for changes', async () => {
    const f = newFake()
    vi.stubGlobal('fetch', f.fetch)
    as(SESSIONS.northwind)
    const o = (await call<Overview>(billingRoute.GET, 'GET')).json
    expect(o.provider).toBe('shopify')
    expect(o.shopify).not.toBeNull()
    expect(o.banner).toBeNull()
    for (const [h, body] of [[checkoutRoute.POST, { plan: 'growth' }], [changeRoute.POST, { action: 'preview', plan: 'pro' }], [cancelRoute.POST, { reason: 'other' }]] as const) {
      const r = await call(h, 'POST', body)
      expect(r.status, JSON.stringify(r.json)).toBe(409)
      expect(r.json.error).toBe('use_shopify_billing')
    }
    expect(f.calls).toHaveLength(0)
  })

  it('organization isolation: one organization cannot see or confirm another\'s change, and merchants cannot read the finance report', async () => {
    vi.stubGlobal('fetch', fake.fetch)
    // B pays its open invoice (it was past due after the previous test)
    const bCustomer = (await admin(db => db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [B.org])))!.external_id
    await deliverAll(webhook, fake.payWithNewCard(bCustomer))
    as(sessionOf(B))
    const pv = await call<{ preview: { changeId: string } }>(changeRoute.POST, 'POST', { action: 'preview', plan: 'pro' })
    expect(pv.status).toBe(200)
    as(sessionOf(A))
    expect((await call(changeRoute.POST, 'POST', { action: 'confirm', changeId: pv.json.preview.changeId })).status).toBe(404)
    const a = await overview(A), b = await overview(B)
    expect(a.subscription!.status).toBe('canceled')
    expect(b.subscription!.status).toBe('active')
    as(sessionOf(A))
    const stA = (await call(statusRoute.GET, 'GET')).json
    expect(stA, JSON.stringify(stA)).toMatchObject({ status: 'canceled', readOnly: true })
    expect((await call(financeRoute.GET, 'GET', undefined, '/api/staff/finance')).status).toBe(403)
    // staff read the finance report, and cannot change a merchant's subscription
    as(SESSIONS.staff)
    const fin = await call<{ summary: { mrr: { testCents: number; pricesAreHypotheses: boolean } }; orgs: { orgId: string; mrrCents: number }[] }>(financeRoute.GET, 'GET', undefined, '/api/staff/finance')
    expect(fin.status).toBe(200)
    expect(fin.json.summary.mrr.pricesAreHypotheses).toBe(true)
    expect(fin.json.orgs.find(o => o.orgId === B.org)!.mrrCents).toBe(7900)
    expect(fin.json.orgs.find(o => o.orgId === A.org)!.mrrCents).toBe(0)
    expect((await call(cancelRoute.POST, 'POST', { reason: 'other' })).status).toBe(403)
  })
  it('customer.subscription.updated with status unpaid makes the account read-only at once and tells the owner', async () => {
    const sub = fake.subOf((await admin(db => db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [B.org])))!.external_id)!
    const ev = { id: `evt_P5unpaid${Date.now()}`, object: 'event', type: 'customer.subscription.updated', created: fake.clock + 60, livemode: false, data: { object: { ...sub, status: 'unpaid' } } }
    expect((await deliverAll(webhook, [ev]))[0]).toMatchObject({ outcome: 'processed' })
    const e = await admin(db => orgEntitlements(db, B.org))
    expect(e.writesAllowed).toBe(false)
    expect(e.billing.reason).toMatch(/unpaid: agents are paused until payment succeeds/)
    expect((await overview(B)).banner).toMatchObject({ tone: 'danger', cta: 'Update payment method' })
    expect(mail.sent.filter(n => n.kind === 'read_only').map(n => n.to)).toEqual([B.owner.email])
  })
})
