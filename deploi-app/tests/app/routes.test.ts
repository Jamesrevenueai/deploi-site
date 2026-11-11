/**
 * The /api/app endpoints over HTTP handlers with an embedded Shopify session token (no cookies): they resolve the
 * organization from the session, answer with the contract's shapes, refuse a request without a session, map
 * engine errors to their status codes and never take an organization id from the request.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { NW, resetMerchant } from '../merchant/helpers'
import { GET as wsGet, POST as wsPost } from '../../app/api/app/workspace/route'
import { GET as ccGet } from '../../app/api/app/command-center/route'
import { GET as agentGet } from '../../app/api/app/agents/[id]/route'
import { POST as autonomyPost } from '../../app/api/app/agents/[id]/autonomy/route'
import { GET as instrGet, POST as instrPost } from '../../app/api/app/agents/[id]/instructions/route'
import { PATCH as instrPatch, DELETE as instrDelete } from '../../app/api/app/agents/[id]/instructions/[instructionId]/route'
import { GET as chatGet, POST as chatPost } from '../../app/api/app/agents/[id]/chat/route'
import { POST as teamChatPost } from '../../app/api/app/chat/route'
import { POST as needsPost } from '../../app/api/app/needs-you/[id]/route'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const KEY = process.env.SHOPIFY_API_KEY!
const req = (url: string, method = 'GET', body?: unknown, auth = true) => new Request(`http://localhost${url}`, {
  method, headers: { ...(auth ? { authorization: `Bearer ${signSessionToken({ dest: `https://${NW.domain}`, sub: '7' }, SECRET, KEY)}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})
const ctx = <T,>(p: T) => ({ params: Promise.resolve(p) })
const AGENT = encodeURIComponent('store:inventory_watcher')
const clean = () => admin(async db => {
  for (const t of ['agent_profiles', 'agent_instructions', 'app_workspace_prefs', 'agent_chat_messages']) await db.query(`delete from ${t} where org_id = $1`, [NW.org])
  await db.query(`delete from library_auto_run_grants where org_id = $1 and agent_key = 'inventory_watcher'`, [NW.org])
  await db.query(`delete from library_switches where org_id = $1 and agent_key = 'inventory_watcher' and engine_agent_id is null`, [NW.org])
})

describe.skipIf(!ready)('/api/app endpoints', () => {
  beforeAll(async () => { await resetMerchant(NW); await clean() })
  afterAll(clean)

  it('workspace and command center answer for the session organization; a bad workspace is a 400', async () => {
    let r = await wsGet(req('/api/app/workspace'))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, workspace: 'store', default: 'store' })
    r = await wsPost(req('/api/app/workspace', 'POST', { workspace: 'office', orgId: '00000000-0000-0000-0000-000000000000' }))
    expect(await r.json()).toEqual({ ok: true, workspace: 'office' })
    expect((await (await wsGet(req('/api/app/workspace'))).json()).workspace).toBe('office')
    expect((await wsPost(req('/api/app/workspace', 'POST', { workspace: 'garage' }))).status).toBe(400)
    r = await ccGet(req('/api/app/command-center?workspace=store'))
    const cc = await r.json()
    expect(cc).toMatchObject({ ok: true, workspace: 'store', hero: { agentsRunning: expect.any(Number) }, allowance: { used: expect.any(Number) } })
    expect(Array.isArray(cc.needsYou) && Array.isArray(cc.doneWithProof) && Array.isArray(cc.team)).toBe(true)
    expect(cc.team.every((a: { workspace: string }) => a.workspace === 'store')).toBe(true)
    expect((await ccGet(req('/api/app/command-center?workspace=garage'))).status).toBe(400)
    expect((await ccGet(req('/api/app/command-center'))).status).toBe(200)
  })

  it('without a session nothing is answered', async () => {
    const r = await ccGet(req('/api/app/command-center', 'GET', undefined, false)).catch(() => null)
    // outside a Next request there are no cookies: either a 401 or a refusal, never data
    if (r) { expect(r.status).toBeGreaterThanOrEqual(400); expect((await r.json()).ok).toBe(false) }
  })

  it('agent page, autonomy, instructions CRUD and chat', async () => {
    let r = await agentGet(req(`/api/app/agents/${AGENT}`), ctx({ id: AGENT }))
    expect(r.status).toBe(200)
    expect((await r.json()).dashboard.agent).toMatchObject({ id: 'store:inventory_watcher', name: 'Inventory Watcher' })
    expect((await agentGet(req('/api/app/agents/nope'), ctx({ id: 'nope' }))).status).toBe(404)
    expect((await agentGet(req('/api/app/agents/x'), ctx({ id: encodeURIComponent('office:00000000-0000-0000-0000-000000000000') }))).status).toBe(404)

    r = await autonomyPost(req(`/api/app/agents/${AGENT}/autonomy`, 'POST', { autonomy: 'ask_first' }), ctx({ id: AGENT }))
    expect(await r.json()).toMatchObject({ ok: true, agentId: 'store:inventory_watcher', autonomy: 'ask_first' })
    expect((await autonomyPost(req('/x', 'POST', { autonomy: 'yolo' }), ctx({ id: AGENT }))).status).toBe(400)

    r = await instrPost(req('/x', 'POST', { text: 'Never reorder candles' }), ctx({ id: AGENT }))
    const { instruction } = await r.json()
    expect(instruction).toMatchObject({ agentId: 'store:inventory_watcher', text: 'Never reorder candles', position: 0 })
    r = await instrPatch(req('/x', 'PATCH', { text: 'Never reorder candles in July' }), ctx({ id: AGENT, instructionId: instruction.id }))
    expect((await r.json()).instruction.text).toBe('Never reorder candles in July')
    expect((await (await instrGet(req('/x'), ctx({ id: AGENT }))).json()).instructions.map((i: { text: string }) => i.text)).toEqual(['Never reorder candles in July'])
    expect((await instrPost(req('/x', 'POST', { text: 'y'.repeat(501) }), ctx({ id: AGENT }))).status).toBe(400)
    expect(await (await instrDelete(req('/x', 'DELETE'), ctx({ id: AGENT, instructionId: instruction.id }))).json()).toEqual({ ok: true, deleted: true })
    expect((await instrDelete(req('/x', 'DELETE'), ctx({ id: AGENT, instructionId: instruction.id }))).status).toBe(404)

    r = await chatPost(req('/x', 'POST', { text: 'status' }), ctx({ id: AGENT }))
    const c = await r.json()
    expect(c.messages.map((m: { role: string }) => m.role)).toEqual(['owner', 'agent'])
    expect(c.messages[1].text).toMatch(/^Inventory Watcher: /)
    expect((await (await chatGet(req('/x'), ctx({ id: AGENT }))).json()).messages).toHaveLength(2)
    r = await teamChatPost(req('/x', 'POST', { text: 'sing me a song', workspace: 'store' }))
    expect((await r.json()).messages[1].text).toMatch(/^I can't answer that without AI turned on/)
  })

  it('needs-you: an unknown item is a 404, a bad decision a 400', async () => {
    expect((await needsPost(req('/x', 'POST', { decision: 'approve' }), ctx({ id: 'agent_action:00000000-0000-0000-0000-000000000000' }))).status).toBe(404)
    expect((await needsPost(req('/x', 'POST', { decision: 'maybe' }), ctx({ id: 'agent_action:00000000-0000-0000-0000-000000000000' }))).status).toBe(400)
  })
})
