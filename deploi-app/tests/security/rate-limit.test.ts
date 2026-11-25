/**
 * The Postgres-backed rate limiter (lib/security/rate-limit.ts, migration 44): atomic under concurrency,
 * window rollover with the sliding estimate, per-key and per-bucket isolation, configuration from env,
 * the 429 + Retry-After answer, fail-open when the database is unreachable, and the limits wired into
 * the lead form, the merchant API ceiling (resolveActor) and the webhook rejection ceiling.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prepareDb, ORG_NW, SESSIONS } from '../db/helpers'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'

let cookieValue: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === DEV_COOKIE_NAME && cookieValue ? { value: cookieValue } : undefined), set: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))

const ready = await prepareDb()
const rl = await import('../../lib/security/rate-limit')
const run = randomBytes(4).toString('hex')
const key = (n: string) => `test:${run}:${n}`
/** a fixed instant one day ahead, `offsetS` into a 600 s window (future, so cleanup never removes it mid-test) */
const at = (windows: number, offsetS: number) => new Date((Math.floor(Date.now() / 600_000) + 144 + windows) * 600_000 + offsetS * 1000)

describe('rate limit decisions (pure)', () => {
  it('fixed window with no previous window: allowed up to the limit, then refused with the rest of the window', () => {
    expect(rl.decide(5, 60, 5, 0, 10_000)).toMatchObject({ allowed: true, remaining: 0 })
    const r = rl.decide(5, 60, 6, 0, 10_000)
    expect(r.allowed).toBe(false)
    expect(r.retryAfterS).toBeGreaterThanOrEqual(50)
    expect(r.retryAfterS).toBeLessThanOrEqual(120)
  })
  it('the previous window weighs in linearly (sliding estimate) and Retry-After is when it has decayed enough', () => {
    // 10 hits last window, 0 now, limit 10: at 10% into the window 9 + 1 = 10 is allowed; 11 would not be
    expect(rl.decide(10, 100, 1, 10, 10_000).allowed).toBe(true)
    const r = rl.decide(10, 100, 2, 10, 10_000) // 9 + 2 = 11
    expect(r.allowed).toBe(false)
    // needs 10 * (1 - e/100) + 3 <= 10 -> e >= 30 s, now at 10 s -> 20 s
    expect(r.retryAfterS).toBe(20)
  })
  it('limits come from RATE_LIMIT_<BUCKET>=<limit>/<seconds>, and a malformed value keeps the default', () => {
    expect(rl.bucketConfig('lead', { RATE_LIMIT_LEAD: '50/60' })).toMatchObject({ limit: 50, windowS: 60 })
    expect(rl.bucketConfig('lead', { RATE_LIMIT_LEAD: 'lots' })).toEqual(rl.BUCKETS.lead)
    expect(rl.bucketConfig('lead', { RATE_LIMIT_LEAD: '0/60' })).toEqual(rl.BUCKETS.lead)
    for (const [name, b] of Object.entries(rl.BUCKETS)) {
      expect(b.limit, name).toBeGreaterThan(0)
      expect(b.why.length, name).toBeGreaterThan(10)
      // documented decision: fail open everywhere (the guarded request needs the same database)
      expect(b.onError, name).toBe('open')
    }
  })
  it('client IP: first x-forwarded-for hop, else x-real-ip; IPv6 by /64; IPv4-mapped as IPv4', () => {
    expect(rl.clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7')
    expect(rl.clientIp(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2')
    expect(rl.clientIp(new Headers())).toBeNull()
    expect(rl.ipKey(new Headers())).toBe('ip:unknown')
    expect(rl.normalizeIp('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::/64')
    expect(rl.normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rl.normalizeIp('2001:0db8:0000:0012::ffff')).toBe('2001:db8:0:12::/64')
    expect(rl.normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1')
  })
  it('429 answer: status, Retry-After, rate-limit headers and a JSON body', async () => {
    const res = rl.tooManyRequests({ allowed: false, limit: 5, remaining: 0, retryAfterS: 42 }, { vary: 'origin' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(res.headers.get('ratelimit-limit')).toBe('5')
    expect(res.headers.get('vary')).toBe('origin')
    expect(await res.json()).toMatchObject({ ok: false, error: 'rate_limited', retryAfter: 42 })
  })
})

describe.skipIf(!ready)('rate limiter against Postgres', () => {
  it('N parallel hits never allow more than the limit, and the counter sees every hit exactly once', async () => {
    const k = key('parallel')
    const results = await Promise.all(Array.from({ length: 60 }, () => rl.hit('lead', k, { limit: 10, windowS: 600, at: at(0, 30) })))
    expect(results.filter(r => r.allowed)).toHaveLength(10)
    const { admin } = await import('../../lib/db')
    const row = await admin(db => db.one<{ hits: number }>('select hits from rate_limits where bucket = $1 and key = $2', ['lead', k]))
    expect(row?.hits).toBe(60)
  })

  it('window rollover: refused at the end of a full window, still limited early in the next (sliding), free once the old window has decayed', async () => {
    const k = key('rollover')
    const o = { limit: 4, windowS: 600 }
    for (let i = 0; i < 4; i++) expect((await rl.hit('lead', k, { ...o, at: at(0, 100 + i) })).allowed).toBe(true)
    const refused = await rl.hit('lead', k, { ...o, at: at(0, 500) })
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterS).toBeGreaterThanOrEqual(100)
    // next window, 1% in: the previous 5 hits weigh ~4.95, so even one more is refused
    expect((await rl.hit('lead', k, { ...o, at: at(1, 6) })).allowed).toBe(false)
    // 3/4 into the next window: 5 * 0.25 + 2 (the refused one above + this one) = 3.25 <= 4
    expect((await rl.hit('lead', k, { ...o, at: at(1, 450) })).allowed).toBe(true)
    // two windows on, nothing of the first window counts
    expect((await rl.hit('lead', k, { ...o, at: at(3, 1) })).allowed).toBe(true)
  })

  it('keys and buckets are isolated', async () => {
    const o = { limit: 2, windowS: 600, at: at(0, 10) }
    for (let i = 0; i < 3; i++) await rl.hit('lead', key('iso-a'), o)
    expect((await rl.hit('lead', key('iso-a'), o)).allowed).toBe(false)
    expect((await rl.hit('lead', key('iso-b'), o)).allowed).toBe(true)
    expect((await rl.hit('unsubscribe', key('iso-a'), o)).allowed).toBe(true)
  })

  it('cleanup removes expired windows only', async () => {
    const { admin } = await import('../../lib/db')
    const k = key('cleanup')
    await rl.hit('lead', k, { limit: 1, windowS: 60, at: new Date(Date.now() - 3600_000) })
    await rl.hit('lead', k, { limit: 1, windowS: 600, at: at(0, 1) })
    expect(await rl.cleanupRateLimits()).toBeGreaterThanOrEqual(1)
    const rows = await admin(db => db.query('select window_start from rate_limits where bucket = $1 and key = $2', ['lead', k]))
    expect(rows).toHaveLength(1)
  })

  it('user roles cannot read or write the counters, nor call the functions', async () => {
    const { withUser } = await import('../../lib/db')
    await expect(withUser(SESSIONS.northwind, db => db.query('select * from rate_limits'))).rejects.toThrow(/permission denied/)
    await expect(withUser(SESSIONS.northwind, db => db.query("select * from rate_limit_hit('lead', 'x', 60)"))).rejects.toThrow(/permission denied/)
  })

  it('RATE_LIMITS=off disables every limit', async () => {
    process.env.RATE_LIMITS = 'off'
    try {
      for (let i = 0; i < 3; i++) expect((await rl.hit('lead', key('off'), { limit: 1, windowS: 600 })).allowed).toBe(true)
    } finally { delete process.env.RATE_LIMITS }
  })

  it('the lead form answers 429 with Retry-After and CORS headers past the per-IP limit; another IP is unaffected', async () => {
    const { POST } = await import('../../app/api/public/lead/route')
    const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
    const post = (from: string) => POST(new Request('http://localhost/api/public/lead', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://getdeploi.com', 'x-forwarded-for': `${from}, 10.0.0.1` }, body: '{' }))
    for (let i = 0; i < rl.BUCKETS.lead.limit; i++) expect((await post(ip)).status).toBe(400)
    const r = await post(ip)
    expect(r.status).toBe(429)
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(r.headers.get('access-control-allow-origin')).toBe('https://getdeploi.com')
    expect((await post(`${ip.split('.').slice(0, 3).join('.')}.251`)).status).toBe(400)
  })

  it('merchant writes: resolveActor({ mutating }) enforces the per-organization ceiling with 429 + Retry-After; reads are not counted', async () => {
    const { admin } = await import('../../lib/db')
    const { resolveActor, errorResponse, RateLimitError } = await import('../../lib/store/request')
    const { env } = await import('../../lib/env')
    const clear = () => admin(db => db.query("delete from rate_limits where bucket = 'merchant_write' and key = $1", [`org:${ORG_NW}`]))
    process.env.RATE_LIMIT_MERCHANT_WRITE = '3/600'
    const allowDev = process.env.ALLOW_DEV_LOGIN
    process.env.ALLOW_DEV_LOGIN = 'true'
    cookieValue = encodeDevSession({ uid: SESSIONS.northwind.uid, email: SESSIONS.northwind.email, role: 'client', agencyId: ORG_NW })
    await clear()
    try {
      const req = () => new Request(`${env.appUrl}/api/store/x`, { method: 'POST', headers: { origin: new URL(env.appUrl).origin } })
      for (let i = 0; i < 5; i++) await resolveActor(req()) // reads: not counted
      for (let i = 0; i < 3; i++) expect((await resolveActor(req(), { mutating: true })).kind).toBe('profile')
      const e = await resolveActor(req(), { mutating: true }).catch(x => x)
      expect(e).toBeInstanceOf(RateLimitError)
      const res = errorResponse(e)
      expect(res.status).toBe(429)
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect(await res.json()).toMatchObject({ ok: false, error: 'rate_limited' })
    } finally {
      delete process.env.RATE_LIMIT_MERCHANT_WRITE; cookieValue = undefined; await clear()
      if (allowDev === undefined) delete process.env.ALLOW_DEV_LOGIN; else process.env.ALLOW_DEV_LOGIN = allowDev
    }
  })

  it('webhooks: valid deliveries are never counted; signature rejections are, and past the ceiling become 429', async () => {
    process.env.RATE_LIMIT_WEBHOOK_INVALID = '2/600'
    try {
      const ip = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
      const req = () => new Request('http://localhost/api/shopify/webhooks', { method: 'POST', headers: { 'x-forwarded-for': ip } })
      for (let i = 0; i < 10; i++) expect((await rl.limitRejectedWebhook(req(), new Response('ok', { status: 200 }))).status).toBe(200)
      expect((await rl.limitRejectedWebhook(req(), new Response(null, { status: 401 }))).status).toBe(401)
      expect((await rl.limitRejectedWebhook(req(), new Response(null, { status: 400 }), true)).status).toBe(400)
      const r = await rl.limitRejectedWebhook(req(), new Response(null, { status: 401 }))
      expect(r.status).toBe(429)
      expect(r.headers.get('retry-after')).toBeTruthy()
      // a valid delivery from the same IP still goes through
      expect((await rl.limitRejectedWebhook(req(), new Response('ok', { status: 200 }))).status).toBe(200)
    } finally { delete process.env.RATE_LIMIT_WEBHOOK_INVALID }
  })
})

describe('rate limiter without a database', () => {
  afterEach(() => { vi.doUnmock('../../lib/db'); vi.resetModules() })
  it('fails open (allows, marks degraded) when the database is unreachable', async () => {
    vi.resetModules()
    vi.doMock('../../lib/db', () => ({ getPool: () => ({ query: async () => { throw new Error('connect ECONNREFUSED') } }) }))
    const m = await import('../../lib/security/rate-limit')
    const r = await m.hit('lead', 'ip:203.0.113.9')
    expect(r).toMatchObject({ allowed: true, degraded: true })
  })
})
