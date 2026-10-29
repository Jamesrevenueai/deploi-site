/**
 * Competitor & Trend Watcher, against synthetic stores on the reserved ".example" domain (no network):
 *  - store addresses are validated and normalized; private hosts, IPs and credentials are refused;
 *  - robots.txt is obeyed (RFC 9309 matching) and a store that disallows us is never read past robots.txt;
 *  - the outbound guard and redirects never reach a private address;
 *  - the first check is a baseline (nothing reported as new); the second reports real changes with
 *    URLs, times and before/after values; similar products across stores become inferences, and a
 *    possible opportunity only when the merchant's own catalog has nothing similar;
 *  - no finding states sales, revenue, units or conversion;
 *  - permissions: grant needed, widening (a new store) needs a new grant, paused agents do nothing,
 *    other organizations cannot read the findings.
 */
import './env'
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { createAgent, editAgent, grantPolicy, pauseAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { parsePolicy, expansionReasons, summarizePolicy } from '../../lib/agents/policy'
import { templatePolicy, TEMPLATES } from '../../lib/agents/templates'
import { normalizeStoreUrl } from '../../lib/competitors/url'
import { parseRobots, robotsAllows, robotsFromResponse } from '../../lib/competitors/robots'
import { PoliteFetcher } from '../../lib/competitors/fetch'
import { collectStore } from '../../lib/competitors/collect'
import { compareStore, similarNames, nameTokens } from '../../lib/competitors/compare'
import { syntheticTransport } from '../../lib/competitors/synthetic'
import { competitorView, setFindingsStatus } from '../../lib/competitors/queries'
import { agentWorkLog } from '../../lib/agents/worklog'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { assertApprovedHost } from '../../lib/net/outbound'
import { NW, HB, merchantActor, resetMerchant } from './helpers'

const ready = await prepareDb()
const STORES = ['https://linen-and-loom.example', 'harbor-home.example/collections/all', 'https://www.oak-and-ember.example'.replace('www.', ''), 'https://plain-boutique.example', 'https://private-label.example']
const SALES_CLAIM = /\b(\d[\d,.]*\s*(units?|orders?|sales)\b|revenue of|conversion rate of|sold \d)/i

beforeAll(() => { process.env.COMPETITOR_MIN_INTERVAL_MS = '0' })
beforeEach(async () => {
  process.env.AGENT_MAIL_DOMAIN = 'agents.deploi.test'
  setEmailFetch(async (url) => { throw new Error(`unexpected HTTP call in test: ${url}`) })
  if (ready) { await resetMerchant(NW); await resetMerchant(HB) }
})
afterEach(() => { setEmailFetch(null); delete process.env.AGENT_MAIL_DOMAIN })

describe('store addresses', () => {
  it('normalizes what merchants paste, and refuses what cannot be monitored', () => {
    expect(normalizeStoreUrl('harbor-home.example/collections/all')).toEqual({ ok: true, url: 'https://harbor-home.example', host: 'harbor-home.example' })
    expect(normalizeStoreUrl('http://Shop.Example.com/products/x?y=1')).toMatchObject({ ok: true, url: 'https://shop.example.com' })
    for (const bad of ['', 'ftp://shop.com', 'https://127.0.0.1', 'https://10.0.0.5/shop', 'https://localhost:3000', 'https://user:pw@shop.com', 'https://shop.com:8443', 'https://intranet', 'https://-bad-.com', 'https://[::1]'])
      expect(normalizeStoreUrl(bad).ok, bad).toBe(false)
  })
  it('the policy refuses duplicates and more than ten stores, and needs at least one', () => {
    const base = { connectionId: NW.conn, productScope: { mode: 'all' } }
    expect(() => parsePolicy({ ...base, competitors: { stores: [] } })).toThrow(/at least one competitor store/)
    expect(() => parsePolicy({ ...base, competitors: { stores: [{ url: 'shop.com' }, { url: 'https://www.shop.com' }] } })).toThrow(/listed twice/)
    expect(() => parsePolicy({ ...base, competitors: { stores: Array.from({ length: 11 }, (_, i) => ({ url: `s${i}.com` })) } })).toThrow()
    expect(() => parsePolicy({ ...base, competitors: { stores: [{ url: 'https://192.168.1.4' }] } })).toThrow(/IP address/)
    const p = parsePolicy({ ...base, competitors: { stores: [{ url: 'Shop.com/products/a' }], keywords: ['Linen', 'linen'] } })
    expect(p.competitors).toMatchObject({ stores: [{ url: 'https://shop.com' }], keywords: ['linen'], minPriceChangePct: 5, compareOwnCatalog: true })
  })
})

describe('robots.txt and the outbound guard', () => {
  it('matches like RFC 9309: our group first, longest rule wins, Allow wins a tie, * and $ work', () => {
    const r = parseRobots('User-agent: *\nDisallow: /collections/*sort_by*\nDisallow: /private\n\nUser-agent: DeploiBot\nDisallow: /products.json$\nAllow: /products.json?\n')
    expect(robotsAllows(r, '/products.json?limit=250&page=1')).toBe(true)
    expect(robotsAllows(r, '/products.json')).toBe(false)
    expect(robotsAllows(r, '/private/x')).toBe(true) // our own group replaces "*"
    const star = parseRobots('User-agent: *\nDisallow: /collections/*sort_by*\nDisallow: /a\nAllow: /a\n')
    expect(robotsAllows(star, '/collections/all?sort_by=best-selling')).toBe(false)
    expect(robotsAllows(star, '/collections/best-sellers/products.json?limit=250')).toBe(true)
    expect(robotsAllows(star, '/a')).toBe(true)
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), '/products.json')).toBe(false)
  })
  it('fails closed when robots.txt cannot be read because of a server error; a missing file allows', () => {
    expect(robotsAllows(robotsFromResponse(503, ''), '/products.json')).toBe(false)
    expect(robotsAllows(robotsFromResponse(404, ''), '/products.json')).toBe(true)
  })
  it('only public https hosts: no private addresses, IPs or our own providers, and redirects are re-checked', async () => {
    expect(() => assertApprovedHost('https://shop.example.com/products.json', 'competitor_public')).not.toThrow()
    for (const u of ['http://shop.example.com', 'https://127.0.0.1/', 'https://10.1.2.3', 'https://api.resend.com/emails', 'https://x.supabase.co', 'https://intranet.local'])
      expect(() => assertApprovedHost(u, 'competitor_public'), u).toThrow()
    const hops: string[] = []
    const f = new PoliteFetcher(async (url) => { hops.push(url); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/admin' } }) })
    const r = await f.get('https://shop.example.com/products.json')
    expect(r.status).toBe(0)
    expect(hops).toEqual(['https://shop.example.com/products.json'])
  })
})

