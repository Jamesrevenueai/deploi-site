/**
 * Embedded-app gating: Shopify review must see only working features. Proves that
 *  - every page under app/shopify is declared in lib/shopify/embedded.ts and gates itself on its feature,
 *  - the App Bridge menu lists only ready features,
 *  - a hidden page is a 404 when rendered, and a hidden feature is a 404 from the store API for a Shopify
 *    session token, while the same calls from the Deploi web app are unaffected,
 *  - marking a library agent working + shopifyReady in the pack registry shows exactly that agent.
 */
import '../merchant/env'
import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { prepareDb } from '../db/helpers'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { EMBEDDED_FEATURES, EMBEDDED_TEMPLATES, embeddedFeatureFor, embeddedNav, embeddedPathAllowed, isEmbeddedFeatureReady, shopifyLibraryAgentKeys } from '../../lib/shopify/embedded'
import { assertEmbeddedFeature, assertEmbeddedLibraryAgent, assertEmbeddedTemplate, templatesFor } from '../../lib/store/embedded-gate'
import { PACK_AGENTS, registerPackAgents, type PackAgent } from '../../lib/packs/registry'
import { TEMPLATES } from '../../lib/agents/templates'
import { NW, merchantActor, resetMerchant } from '../merchant/helpers'
import { GET as libraryGet } from '../../app/api/store/library/route'
import { GET as libraryAgentGet } from '../../app/api/store/library/[key]/route'
import { POST as libraryAgentPost } from '../../app/api/store/library/[key]/[action]/route'
import { GET as libraryActionsGet } from '../../app/api/store/library/actions/route'
import { POST as customPost } from '../../app/api/store/library/custom/route'
import { GET as planGet, POST as planPost } from '../../app/api/store/plan/route'
import { GET as agentsGet, POST as agentsPost } from '../../app/api/store/agents/route'
import { GET as poGet } from '../../app/api/store/purchase-orders/route'
import { POST as competitorCheck } from '../../app/api/store/competitors/check/route'
import { GET as privacyGet } from '../../app/api/store/privacy/route'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'app/shopify')

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = path.join(dir, n); return statSync(p).isDirectory() ? pageFiles(p) : n === 'page.tsx' ? [p] : [] })
}
const routeOf = (file: string) => ('/' + path.relative(path.join(ROOT, 'app'), path.dirname(file))).replace(/\\/g, '/')
const concrete = (route: string) => route.replace(/\[[^\]]+\]/g, 'x1')

/** isolate registry changes made by a test */
const before = [...PACK_AGENTS]
afterEach(() => { PACK_AGENTS.splice(0, PACK_AGENTS.length, ...before); delete process.env.LEGAL_GATE; delete process.env.BILLING_REQUIRED })

const libAgent = (key: string, over: Partial<PackAgent> = {}): PackAgent => ({ key, name: key, pack: 'commerce', job: 'test', triggers: [], actions: [], status: 'working', shopifyReady: true, ...over })

async function isNotFound(fn: () => unknown): Promise<boolean> {
  try { await fn(); return false } catch (e) { return String((e as { digest?: string }).digest ?? '').includes('404') }
}

