/**
 * authorizeAgentAction: the single check every agent run, write and send goes through. The matrix covers
 * organization access, the kill switch, status, grant, capability, tier, validity window, scope and
 * store access, and that a revoke or an expired grant takes effect at once for work already queued.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { authorizeAgentAction, type AgentAction } from '../../lib/engine/authorize'
import { pauseAgent, revokeAgent, stopAllAgents, clearAgentStop } from '../../lib/agents/lifecycle'
import { merchantActor, resetMerchant } from '../merchant/helpers'
import { NW, HB, grantedAgent, cleanInfra, UNTIL } from './helpers'

const ready = await prepareDb()
const OVERSELL = 'shopify.variant.set_inventory_policy'
const authz = (agentId: string, action: AgentAction, orgId: string | null = NW.org, now?: Date) => admin(db => authorizeAgentAction(db, { agentId, orgId, action, now }))
const code = async (p: ReturnType<typeof authz>) => { const r = await p; return r.ok ? 'ok' : r.code }

beforeEach(async () => { if (ready) { await cleanInfra(); await resetMerchant(NW); await resetMerchant(HB) } })
afterAll(async () => { if (ready) await cleanInfra() })

describe.skipIf(!ready)('authorizeAgentAction matrix', () => {
  it('store actions: tier, capability, scope, validity window and store access', async () => {
    const actor = await merchantActor(NW)
    const review = await grantedAgent(actor, NW, 'Review', { approvalMode: 'review', productScope: { mode: 'tags', tags: ['wool'] } })
    const auto = await grantedAgent(actor, NW, 'Auto', { approvalMode: 'autonomous', validUntil: UNTIL, productScope: { mode: 'tags', tags: ['linen'] } })
    // the action key the oversell correction registers
    const { correctionCapability } = await import('../../lib/engine/capabilities')
    expect(Object.keys(correctionCapability('shopify', 'oversell_policy')!.actions)).toContain(OVERSELL)
    const store = (tier: 'send_approved' | 'send_autonomous', extra: Partial<Extract<AgentAction, { tool: 'store' }>> = {}): AgentAction => ({ tool: 'store', actionKey: OVERSELL, tier, ...extra })

    expect(await code(authz(review, store('send_approved')))).toBe('ok')
    expect(await code(authz(review, store('send_autonomous')))).toBe('tier')
    expect(await code(authz(review, { tool: 'store', actionKey: 'shopify.variant.set_price', tier: 'send_approved' }))).toBe('capability')
    expect(await code(authz(review, { tool: 'store', actionKey: 'shopify.unknown', tier: 'send_approved' }))).toBe('capability')
    expect(await code(authz(auto, store('send_autonomous', { target: { productId: 'p1', productTags: ['linen'] } })))).toBe('ok')
    expect(await code(authz(auto, store('send_autonomous', { target: { productId: 'p1', productTags: ['wool'] } })))).toBe('scope')
    // expired grant: fails closed for "without asking" (the moment of acting is what counts)
    expect(await code(authz(auto, store('send_autonomous'), NW.org, new Date(Date.now() + 400 * 864e5)))).toBe('expired')
    // another organization's connection, or one that is gone
    expect(await code(authz(review, store('send_approved', { connectionId: HB.conn })))).toBe('store_access')
    await admin(db => db.query(`update store_connections set status = 'uninstalled' where id = $1`, [NW.conn]))
    expect(await code(authz(review, store('send_approved')))).toBe('store_access')
    await admin(db => db.query(`update store_connections set status = 'active' where id = $1`, [NW.conn]))
    // LIVE_WRITES=off does not stop synthetic stores, but a real store is refused
    await admin(db => db.query(`update store_connections set is_synthetic = false where id = $1`, [NW.conn]))
    process.env.LIVE_WRITES = 'off'
    try { expect(await authz(review, store('send_approved'))).toMatchObject({ ok: false, code: 'store_access', reason: expect.stringMatching(/LIVE_WRITES/) }) } finally { delete process.env.LIVE_WRITES }
  })

  it('organization access, kill switch, status and grant come first, for every tool', async () => {
    const actor = await merchantActor(NW)
    const a = await grantedAgent(actor, NW, 'Gatekeeper')
    expect(await code(authz(a, { tool: 'run' }))).toBe('ok')
    expect(await code(authz(a, { tool: 'run' }, HB.org))).toBe('wrong_org')
    expect(await code(authz('00000000-0000-4000-8000-000000000000', { tool: 'run' }))).toBe('not_found')
    await stopAllAgents(actor, 'drill')
    expect(await code(authz(a, { tool: 'run' }))).toBe('org_stopped')
    await clearAgentStop(actor)
    expect(await code(authz(a, { tool: 'run' }))).toBe('agent_inactive') // still paused by the stop
    await admin(db => db.query(`update agents set status = 'active' where id = $1`, [a]))
    await pauseAgent(actor, a)
    expect(await code(authz(a, { tool: 'store', actionKey: OVERSELL, tier: 'send_approved' }))).toBe('agent_inactive')
    await admin(db => db.query(`update agents set status = 'active' where id = $1`, [a]))
    await revokeAgent(actor, a)
    // revoked: the status says so, and even a forced status would find no grant
    expect(await code(authz(a, { tool: 'run' }))).toBe('agent_inactive')
    await admin(db => db.query(`update agents set status = 'active' where id = $1`, [a]))
    expect(await code(authz(a, { tool: 'run' }))).toBe('no_grant')
  })

  it('email actions: task, mailbox, tier, validity and recipients', async () => {
    const actor = await merchantActor(NW)
    const acct = (await admin(db => db.one<{ id: string }>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, is_synthetic, connected_by) values ($1, 'synthetic', 'ops@northwind.example', 'active', '{synthetic.send}', true, false, true, 'test') returning id`, [NW.org])))!.id
    const email = (permission: string, extra: Record<string, unknown> = {}) => ({ email: { accountId: acct, permission, purpose: 'Restock requests', tasks: ['supplier_reorder'], recipients: { addresses: ['orders@supplier.example'], domains: [] }, supplierReorder: { supplierAddress: 'orders@supplier.example' }, ...extra }, approvalMode: 'draft' })
    const approved = await grantedAgent(actor, NW, 'Mail approved', email('send_approved'))
    const auto = await grantedAgent(actor, NW, 'Mail auto', email('send_autonomous', { validUntil: UNTIL }))
    const drafts = await grantedAgent(actor, NW, 'Mail drafts', email('draft'))
    const send = (tier: 'draft' | 'send_approved' | 'send_autonomous', extra: Record<string, unknown> = {}): AgentAction => ({ tool: 'email', taskKey: 'supplier_reorder', tier, accountId: acct, recipients: ['orders@supplier.example'], ...extra })
    expect(await code(authz(approved, send('send_approved')))).toBe('ok')
    expect(await code(authz(approved, send('send_autonomous')))).toBe('tier')
    expect(await code(authz(drafts, send('send_approved')))).toBe('tier')
    expect(await code(authz(drafts, send('draft')))).toBe('ok')
    expect(await code(authz(approved, send('send_approved', { taskKey: 'run_report' })))).toBe('capability')
    expect(await code(authz(approved, send('send_approved', { taskKey: 'human_reply' })))).toBe('ok')
    expect(await code(authz(approved, send('send_approved', { accountId: '00000000-0000-4000-8000-000000000000' })))).toBe('capability')
    expect(await code(authz(auto, send('send_autonomous')))).toBe('ok')
    expect(await code(authz(auto, send('send_autonomous', { recipients: ['someone@else.example'] })))).toBe('scope')
    expect(await code(authz(auto, send('send_autonomous'), NW.org, new Date(Date.now() + 400 * 864e5)))).toBe('expired')
    const storeOnly = await grantedAgent(actor, NW, 'No mail', { approvalMode: 'draft' })
    expect(await code(authz(storeOnly, send('send_approved')))).toBe('capability')
  })
})
