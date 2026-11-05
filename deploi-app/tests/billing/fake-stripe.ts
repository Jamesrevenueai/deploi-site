/**
 * A fake Stripe for tests: an in-memory account that answers the documented REST shapes (API version
 * 2025-03-31.basil: the period sits on subscription items, an invoice's subscription under
 * parent.subscription_details, line proration under parent.subscription_item_details) for the endpoints
 * billing uses, and simulates what Stripe itself does over time (trial end, renewal, retries, schedules),
 * emitting the webhook events it would send. No request leaves the machine.
 *
 * It enforces what the real API enforces and the app must get right: a secret test key, the pinned
 * Stripe-Version header, an Idempotency-Key on every POST (a replay returns the first response; the same key
 * with different parameters is an idempotency_error), and no item or cancellation change on a subscription a
 * schedule controls (release it first).
 *
 * Used directly as a fetch implementation (vitest) and over HTTP by the Playwright spec (serveFakeStripe).
 */
import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'

export const FAKE_API_VERSION = '2025-03-31.basil'
const DAY = 86400

type Obj = Record<string, unknown>
type Price = { id: string; unit_amount: number; currency: string; nickname: string }
type Item = { id: string; object: 'subscription_item'; price: { id: string; object: 'price'; unit_amount: number; currency: string }; quantity: number; current_period_start: number; current_period_end: number }
type Sub = {
  id: string; object: 'subscription'; customer: string; status: string; items: { object: 'list'; data: Item[] }; metadata: Obj; cancel_at_period_end: boolean; canceled_at: number | null; ended_at: number | null
  trial_start: number | null; trial_end: number | null; schedule: string | null; cancellation_details: { feedback: string | null; comment: string | null }; default_payment_method: string | null; livemode: false; created: number
  trial_settings?: { end_behavior: { missing_payment_method: string } }
}
type Invoice = { id: string; object: 'invoice'; customer: string; status: string; amount_due: number; amount_paid: number; currency: string; created: number; number: string; attempt_count: number; next_payment_attempt: number | null
  hosted_invoice_url: string; invoice_pdf: string; billing_reason: string; parent: { type: 'subscription_details'; subscription_details: { subscription: string } }; lines: { object: 'list'; data: Obj[] } }
type Schedule = { id: string; object: 'subscription_schedule'; subscription: string; status: string; end_behavior: string; phases: { start_date: number; end_date: number; items: { price: string; quantity: number }[]; metadata?: Obj }[] }
type Pm = { id: string; object: 'payment_method'; type: 'card'; card: { brand: string; last4: string; exp_month: number; exp_year: number }; customer: string }
export type FakeEvent = { id: string; object: 'event'; type: string; created: number; livemode: false; api_version: string; data: { object: Obj } }
export type FakeCall = { method: string; path: string; params: URLSearchParams; headers: Record<string, string> }

/** Parse Stripe's bracketed form encoding back into nested objects and arrays. */
export function parseForm(body: URLSearchParams): Obj {
  const out: Obj = {}
  for (const [k, v] of body) {
    const keys = k.replace(/\]/g, '').split('[')
    let cur: Obj = out
    keys.forEach((key, i) => {
      if (i === keys.length - 1) { cur[key] = v; return }
      const nextIsIndex = /^\d+$/.test(keys[i + 1])
      cur[key] ??= nextIsIndex ? [] : {}
      cur = cur[key] as Obj
    })
  }
  return out
}

export class FakeStripe {
  calls: FakeCall[] = []
  events: FakeEvent[] = []
  customers = new Map<string, Obj & { id: string; invoice_settings: { default_payment_method: string | null } }>()
  sessions = new Map<string, Obj & { id: string; params: Obj; completed: boolean }>()
  subs = new Map<string, Sub>()
  invoices = new Map<string, Invoice>()
  schedules = new Map<string, Schedule>()
  pms = new Map<string, Pm>()
  prices = new Map<string, Price>()
  /** seconds; starts at the real clock, moved by advance() */
  clock = Math.floor(Date.now() / 1000)
  /** the next card charge fails (true) or every one does (`always`) */
  declineCards: false | true | 'always' = false
  private idem = new Map<string, { params: string; status: number; json: Obj }>()
  private faults: { status: number; json: Obj; headers?: Record<string, string> }[] = []
  private seq = 0