describe('embedded app: declared features and the menu', () => {
  it('every page under app/shopify is declared and calls requireEmbeddedFeature with its own feature', () => {
    const files = pageFiles(APP)
    expect(files.length).toBeGreaterThanOrEqual(15)
    for (const f of files) {
      const route = routeOf(f)
      const feature = EMBEDDED_FEATURES.find(x => x.path === route)
      expect(feature, `${route} is not declared in lib/shopify/embedded.ts`).toBeTruthy()
      expect(readFileSync(f, 'utf8')).toContain(`requireEmbeddedFeature('${feature!.key}'`)
    }
    // and nothing is declared that has no page
    for (const x of EMBEDDED_FEATURES) expect(files.map(routeOf)).toContain(x.path)
  })

  it('the /shopify layout 404s a hidden path before rendering, from a path the middleware sets (never the client)', () => {
    expect(readFileSync(path.join(APP, 'layout.tsx'), 'utf8')).toMatch(/get\('x-deploi-path'\)[\s\S]*embeddedPathAllowed\(path\)\) notFound\(\)/)
    expect(readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8')).toContain("'x-deploi-path': req.nextUrl.pathname")
  })

  it('with nothing marked ready in the registry, Team, Plan and Agreements are hidden; the engine features and Privacy are shown', () => {
    expect(shopifyLibraryAgentKeys()).toEqual([])
    const nav = embeddedNav().map(n => n.href)
    expect(nav).toEqual(['/shopify/agents', '/shopify/inbox', '/shopify/issues', '/shopify/activity', '/shopify/rules', '/shopify/connections', '/shopify/privacy'])
    for (const p of ['/shopify/team', '/shopify/team/order_tracker', '/shopify/plan', '/shopify/legal', '/shopify/office', '/shopify/purchase-orders']) expect(embeddedPathAllowed(p), p).toBe(false)
    for (const p of ['/shopify', '/shopify/agents/abc', '/shopify/issues/1', '/shopify/privacy', '/shopify/weekly']) expect(embeddedPathAllowed(p), p).toBe(true)
  })

  it('no menu entry points at a feature that is not ready, whatever the registry says', () => {
    registerPackAgents([libAgent('inventory_watcher'), libAgent('order_tracker', { status: 'synthetic_only' }), libAgent('returns', { shopifyReady: false }), libAgent('campaign', { pack: 'leasing' })])
    for (const n of embeddedNav()) expect(embeddedPathAllowed(n.href), n.href).toBe(true)
    expect(embeddedNav().map(n => n.href)).not.toContain('/shopify/plan')
  })

  it('a library agent marked working + shopifyReady shows the Team page and only that agent', () => {
    registerPackAgents([libAgent('inventory_watcher'), libAgent('order_tracker', { status: 'synthetic_only' }), libAgent('returns', { shopifyReady: false }), libAgent('not_in_library')])
    expect(shopifyLibraryAgentKeys()).toEqual(['inventory_watcher'])
    expect(embeddedNav().map(n => n.href)).toContain('/shopify/team')
    expect(embeddedPathAllowed('/shopify/team/inventory_watcher')).toBe(true)
    for (const k of ['order_tracker', 'returns', 'not_in_library', 'custom-123']) expect(embeddedPathAllowed(`/shopify/team/${k}`), k).toBe(false)
  })

  it('Plan appears only while Shopify App Pricing is on, and the library tier API stays hidden', () => {
    expect(isEmbeddedFeatureReady('plan')).toBe(false)
    process.env.BILLING_REQUIRED = 'true'
    expect(embeddedNav().map(n => n.href)).toContain('/shopify/plan')
    // the embedded Plan page only links to Shopify's hosted plan page; it never offers another checkout
    const src = readFileSync(path.join(ROOT, 'components/store/ShopifyPlan.tsx'), 'utf8')
    expect(src).not.toMatch(/stripe|\/api\/billing|\/api\/store\/plan/i)
    expect(src).toContain("window.open(b.plansUrl!, '_top')")
  })

  it('Agreements appear only while the legal gate asks for acceptance', () => {
    expect(isEmbeddedFeatureReady('legal')).toBe(false)
    process.env.LEGAL_GATE = 'draft'
    expect(embeddedNav().map(n => n.href)).toContain('/shopify/legal')
  })

  it('maps concrete paths to their feature and refuses unknown ones', () => {
    expect(embeddedFeatureFor('/shopify/agents/123')?.key).toBe('agents')
    expect(embeddedFeatureFor('/shopify/agents/new')?.path).toBe('/shopify/agents/new')
    expect(embeddedFeatureFor('/shopify/unknown')).toBeNull()
    expect(embeddedFeatureFor('/shopify/agents/1/extra')).toBeNull()
  })
})