describe('collecting and comparing (no database)', () => {
  it('reads the public feed and the store\'s own best-seller and featured collections', async () => {
    const r = await collectStore('https://linen-and-loom.example', { fetcher: new PoliteFetcher(syntheticTransport(0)) })
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.snapshot.products.map(p => p.key)).toContain('linen-throw-blanket')
    expect(r.snapshot.bestsellers).toMatchObject({ title: 'Best Sellers', keys: ['stonewashed-linen-duvet-cover', 'linen-throw-blanket', 'linen-napkins-set-of-4'] })
    expect(r.snapshot.featured.map(f => f.title)).toEqual(['New Arrivals'])
    expect(r.snapshot.complete).toBe(true)
  })
  it('a store without a public feed is unsupported; a store that disallows us is read no further than robots.txt', async () => {
    const plain = await collectStore('https://plain-boutique.example', { fetcher: new PoliteFetcher(syntheticTransport(0)) })
    expect(plain).toMatchObject({ status: 'unsupported', platform: 'unsupported' })
    const blocked = await collectStore('https://private-label.example', { fetcher: new PoliteFetcher(syntheticTransport(0)) })
    expect(blocked).toMatchObject({ status: 'blocked_robots', requests: 1, urls: ['https://private-label.example/robots.txt'] })
  })
  it('the first check is a baseline: nothing is called new', async () => {
    const r = await collectStore('https://harbor-home.example', { fetcher: new PoliteFetcher(syntheticTransport(0)) })
    if (r.status !== 'ok') throw new Error('not ok')
    const c = compareStore({ sourceId: 's', host: 'harbor-home.example', prev: new Map(), prevObservedAt: null, snapshot: r.snapshot, prefs: { alerts: ['launches', 'bestsellers', 'trends'], minPriceChangePct: 5, keywords: [] } })
    expect(c.findings.map(f => f.kind)).toEqual(['baseline'])
    expect(c.findings[0].summary).toMatch(/These are not new launches/)
    expect(c.newKeys.size).toBe(0)
  })
  it('product names: similar kinds of product match across stores, different ones do not', () => {
    expect(similarNames('Ceramic Olive Oil Pourer', 'Stoneware Oil Pourer')).toBe(true)
    expect(similarNames('Ceramic Olive Oil Pourer', 'Ceramic Oil Pourer, Glazed')).toBe(true)
    expect(similarNames('Ceramic Pour-Over Set', 'Ceramic Olive Oil Pourer')).toBe(false)
    expect(nameTokens('Linen Napkins, Set of 4')).toEqual(['linen', 'napkin'])
  })
})

