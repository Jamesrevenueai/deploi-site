/**
 * The discovery API through its route handlers, signed in with a session cookie like the web app:
 * from a connected store to the first working monitoring agent takes three owner calls (discover, set up
 * the team, grant all shown) and well under a minute; staff are refused; the organization comes from the
 * session only (a body naming another organization changes nothing).
 */
import './helpers'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'
import type { Session } from '../../lib/session'
import { NW, HB, resetDiscovery, agentsOf } from './helpers'

let cookieValue: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === DEV_COOKIE_NAME && cookieValue ? { value: cookieValue } : undefined), set: () => {}, delete: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))

const ready = await prepareDb()
// dev sign-in (a signed cookie naming a seeded profile) is only honoured with ALLOW_DEV_LOGIN outside production
const allowDev = process.env.ALLOW_DEV_LOGIN
process.env.ALLOW_DEV_LOGIN = 'true'
const discover = await import('../../app/api/store/discover/route')
const team = await import('../../app/api/store/discover/team/route')

const ORIGIN = 'http://localhost:3000'
const as = (s: Session) => { cookieValue = encodeDevSession(s) }
let calls = 0
async function call<T = Record<string, unknown>>(handler: (req: Request) => Promise<Response>, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: T }> {
  if (method === 'POST') calls++
  const req = new Request(`${ORIGIN}/api/store/discover`, { method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = await handler(req)
  return { status: res.status, json: await res.json() as T }
}

type Pending = { policyId: string; policyHash: string; draftsOnly: boolean; summary: { grants: string[] } }
type TeamItem = { template: string; status: string; agent: { agentId: string; status: string; pending: Pending | null } | null }

describe.skipIf(!ready)('discovery API', () => {
  beforeEach(async () => { calls = 0; await resetDiscovery(NW); await resetDiscovery(HB) })
  afterAll(async () => {
    cookieValue = undefined
    if (allowDev === undefined) delete process.env.ALLOW_DEV_LOGIN; else process.env.ALLOW_DEV_LOGIN = allowDev
    await resetDiscovery(NW); await resetDiscovery(HB)
  })

  it('from a connected store to a working monitoring agent in three owner calls, under a minute', async () => {
    as(SESSIONS.northwind)
    const t0 = Date.now()
    // before anything ran: an honest empty state, no demo data
    const empty = await call<{ run: unknown; findings: { total: number }; team: unknown[]; connected: boolean }>(discover.GET, 'GET')
    expect(empty.json).toMatchObject({ run: null, findings: { total: 0 }, team: [], connected: true })

    // 1. discover
    const d = await call<{ status: string; view: { findings: { total: number }; team: { template: string }[] } }>(discover.POST, 'POST', {})
    expect(d.status).toBe(200)
    expect(d.json.status).toBe('completed')
    expect(d.json.view.findings.total).toBe(10)
    expect(d.json.view.team[0].template).toBe('inventory_watcher')

    // 2. set up the recommended team (drafts only); every created agent comes with its summary and hash
    const s = await call<{ items: TeamItem[] }>(team.POST, 'POST', { op: 'create' })
    expect(s.status).toBe(200)
    const shown = s.json.items.filter(i => i.agent?.pending?.draftsOnly)
    expect(shown.map(i => i.template).sort()).toEqual(['inventory_watcher', 'store_health_checker'])
    for (const i of shown) expect(i.agent!.pending!.summary.grants.length).toBeGreaterThan(0)

    // 3. grant all shown, one request carrying every shown hash
    const g = await call<{ granted: number; refused: number }>(team.POST, 'POST', { op: 'grant', grants: shown.map(i => ({ agentId: i.agent!.agentId, policyId: i.agent!.pending!.policyId, policyHash: i.agent!.pending!.policyHash })) })
    expect(g.json).toMatchObject({ granted: 2, refused: 0 })

    expect(calls).toBeLessThanOrEqual(3)
    expect(Date.now() - t0).toBeLessThan(60_000)
    const v = await call<{ team: TeamItem[] }>(discover.GET, 'GET')
    const working = v.json.team.filter(t => t.agent?.status === 'active').map(t => t.template).sort()
    expect(working).toEqual(['inventory_watcher', 'store_health_checker'])
    const agents = await agentsOf(NW.org)
    expect(agents.filter(a => a.status === 'active').every(a => a.approval_mode === 'draft')).toBe(true)

    // pressing set up again creates nothing new
    const again = await call<{ items: TeamItem[] }>(team.POST, 'POST', {})
    expect(again.json.items.filter(i => i.status === 'created')).toEqual([])
    expect(await agentsOf(NW.org)).toHaveLength(2)
  })

  it('the organization comes from the session only', async () => {
    as(SESSIONS.harbor)
    await call(discover.POST, 'POST', { orgId: NW.org })
    as(SESSIONS.northwind)
    const nw = await call<{ run: unknown }>(discover.GET, 'GET')
    expect(nw.json.run).toBeNull()
    as(SESSIONS.harbor)
    const hb = await call<{ run: { status: string } | null }>(discover.GET, 'GET')
    expect(hb.json.run?.status).toBe('completed')
  })

  it('refuses staff and signed-out requests, and cross-site writes', async () => {
    as(SESSIONS.staff)
    expect((await call(discover.GET, 'GET')).status).toBe(403)
    expect((await call(discover.POST, 'POST', {})).status).toBe(403)
    expect((await call(team.POST, 'POST', { op: 'create' })).status).toBe(403)
    expect((await call(team.POST, 'POST', { op: 'grant', grants: [] })).status).toBe(403)
    cookieValue = undefined
    expect((await call(discover.GET, 'GET')).status).toBe(401)
    as(SESSIONS.northwind)
    const res = await discover.POST(new Request(`${ORIGIN}/api/store/discover`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }))
    expect(res.status).toBe(403)
  })

  it('setting up a team before any discovery is refused with a plain message', async () => {
    as(SESSIONS.northwind)
    const r = await call<{ error: string; message: string }>(team.POST, 'POST', {})
    expect(r.status).toBe(400)
    expect(r.json.message).toMatch(/run discovery first/)
  })
})

describe('discovery triggers', () => {
  it('every connection entry point queues discovery', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..', '..')
    const wired: [string, string][] = [
      ['app/api/shopify/auth/callback/route.ts', 'requestDiscovery(r.orgId, `shopify:${r.connectionId}`)'],
      ['app/api/shopify/session/route.ts', 'requestDiscovery(r.orgId, `shopify:${r.connectionId}`)'],
      ['app/api/woocommerce/callback/route.ts', 'requestDiscovery(f.orgId, `woocommerce:${f.connectionId}`)'],
      ['app/api/woocommerce/keys/route.ts', 'requestDiscovery(m.orgId, `woocommerce:${r.connectionId}`)'],
      ['app/api/office/oauth/hubspot/callback/route.ts', 'requestDiscovery(conn.org_id, `hubspot:${conn.id}`)'],
      ['app/api/office/oauth/google/callback/route.ts', 'requestDiscovery(conn.org_id, `google_calendar:${conn.id}`)'],
      ['app/api/office/connections/route.ts', 'requestDiscovery(acc.org_id, `mailbox:${acc.id}`)'],
      ['lib/jobs/handlers.ts', "import '../discovery/jobs'"],
    ]
    for (const [f, line] of wired) expect(readFileSync(join(root, f), 'utf8'), f).toContain(line)
  })
})