describe('embedded app: rendering every page', () => {
  it('a hidden page is a 404; a ready page renders', async () => {
    for (const f of pageFiles(APP)) {
      const route = routeOf(f)
      const mod = await import(f) as { default: (p: unknown) => unknown }
      const props = { params: Promise.resolve({ id: 'x1', key: 'order_tracker' }), searchParams: Promise.resolve({}) }
      const allowed = embeddedPathAllowed(route.includes('/team/') ? '/shopify/team/order_tracker' : concrete(route))
      expect(await isNotFound(() => mod.default(props)), route).toBe(!allowed)
    }
  })

  it('a hidden library agent page is a 404 even when the Team page is shown', async () => {
    registerPackAgents([libAgent('inventory_watcher')])
    const mod = await import(path.join(APP, 'team/[key]/page.tsx')) as { default: (p: unknown) => Promise<unknown> }
    expect(await isNotFound(() => mod.default({ params: Promise.resolve({ key: 'order_tracker' }) }))).toBe(true)
    expect(await isNotFound(() => mod.default({ params: Promise.resolve({ key: 'inventory_watcher' }) }))).toBe(false)
  })
})

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const KEY = process.env.SHOPIFY_API_KEY!
const shopify = (method = 'GET', body?: unknown) => new Request('http://localhost/api/store/x', {
  method, headers: { authorization: `Bearer ${signSessionToken({ dest: `https://${NW.domain}`, sub: '7' }, SECRET, KEY)}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})
const ctx = <T,>(p: T) => ({ params: Promise.resolve(p) })

describe.skipIf(!ready)('embedded app: the store API refuses hidden features to a Shopify session token', () => {
  it('Team, build-your-own, Plan, purchase orders and competitor checks answer 404 inside Shopify', async () => {
    await resetMerchant(NW)
    const calls: [string, Promise<Response>][] = [
      ['library', libraryGet(shopify())],
      ['library agent', libraryAgentGet(shopify(), ctx({ key: 'order_tracker' }))],
      ['library switch', libraryAgentPost(shopify('POST', { enabled: true }), ctx({ key: 'order_tracker', action: 'switch' }))],
      ['library actions', libraryActionsGet(shopify())],
      ['custom agent', customPost(shopify('POST', { name: 'x', job: 'y' }))],
      ['plan', planGet(shopify())],
      ['plan change', planPost(shopify('POST', { tier: 'pro' }))],
      ['plan (billing on)', (process.env.BILLING_REQUIRED = 'true', planGet(shopify()))],
      ['purchase orders', poGet(shopify())],
      ['competitor check', competitorCheck(shopify('POST', { stores: ['https://shop.example'] }))],
      ['hidden template', agentsPost(shopify('POST', { template: 'competitor_watcher', connectionId: NW.conn }))],
    ]
    for (const [what, res] of calls) expect((await res).status, what).toBe(404)
  })

  it('the agents list offers only the Shopify templates; privacy requests are reachable', async () => {
    await resetMerchant(NW)
    const r = await agentsGet(shopify())
    expect(r.status).toBe(200)
    const json = await r.json() as { templates: { key: string }[] }
    expect(json.templates.map(t => t.key)).toEqual([...EMBEDDED_TEMPLATES])
    expect((await privacyGet(shopify())).status).toBe(200)
  })

  it('a ready library agent is served inside Shopify, and the team lists only ready agents', async () => {
    await resetMerchant(NW)
    registerPackAgents([libAgent('inventory_watcher')])
    const team = await libraryGet(shopify())
    expect(team.status).toBe(200)
    const json = await team.json() as { agents: { key: string }[]; buildYourOwn: { allowed: boolean } }
    expect(json.agents.map(a => a.key)).toEqual(['inventory_watcher'])
    expect(json.buildYourOwn.allowed).toBe(false)
    expect((await libraryAgentGet(shopify(), ctx({ key: 'inventory_watcher' }))).status).toBe(200)
    expect((await libraryAgentGet(shopify(), ctx({ key: 'order_tracker' }))).status).toBe(404)
  })

  it('the Deploi web app (a signed-in merchant) is not gated', async () => {
    const actor = await merchantActor(NW)
    expect(() => assertEmbeddedFeature(actor, 'plan')).not.toThrow()
    expect(() => assertEmbeddedLibraryAgent(actor, 'order_tracker')).not.toThrow()
    expect(() => assertEmbeddedTemplate(actor, 'competitor_watcher')).not.toThrow()
    expect(templatesFor(actor, TEMPLATES)).toHaveLength(TEMPLATES.length)
  })
})