async function chaser(opts: { keywords?: string[]; stores?: string[]; email?: boolean } = {}) {
  const actor = await merchantActor(NW)
  const t = TEMPLATES.find(x => x.key === 'competitor_watcher')!
  const policy = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', notify: opts.email ? NW.email : null,
    competitor: { stores: opts.stores ?? STORES, keywords: opts.keywords ?? [], cadence: 'daily', emailSummary: opts.email } })
  const c = await createAgent(actor, { name: 'Trend Watcher', taskText: t.job, policy, mailbox: Boolean(opts.email), templateKey: t.key })
  return { actor, c }
}

describe.skipIf(!ready)('Competitor & Trend Watcher end to end (synthetic stores)', () => {
  it('nothing is read until the authorization is granted; the rules say read only and never estimate sales', async () => {
    const { actor, c } = await chaser()
    await expect(runAgent(c.agentId, { trigger: 'test', actor: actor.label })).rejects.toMatchObject({ code: 'agent_inactive' })
    expect((await admin(db => db.one<{ n: number }>('select count(*)::int as n from competitor_checks where agent_id = $1', [c.agentId])))!.n).toBe(0)
    const words = [...c.summary.grants, ...c.summary.limits, ...c.summary.never].join(' ')
    expect(words).toMatch(/Competitor monitoring \(read only\)/)
    expect(words).toMatch(/robots\.txt/)
    expect(words).toMatch(/Never claims to know a competitor's sales, revenue, units sold, conversion rate or exact sales ranking/)
    expect(words).toMatch(/never changes your store/)
    expect(words).toMatch(/Never sends email/)
  })

  it('first run records a baseline per store; the second reports changes with evidence; trends and an opportunity are inferences', async () => {
    const { actor, c } = await chaser()
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    const r1 = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r1.status).toBe('completed')
    expect(r1.counts.competitors).toMatchObject({ storesChecked: 3, storesSkipped: 2, baselines: 3 })
    const v1 = await competitorView(actor, c.agentId)
    expect(v1.findings.filter(f => f.basis === 'observed').map(f => f.kind).sort()).toEqual(['baseline', 'baseline', 'baseline'])
    expect(v1.sources.find(s => s.host === 'plain-boutique.example')).toMatchObject({ status: 'unsupported', platform: 'unsupported' })
    expect(v1.sources.find(s => s.host === 'private-label.example')).toMatchObject({ status: 'blocked_robots' })
    const blockedCheck = v1.checks.find(ch => ch.host === 'private-label.example')!
    expect(blockedCheck.urls).toEqual(['https://private-label.example/robots.txt'])
    // the merchant sells a linen throw already: the linen-throw cluster is a trend, not an opportunity
    expect(v1.findings.some(f => f.kind === 'opportunity')).toBe(false)

    const r2 = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r2.counts.competitors).toMatchObject({ storesChecked: 3, baselines: 0 })
    const v2 = await competitorView(actor, c.agentId)
    const kinds = (k: string) => v2.findings.filter(f => f.kind === k)
    expect(kinds('new_product').map(f => f.title).sort()).toEqual(['New on harbor-home.example: Stoneware Oil Pourer', 'New on linen-and-loom.example: Ceramic Olive Oil Pourer', 'New on oak-and-ember.example: Ceramic Oil Pourer, Glazed'])
    expect(kinds('price_drop')).toHaveLength(1) // the beeswax wraps' reduction is reported once, as a discount
    const drop = kinds('price_drop')[0]
    expect(drop.title).toBe('Price down 16.9% on linen-and-loom.example: Linen Throw Blanket')
    expect(drop.evidence[0]).toMatchObject({ url: 'https://linen-and-loom.example/products/linen-throw-blanket', before: 89, after: 74 })
    expect(drop.evidence[0].beforeObservedAt).toBeTruthy()
    expect(kinds('price_rise')[0].title).toMatch(/Price up 12.5% on oak-and-ember.example: Hand-poured Soy Candle/)
    expect(kinds('discount_started')[0].summary).toMatch(/reduced from 16.00 to 12.80 \(20% off as advertised\)/)
    expect(kinds('sold_out')[0].title).toBe('Sold out on linen-and-loom.example: Waffle Bath Towel')
    expect(kinds('back_in_stock')[0].title).toBe('Back in stock on harbor-home.example: Glass Storage Jar Set')
    expect(kinds('bestseller_left')[0].title).toMatch(/Linen Napkins/)
    expect(kinds('bestseller_moved')[0].summary).toMatch(/Position 1 .* position 3 .*not a measured sales rank/)
    expect(kinds('featured').map(f => f.title)).toEqual(expect.arrayContaining(['Newly featured on harbor-home.example: Beeswax Food Wraps']))
    const trend = v2.findings.find(f => f.kind === 'cross_store' && /pourer/.test(f.title))!
    expect(trend).toMatchObject({ basis: 'inference' })
    expect(trend.title).toMatch(/Similar products on 3 stores/)
    expect(trend.evidence.map(e => e.store).sort()).toEqual(['harbor-home.example', 'linen-and-loom.example', 'oak-and-ember.example'])
    const opp = kinds('opportunity')[0]
    expect(opp).toMatchObject({ basis: 'inference' })
    expect(opp.summary).toMatch(/not a forecast: public listings do not show sales, revenue or demand/)
    expect(r2.counts.competitors!.opportunities).toBe(1)
    for (const f of v2.findings) {
      expect(f.summary, f.title).not.toMatch(SALES_CLAIM)
      for (const e of f.evidence) { expect(e.url).toMatch(/^https:\/\/[a-z-]+\.example\//); expect(Date.parse(e.observedAt)).toBeGreaterThan(0) }
    }
    // a third run with nothing new adds no duplicate findings
    const before = v2.findings.length
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect((await competitorView(actor, c.agentId)).findings.length).toBe(before)
  })

  it('keywords narrow what is recorded; alert choices decide which findings appear', async () => {
    const actor = await merchantActor(NW)
    const policy = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', competitor: { stores: ['linen-and-loom.example', 'harbor-home.example'], keywords: ['oil'], alerts: ['launches'] } })
    const c = await createAgent(actor, { name: 'Oil Watch', taskText: '', policy })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    const v = await competitorView(actor, c.agentId)
    expect(v.sources.map(s => s.products)).toEqual([1, 1])
    expect(v.findings.filter(f => f.kind !== 'baseline').every(f => f.kind === 'new_product')).toBe(true)
    expect(v.findings.filter(f => f.kind === 'new_product')).toHaveLength(2)
  })

  it('the optional email summary is a draft with observed changes and inferences kept apart', async () => {
    const { actor, c } = await chaser({ email: true })
    expect(c.mailbox?.address).toMatch(/@agents\.deploi\.test$/)
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    const r2 = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r2.counts.email).toMatchObject({ emailDrafted: 1, emailAccepted: 0 })
    const m = await admin(db => db.one<{ status: string; meta: Record<string, unknown> }>(`select status, meta from email_messages where agent_id = $1 and task_key = 'run_report' order by created_at desc limit 1`, [c.agentId]))
    expect(m!.status).toBe('draft')
  })

  it('widening needs a new grant; pausing stops reading; another organization sees nothing', async () => {
    const { actor, c } = await chaser({ stores: ['linen-and-loom.example'] })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    const raw = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', competitor: { stores: ['linen-and-loom.example', 'harbor-home.example'] } })
    const e = await editAgent(actor, c.agentId, { policy: raw })
    expect(e.requiresGrant).toBe(true)
    expect(e.expansion).toContain('new competitor stores to watch')
    const narrower = expansionReasons(parsePolicy({ ...raw }), parsePolicy({ ...raw, competitors: { ...(raw.competitors as object), stores: [{ url: 'linen-and-loom.example' }] } }))
    expect(narrower).toEqual([])
    // until the new version is granted, only the granted store is read
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect((await competitorView(actor, c.agentId)).sources.map(s => s.host)).toEqual(['linen-and-loom.example'])
    await pauseAgent(actor, c.agentId)
    await expect(runAgent(c.agentId, { trigger: 'test', actor: actor.label })).rejects.toMatchObject({ code: 'agent_inactive' })
    await expect(competitorView(await merchantActor(HB), c.agentId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(setFindingsStatus(await merchantActor(HB), c.agentId, 'seen', null)).rejects.toMatchObject({ code: 'not_found' })
    expect(await setFindingsStatus(actor, c.agentId, 'seen', null)).toBe(0) // the baseline is never "new"
  })

  it('the work log shows each store checked or skipped, why, and which authorization allowed it', async () => {
    const { actor, c } = await chaser()
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    const log = await agentWorkLog(actor, c.agentId)
    const base = log.find(e => /Starting point recorded/.test(e.what))!
    expect(base.permission).toMatch(/authorization v1/)
    const skipped = log.find(e => /Store not checked/.test(e.what) && /robots/.test(e.why ?? ''))!
    expect(skipped.what).toMatch(/private-label\.example/)
  })

  it('the readable rules for the template list stores, alerts and the limits', () => {
    const p = parsePolicy(templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', competitor: { stores: ['harbor-home.example'], keywords: ['linen'] } }))
    const s = summarizePolicy(p, { storeName: 'Northwind', sourceNames: {} })
    expect(s.grants.join(' ')).toMatch(/harbor-home\.example/)
    expect(s.grants.join(' ')).toMatch(/"linen"/)
    expect(s.limits.join(' ')).toMatch(/one request per second/)
  })
})
