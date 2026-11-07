/**
 * The new /api/app endpoints (2026-11-07): give an agent a task, close it, the team room and what the team learned,
 * over the HTTP handlers with an embedded Shopify session token: the organization comes from the session, never the
 * request; no session is a 401; bad input is a 400; another business's task is a 404.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { NW, HB, resetMerchant } from '../merchant/helpers'
import { POST as taskPost } from '../../app/api/app/agents/[id]/tasks/route'
import { POST as finishPost } from '../../app/api/app/tasks/[ref]/route'
import { GET as roomGet } from '../../app/api/app/room/route'
import { GET as learnedGet } from '../../app/api/app/learned/route'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const KEY = process.env.SHOPIFY_API_KEY!
const req = (url: string, method = 'GET', body?: unknown, opts: { auth?: boolean; domain?: string } = {}) => new Request(`http://localhost${url}`, {
  method, headers: { ...(opts.auth === false ? {} : { authorization: `Bearer ${signSessionToken({ dest: `https://${opts.domain ?? NW.domain}`, sub: '7' }, SECRET, KEY)}` }), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})
const ctx = <T,>(p: T) => ({ params: Promise.resolve(p) })
const AGENT = 'store:inventory_watcher'
const clean = () => admin(db => db.query(`delete from cases where org_id = any($1) and kind = 'owner_task'`, [[NW.org, HB.org]]))

describe.skipIf(!ready)('/api/app tasks, room and learned', () => {
  beforeAll(async () => { await resetMerchant(NW); await clean() })
  afterAll(clean)

  it('POST /agents/:id/tasks gives the task; POST /tasks/:ref closes it; the room shows both', async () => {
    let r = await taskPost(req(`/api/app/agents/${encodeURIComponent(AGENT)}/tasks`, 'POST', { text: 'Check the blue mug stock', orgId: HB.org }), ctx({ id: encodeURIComponent(AGENT) }))
    expect(r.status).toBe(200)
    const { task } = await r.json() as { task: { ref: string; agentName: string; status: string } }
    expect(task).toMatchObject({ agentName: 'Inventory Watcher' })
    const c = await admin(db => db.one<{ org_id: string; suite: string }>('select org_id, suite from cases where ref = $1', [task.ref]))
    expect(c).toEqual({ org_id: NW.org, suite: 'commerce' })
    r = await roomGet(req('/api/app/room?workspace=store'))
    const room = await r.json() as { ok: boolean; workspace: string; messages: { kind: string; caseRef: string | null }[] }
    expect(room).toMatchObject({ ok: true, workspace: 'store' })
    expect(room.messages.filter(m => m.caseRef === task.ref).map(m => m.kind)).toContain('task')
    r = await finishPost(req(`/api/app/tasks/${task.ref}`, 'POST', { op: 'done' }), ctx({ ref: task.ref }))
    expect(await r.json()).toEqual({ ok: true, task: { ref: task.ref, status: 'resolved' } })
    r = await finishPost(req(`/api/app/tasks/${task.ref}`, 'POST', { op: 'done' }), ctx({ ref: task.ref }))
    expect(r.status).toBe(409)
  })

  it('refuses: no session, empty text and a bad workspace (400), another business’s task (404)', async () => {
    // outside a Next request there are no cookies: never a 2xx, and no task is created
    const before = (await admin(db => db.one<{ n: number }>(`select count(*)::int as n from cases where kind = 'owner_task'`)))!.n
    for (const r of [await taskPost(req(`/api/app/agents/x/tasks`, 'POST', { text: 'hi' }, { auth: false }), ctx({ id: AGENT })).catch(() => null), await roomGet(req('/api/app/room', 'GET', undefined, { auth: false })).catch(() => null)])
      expect(r === null || r.status >= 400).toBe(true)
    expect((await admin(db => db.one<{ n: number }>(`select count(*)::int as n from cases where kind = 'owner_task'`)))!.n).toBe(before)
    expect((await taskPost(req(`/api/app/agents/x/tasks`, 'POST', { text: '  ' }), ctx({ id: encodeURIComponent(AGENT) }))).status).toBe(400)
    expect((await roomGet(req('/api/app/room?workspace=garage'))).status).toBe(400)
    const r = await taskPost(req(`/api/app/agents/x/tasks`, 'POST', { text: 'Northwind only' }), ctx({ id: encodeURIComponent(AGENT) }))
    const { task } = await r.json() as { task: { ref: string } }
    expect((await finishPost(req(`/api/app/tasks/${task.ref}`, 'POST', { op: 'cancel' }, { domain: HB.domain }), ctx({ ref: task.ref }))).status).toBe(404)
    expect((await admin(db => db.one<{ status: string }>('select status from cases where ref = $1', [task.ref])))!.status).not.toBe('cancelled')
  })

  it('GET /learned answers for the session organization', async () => {
    const r = await learnedGet(req('/api/app/learned'))
    expect(r.status).toBe(200)
    const j = await r.json() as { ok: boolean; learned: unknown }
    expect(j.ok).toBe(true)
    expect(j.learned === null || typeof j.learned === 'object').toBe(true)
  })
})