  constructor(prices: Price[] = []) { for (const p of prices) this.prices.set(p.id, p) }

  private id(prefix: string) { this.seq++; return `${prefix}_Fk${this.seq.toString(36)}${Math.random().toString(36).slice(2, 8)}` }
  private emit(type: string, object: Obj) {
    const ev: FakeEvent = { id: this.id('evt'), object: 'event', type, created: this.clock, livemode: false, api_version: FAKE_API_VERSION, data: { object: JSON.parse(JSON.stringify(object)) } }
    this.events.push(ev)
    return ev
  }
  /** Take the events emitted since the last drain (in the order Stripe created them). */
  drain(): FakeEvent[] { const e = this.events; this.events = []; return e }
  /** The next requests answer with these errors (then normal service resumes). */
  fail(...faults: { status: number; json?: Obj; headers?: Record<string, string> }[]) { for (const f of faults) this.faults.push({ status: f.status, json: f.json ?? { error: { type: f.status >= 500 ? 'api_error' : 'invalid_request_error', message: 'fault injected' } }, headers: f.headers }) }

  // ------------------------------------------------------------ HTTP surface
  handle(method: string, path: string, params: URLSearchParams, headers: Record<string, string>): { status: number; json: Obj; headers?: Record<string, string> } {
    this.calls.push({ method, path, params, headers })
    const err = (status: number, type: string, message: string, extra: Obj = {}) => ({ status, json: { error: { type, message, ...extra } } })
    if (!/^Bearer (sk|rk)_test_/.test(headers.authorization ?? '')) return err(401, 'authentication_error', 'Invalid API Key provided')
    if (headers['stripe-version'] !== FAKE_API_VERSION) return err(400, 'invalid_request_error', `Stripe-Version must be ${FAKE_API_VERSION} for this fake`)
    if (method === 'POST' && !headers['idempotency-key']) return err(400, 'invalid_request_error', 'this fake requires an Idempotency-Key on every POST')
    const fault = this.faults.shift()
    if (fault) return fault
    const key = method === 'POST' ? `${headers['idempotency-key']}` : null
    const sig = `${method} ${path} ${params.toString()}`
    if (key && this.idem.has(key)) {
      const prev = this.idem.get(key)!
      if (prev.params !== sig) return err(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with.')
      return { status: prev.status, json: prev.json, headers: { 'idempotent-replayed': 'true' } }
    }
    let r: { status: number; json: Obj }
    try { r = this.route(method, path, parseForm(params)) } catch (e) { r = err(400, 'invalid_request_error', (e as Error).message) }
    if (key && r.status < 500) this.idem.set(key, { params: sig, ...r })
    return r
  }

  /** A fetch implementation over handle(). */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const method = (init?.method ?? 'GET').toUpperCase()
    const params = method === 'POST' ? new URLSearchParams(String(init?.body ?? '')) : url.searchParams
    const r = this.handle(method, url.pathname, params, headers)
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', 'request-id': `req_${this.seq}`, ...(r.headers ?? {}) } })
  }) as unknown as typeof fetch

  private route(method: string, path: string, p: Obj): { status: number; json: Obj } {
    const ok = (json: Obj) => ({ status: 200, json })
    const nf = (what: string) => ({ status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}` } } })
    let m: RegExpMatchArray | null
    if (method === 'POST' && path === '/v1/customers') {
      const c = { id: this.id('cus'), object: 'customer', livemode: false, email: p.email ?? null, name: p.name ?? null, metadata: p.metadata ?? {}, invoice_settings: { default_payment_method: null as string | null } }
      this.customers.set(c.id, c); return ok(c)
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/customers\/(cus_\w+)$/))) {
      const c = this.customers.get(m[1]); if (!c) return nf('customer')
      const expand = Object.values((p.expand ?? {}) as Obj)
      const pm = c.invoice_settings.default_payment_method
      return ok({ ...c, invoice_settings: { default_payment_method: expand.includes('invoice_settings.default_payment_method') && pm ? this.pms.get(pm) ?? null : pm } })
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      if (p.mode !== 'subscription') throw new Error('mode must be subscription')
      if (!this.customers.has(String(p.customer))) return nf('customer')
      const price = ((p.line_items as Obj[] | undefined)?.[0] as Obj | undefined)?.price as string
      if (!this.prices.has(price)) return nf(`price: '${price}'`)
      const s = { id: this.id('cs_test'), object: 'checkout.session', mode: 'subscription', customer: p.customer, client_reference_id: p.client_reference_id, metadata: p.metadata ?? {}, url: '', status: 'open', subscription: null as string | null, params: p, completed: false }
      s.url = `https://checkout.stripe.com/c/pay/${s.id}`
      this.sessions.set(s.id, s); return ok(s)
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      if (!this.customers.has(String(p.customer))) return nf('customer')
      const id = this.id('bps'); return ok({ id, object: 'billing_portal.session', customer: p.customer, return_url: p.return_url, url: `https://billing.stripe.com/p/session/test_${id}` })
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/subscriptions\/(sub_\w+)$/))) {
      const s = this.subs.get(m[1]); if (!s) return nf('subscription')
      const expand = Object.values((p.expand ?? {}) as Obj)
      return ok({ ...s, default_payment_method: expand.includes('default_payment_method') && s.default_payment_method ? this.pms.get(s.default_payment_method) ?? null : s.default_payment_method })
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/subscriptions\/(sub_\w+)$/))) return ok(this.updateSub(m[1], p))
    if (method === 'DELETE' && (m = path.match(/^\/v1\/subscriptions\/(sub_\w+)$/))) {
      const s = this.subs.get(m[1]); if (!s) return nf('subscription')
      this.endSub(s); return ok(s)
    }
    if (method === 'POST' && path === '/v1/invoices/create_preview') return ok(this.preview(p))
    if (method === 'GET' && path === '/v1/invoices') {
      const data = [...this.invoices.values()].filter(i => i.customer === p.customer).sort((a, b) => b.created - a.created).slice(0, Number(p.limit ?? 10))
      return ok({ object: 'list', data, has_more: false, url: '/v1/invoices' })
    }
    if (method === 'POST' && path === '/v1/subscription_schedules') {
      const s = this.subs.get(String(p.from_subscription)); if (!s) return nf('subscription')
      if (s.schedule) throw new Error('You cannot create a subscription schedule from a subscription that is already attached to a schedule.')
      const it = s.items.data[0]
      const sc: Schedule = { id: this.id('sub_sched'), object: 'subscription_schedule', subscription: s.id, status: 'active', end_behavior: 'release', phases: [{ start_date: it.current_period_start, end_date: it.current_period_end, items: [{ price: it.price.id, quantity: it.quantity }] }] }
      this.schedules.set(sc.id, sc); s.schedule = sc.id
      this.emit('customer.subscription.updated', s)
      return ok(sc)
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/subscription_schedules\/(sub_sched_\w+)\/release$/))) {
      const sc = this.schedules.get(m[1]); if (!sc) return nf('subscription schedule')
      if (sc.status !== 'active') throw new Error(`You cannot release a subscription schedule that is currently in the \`${sc.status}\` status.`)
      sc.status = 'released'
      const s = this.subs.get(sc.subscription)!; s.schedule = null
      this.emit('customer.subscription.updated', s)
      return ok(sc)
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/subscription_schedules\/(sub_sched_\w+)$/))) {
      const sc = this.schedules.get(m[1]); if (!sc) return nf('subscription schedule')
      const phases = Object.values((p.phases ?? {}) as Obj).map(ph => ph as Obj)
      if (!phases.length) throw new Error('phases are required')
      const first = phases[0]
      if (Number(first.start_date) !== sc.phases[0].start_date) throw new Error('You can not modify the start date of the current phase.')
      const out: Schedule['phases'] = []
      let start = Number(first.start_date)
      for (const ph of phases) {
        const items = Object.values((ph.items ?? {}) as Obj).map(x => ({ price: String((x as Obj).price), quantity: Number((x as Obj).quantity ?? 1) }))
        for (const it of items) if (!this.prices.has(it.price)) return nf(`price: '${it.price}'`)
        const duration = ph.duration as Obj | undefined
        const end = ph.end_date ? Number(ph.end_date) : duration ? start + 30 * DAY * Number(duration.interval_count ?? 1) : NaN
        if (!Number.isFinite(end)) throw new Error('each phase needs an end_date or a duration')
        out.push({ start_date: start, end_date: end, items, metadata: (ph.metadata ?? {}) as Obj })
        start = end
      }
      sc.phases = out; sc.end_behavior = String(p.end_behavior ?? sc.end_behavior)
      return ok(sc)
    }
    return { status: 404, json: { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${method}: ${path})` } } }
  }

  private priceObj(id: string) { const pr = this.prices.get(id)!; return { id, object: 'price' as const, unit_amount: pr.unit_amount, currency: pr.currency } }

  private updateSub(id: string, p: Obj): Sub {
    const s = this.subs.get(id); if (!s) throw new Error('No such subscription')
    const changesItems = p.items !== undefined, changesCancel = p.cancel_at_period_end !== undefined
    if (s.schedule && (changesItems || changesCancel)) throw new Error(`The subscription is managed by the subscription schedule \`${s.schedule}\`, and updating any cancelation behavior directly is not allowed. Please update the schedule instead.`)
    if (s.status === 'canceled') throw new Error('A canceled subscription can only update its cancellation_details and metadata.')
    if (changesItems) {
      const item = Object.values(p.items as Obj)[0] as Obj
      const it = s.items.data.find(x => x.id === item.id); if (!it) throw new Error('No such subscription item')
      const price = String(item.price); if (!this.prices.has(price)) throw new Error(`No such price: '${price}'`)
      if (p.proration_behavior === 'create_prorations') {
        const at = Number(p.proration_date ?? this.clock)
        for (const line of this.prorationLines(it, price, at)) this.pendingProrations.push({ customer: s.customer, sub: s.id, line })
      }
      it.price = this.priceObj(price)
    }
    if (changesCancel) {
      s.cancel_at_period_end = p.cancel_at_period_end === 'true'
      s.canceled_at = s.cancel_at_period_end ? this.clock : null
      const d = (p.cancellation_details ?? {}) as Obj
      s.cancellation_details = s.cancel_at_period_end ? { feedback: (d.feedback as string) ?? null, comment: (d.comment as string) ?? null } : { feedback: null, comment: null }
    }
    if (p.metadata) s.metadata = { ...s.metadata, ...(p.metadata as Obj) }
    this.emit('customer.subscription.updated', s)
    return s
  }

  private pendingProrations: { customer: string; sub: string; line: Obj }[] = []

  private prorationLines(it: Item, newPrice: string, at: number): Obj[] {
    const span = it.current_period_end - it.current_period_start
    const left = Math.max(0, it.current_period_end - at)
    const f = span > 0 ? left / span : 0
    const old = this.prices.get(it.price.id)!, nu = this.prices.get(newPrice)!
    const date = new Date(at * 1000).toISOString().slice(0, 10)
    const line = (amount: number, description: string, proration: boolean, price: Price) => ({ object: 'line_item', amount, currency: price.currency, description, parent: { type: 'subscription_item_details', subscription_item_details: { subscription_item: it.id, proration } }, pricing: { price_details: { price: price.id } } })
    return [line(-Math.round(old.unit_amount * f), `Unused time on ${old.nickname} after ${date}`, true, old), line(Math.round(nu.unit_amount * f), `Remaining time on ${nu.nickname} after ${date}`, true, nu)]
  }

  private preview(p: Obj): Obj {
    const s = this.subs.get(String(p.subscription)); if (!s) throw new Error('No such subscription')
    const d = (p.subscription_details ?? {}) as Obj
    const item = Object.values((d.items ?? {}) as Obj)[0] as Obj | undefined
    const it = s.items.data[0]
    const nextPrice = item?.price ? String(item.price) : it.price.id
    if (!this.prices.has(nextPrice)) throw new Error(`No such price: '${nextPrice}'`)
    const nu = this.prices.get(nextPrice)!
    const lines: Obj[] = d.proration_behavior === 'create_prorations' && nextPrice !== it.price.id ? this.prorationLines(it, nextPrice, Number(d.proration_date ?? this.clock)) : []
    lines.push({ object: 'line_item', amount: nu.unit_amount, currency: nu.currency, description: `1 × ${nu.nickname} (at $${(nu.unit_amount / 100).toFixed(2)} / month)`, parent: { type: 'subscription_item_details', subscription_item_details: { subscription_item: it.id, proration: false } } })
    const total = lines.reduce((a, l) => a + Number(l.amount), 0)
    return { object: 'invoice', id: null, customer: s.customer, currency: nu.currency, amount_due: Math.max(0, total), total, subtotal: total, period_end: it.current_period_end, lines: { object: 'list', data: lines } }
  }

  // ------------------------------------------------------------ what Stripe does on its own
  addCard(customer: string, card: Partial<Pm['card']> = {}): Pm {
    const pm: Pm = { id: this.id('pm'), object: 'payment_method', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, ...card }, customer }
    this.pms.set(pm.id, pm)
    this.customers.get(customer)!.invoice_settings.default_payment_method = pm.id
    return pm
  }

  /** The customer finishes Checkout: a subscription (trialing when the session asked for a trial) and its first invoice. */
  completeCheckout(sessionId: string, opts: { withCard?: boolean } = {}): FakeEvent[] {
    const cs = this.sessions.get(sessionId); if (!cs) throw new Error('no such session')
    if (cs.completed) throw new Error('session already completed')
    const p = cs.params
    const customer = String(p.customer)
    const sd = (p.subscription_data ?? {}) as Obj
    const trialDays = Number(sd.trial_period_days ?? 0)
    const withCard = opts.withCard ?? !(trialDays > 0 && p.payment_method_collection === 'if_required')
    if (withCard && !this.customers.get(customer)!.invoice_settings.default_payment_method) this.addCard(customer)
    const price = String(((p.line_items as Obj[])[0] as Obj).price)
    const start = this.clock
    const end = trialDays > 0 ? start + trialDays * DAY : start + 30 * DAY
    const it: Item = { id: this.id('si'), object: 'subscription_item', price: this.priceObj(price), quantity: 1, current_period_start: start, current_period_end: end }
    const sub: Sub = { id: this.id('sub'), object: 'subscription', customer, status: trialDays > 0 ? 'trialing' : 'active', items: { object: 'list', data: [it] }, metadata: (sd.metadata ?? {}) as Obj,
      cancel_at_period_end: false, canceled_at: null, ended_at: null, trial_start: trialDays > 0 ? start : null, trial_end: trialDays > 0 ? end : null, schedule: null,
      cancellation_details: { feedback: null, comment: null }, default_payment_method: null, livemode: false, created: start,
      ...(trialDays > 0 ? { trial_settings: { end_behavior: { missing_payment_method: String(((sd.trial_settings as Obj | undefined)?.end_behavior as Obj | undefined)?.missing_payment_method ?? 'create_invoice') } } } : {}) }
    this.subs.set(sub.id, sub)
    cs.completed = true; cs.subscription = sub.id; cs.status = 'complete'
    this.emit('customer.subscription.created', sub)
    this.emit('checkout.session.completed', { id: cs.id, object: 'checkout.session', mode: 'subscription', customer, client_reference_id: cs.client_reference_id, subscription: sub.id, metadata: cs.metadata, status: 'complete' })
    this.invoice(sub, trialDays > 0 ? 0 : this.prices.get(price)!.unit_amount, 'subscription_create')
    return this.drain()
  }

  private invoice(sub: Sub, amount: number, reason: string): Invoice {
    const extra = this.pendingProrations.filter(x => x.sub === sub.id)
    this.pendingProrations = this.pendingProrations.filter(x => x.sub !== sub.id)
    const total = amount + extra.reduce((a, x) => a + Number(x.line.amount), 0)
    const inv: Invoice = { id: this.id('in'), object: 'invoice', customer: sub.customer, status: 'open', amount_due: Math.max(0, total), amount_paid: 0, currency: sub.items.data[0].price.currency, created: this.clock,
      number: `FAKE-${this.invoices.size + 1}`, attempt_count: 0, next_payment_attempt: null, hosted_invoice_url: '', invoice_pdf: '', billing_reason: reason,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } }, lines: { object: 'list', data: extra.map(x => x.line) } }
    inv.hosted_invoice_url = `https://invoice.stripe.com/i/acct_fake/${inv.id}`; inv.invoice_pdf = `https://pay.stripe.com/invoice/acct_fake/${inv.id}/pdf`
    this.invoices.set(inv.id, inv)
    this.emit('invoice.created', inv)
    this.attempt(sub, inv)
    return inv
  }

  /** Stripe's retry schedule for this fake: 3, 5 and 7 days after the first failure, then unpaid. */
  static RETRY_DAYS = [3, 5, 7]

  private attempt(sub: Sub, inv: Invoice) {
    if (inv.amount_due === 0) { inv.status = 'paid'; this.emit('invoice.paid', inv); return }
    inv.attempt_count++
    const card = this.customers.get(sub.customer)!.invoice_settings.default_payment_method
    const declines = this.declineCards === 'always' || this.declineCards === true
    if (card && !declines) {
      inv.status = 'paid'; inv.amount_paid = inv.amount_due; inv.next_payment_attempt = null
      if (['past_due', 'unpaid', 'trialing', 'incomplete'].includes(sub.status)) { sub.status = 'active'; this.emit('customer.subscription.updated', sub) }
      this.emit('invoice.paid', inv)
      return
    }
    if (this.declineCards === true) this.declineCards = false
    const wait = FakeStripe.RETRY_DAYS[inv.attempt_count - 1]
    inv.next_payment_attempt = wait ? this.clock + wait * DAY : null
    this.emit('invoice.payment_failed', inv)
    const next = wait ? 'past_due' : 'unpaid'
    if (sub.status !== next) { sub.status = next; this.emit('customer.subscription.updated', sub) }
  }

  /** Move the clock and let Stripe act: trials end, periods renew (applying schedules and cancellations), failed invoices are retried. */
  advance(seconds: number): FakeEvent[] {
    const target = this.clock + seconds
    for (;;) {
      const due: { at: number; run: () => void }[] = []
      for (const s of this.subs.values()) {
        if (s.status === 'canceled') continue
        const it = s.items.data[0]
        if (it.current_period_end <= target) due.push({ at: it.current_period_end, run: () => this.renew(s) })
      }
      for (const inv of this.invoices.values()) {
        if (inv.status === 'open' && inv.next_payment_attempt && inv.next_payment_attempt <= target) {
          const sub = this.subs.get(inv.parent.subscription_details.subscription)!
          if (sub.status !== 'canceled') due.push({ at: inv.next_payment_attempt, run: () => this.attempt(sub, inv) })
        }
      }
      if (!due.length) break
      due.sort((a, b) => a.at - b.at)
      this.clock = due[0].at
      due[0].run()
    }
    this.clock = target
    return this.drain()
  }

  private renew(s: Sub) {
    const it = s.items.data[0]
    if (s.cancel_at_period_end) { this.endSub(s); return }
    const sc = s.schedule ? this.schedules.get(s.schedule) : undefined
    if (sc) {
      const nextPhase = sc.phases.find(ph => ph.start_date === it.current_period_end)
      if (nextPhase) {
        it.price = this.priceObj(nextPhase.items[0].price)
        if (nextPhase.metadata) s.metadata = { ...s.metadata, ...nextPhase.metadata }
        if (sc.end_behavior === 'release' && nextPhase === sc.phases[sc.phases.length - 1]) { sc.status = 'released'; s.schedule = null }
      }
    }
    const wasTrial = s.status === 'trialing'
    it.current_period_start = it.current_period_end
    it.current_period_end = it.current_period_start + 30 * DAY
    if (wasTrial) {
      // the trial ended: without a payment method (create_invoice) the invoice is attempted and fails
      const card = this.customers.get(s.customer)!.invoice_settings.default_payment_method
      if (!card && s.trial_settings?.end_behavior.missing_payment_method === 'cancel') { this.endSub(s); return }
      s.status = card ? 'active' : 'past_due'
    }
    this.emit('customer.subscription.updated', s)
    this.invoice(s, it.price.unit_amount, 'subscription_cycle')
  }

  private endSub(s: Sub) {
    s.status = 'canceled'; s.ended_at = this.clock; s.canceled_at ??= this.clock
    if (s.schedule) { const sc = this.schedules.get(s.schedule); if (sc) sc.status = 'canceled'; s.schedule = null }
    this.emit('customer.subscription.deleted', s)
  }

  /** Time passes until this trial's end (the clock stays put; the trial is shortened to end now). */
  endTrialNow(subId: string): FakeEvent[] {
    const s = this.subs.get(subId)!
    s.items.data[0].current_period_end = this.clock; s.trial_end = this.clock
    this.renew(s)
    return this.drain()
  }

  /** Stripe's 3-day warning before a trial ends. */
  trialWillEnd(subId: string): FakeEvent[] { this.emit('customer.subscription.trial_will_end', this.subs.get(subId)!); return this.drain() }

  /** The customer adds a card in the portal and the open invoice is retried and paid. */
  payWithNewCard(customer: string): FakeEvent[] {
    this.addCard(customer); this.declineCards = false
    for (const inv of this.invoices.values()) if (inv.customer === customer && inv.status === 'open') this.attempt(this.subs.get(inv.parent.subscription_details.subscription)!, inv)
    return this.drain()
  }

  subOf(customer: string): Sub | undefined { return [...this.subs.values()].filter(s => s.customer === customer).sort((a, b) => b.created - a.created)[0] }
}

/** Sign an event the way Stripe does (Stripe-Signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">). */
export function signFakeEvent(raw: string, secret: string, nowSec = Math.floor(Date.now() / 1000)) {
  return `t=${nowSec},v1=${createHmac('sha256', secret).update(`${nowSec}.${raw}`, 'utf8').digest('hex')}`
}

/** Serve the fake over HTTP on 127.0.0.1 (the Playwright spec points STRIPE_API_BASE here, test mode only). */
export function serveFakeStripe(fake: FakeStripe, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v ?? '']))
      const method = (req.method ?? 'GET').toUpperCase()
      const r = fake.handle(method, url.pathname, method === 'POST' ? new URLSearchParams(body) : url.searchParams, headers)
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) })
      res.end(JSON.stringify(r.json))
    })
  })
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)) })
}
