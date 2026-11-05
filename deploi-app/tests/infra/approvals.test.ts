/**
 * Unified approvals: one list across engine proposals, agent emails and library actions with the exact
 * content, and one decide path that refuses a stale version, an expired item, another organization's
 * item, a decision the item does not offer, and staff.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { resetOffice } from '../office/helpers'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { listPendingApprovals, decideApproval, registerApprovalSource, approvalSources } from '../../lib/approvals'
import { runAgent } from '../../lib/agents/run'
import { createAgentMessages } from '../../lib/email/engine'
import { merchantActor, staffActor, resetMerchant } from '../merchant/helpers'
import { NW, HB, grantedAgent, cleanInfra } from './helpers'
import { fakeResend, restoreEmail, chaser, SUPPLIER, sent } from './email-env'
import type { Actor } from '../../lib/engine/actor'

const ready = await prepareDb()

async function libraryDraft(orgId: string, title = 'Campaign email draft') {
  return (await admin(db => db.one<{ id: string }>(`insert into library_actions (org_id, agent_key, action_type, title, summary, evidence, payload, mode, status, permission_basis, expires_at)
    values ($1, 'campaign', 'draft_campaign_email', $2, 'A spring campaign', '{"products":3}', '{"subject":"Spring","to":"list"}', 'draft', 'draft', 'draft: every change waits for your approval', now() + interval '14 days') returning id`, [orgId, title])))!.id
}
async function emailAwaiting(actor: Actor, m: typeof NW) {
  const c = await chaser(actor, m)
  const r = await createAgentMessages({ agentId: c.agentId, runId: null, actor: 'test', drafts: [{ taskKey: 'supplier_reorder', dedupeKey: `ap-${c.agentId}`, to: [SUPPLIER], cc: [], meta: {}, content: { subject: 'Restock request', bodyText: 'Please confirm 12 x Linen Throw.', attachments: [] } }] })
  return { ...c, messageId: r.created[0].id }
}

beforeEach(async () => { fakeResend(); if (ready) { await cleanInfra(); await resetMerchant(NW); await resetMerchant(HB); await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }); await admin(db => db.query(`delete from library_actions where org_id = any($1::uuid[]) and agent_key = 'campaign'`, [[NW.org, HB.org]])) } })
afterEach(restoreEmail)
afterAll(async () => { if (ready) { await cleanInfra(); await admin(db => db.query(`delete from library_actions where agent_key = 'campaign'`)) } })

describe.skipIf(!ready)('unified approvals', () => {
  it('lists every source with exact content, newest first, and only the organization\'s own items', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const agentId = await grantedAgent(nw, NW, 'Reviewer')
    await runAgent(agentId, { trigger: 'test', actor: nw.label })
    const mail = await emailAwaiting(nw, NW)
    const lib = await libraryDraft(NW.org)
    await libraryDraft(HB.org, 'Harbor draft')
    const { items, errors } = await listPendingApprovals(nw)
    expect(errors).toEqual([])
    expect(new Set(items.map(i => i.source))).toEqual(new Set(['engine', 'email', 'library']))
    expect(items.every(i => i.orgId === NW.org)).toBe(true)
    expect(items.map(i => i.createdAt)).toEqual([...items.map(i => i.createdAt)].sort().reverse())
    const e = items.find(i => i.id === mail.messageId)!
    expect(e.content).toMatchObject({ from: mail.mailbox, to: [SUPPLIER], subject: 'Restock request', body: 'Please confirm 12 x Linen Throw.' })
    expect(e.version).toMatch(/^[0-9a-f]{64}$/)
    const change = items.find(i => i.source === 'engine')!
    expect(change.content).toMatchObject({ field: 'inventoryPolicy', from: 'CONTINUE', to: 'DENY' })
    expect(change.content.evidence).toBeTruthy()
    expect(change.decisions).toEqual(['approve', 'reject'])
    expect(items.find(i => i.id === lib)!.content).toMatchObject({ actionType: 'draft_campaign_email', payload: { subject: 'Spring' } })
    // Harbor sees none of it
    const theirs = await listPendingApprovals(hb)
    expect(theirs.items.some(i => i.orgId === NW.org)).toBe(false)
    expect(approvalSources().map(s => s.key)).toEqual(expect.arrayContaining(['engine', 'email', 'library']))
  })

  it('decides through each source, bound to the version shown', async () => {
    const nw = await merchantActor(NW)
    const agentId = await grantedAgent(nw, NW, 'Reviewer')
    await runAgent(agentId, { trigger: 'test', actor: nw.label })
    const mail = await emailAwaiting(nw, NW)
    const lib = await libraryDraft(NW.org)
    const { items } = await listPendingApprovals(nw)
    const change = items.find(i => i.source === 'engine')!
    expect(await decideApproval(nw, 'engine', change.id, 'approve', { version: change.version })).toMatchObject({ status: 'verified' })
    // the email is edited and approved in one step: the approval binds to the edited text
    const e = items.find(i => i.id === mail.messageId)!
    expect(await decideApproval(nw, 'email', e.id, 'approve', { version: e.version, edits: { bodyText: 'Please confirm 10 x Linen Throw.' } })).toMatchObject({ status: 'accepted' })
    expect(sent).toHaveLength(1)
    expect(String(sent[0].body.text)).toMatch(/^Please confirm 10 x Linen Throw\./)
    const l = items.find(i => i.id === lib)!
    expect(await decideApproval(nw, 'library', l.id, 'approve', { version: l.version })).toMatchObject({ status: 'approved' })
    // a second decision on a decided item is refused
    await expect(decideApproval(nw, 'library', l.id, 'approve', { version: l.version })).rejects.toThrow(/not waiting/)
    // reject closes a store change without making it
    const other = (await listPendingApprovals(nw, { source: 'engine' })).items[0]
    expect(await decideApproval(nw, 'engine', other.id, 'reject', { version: other.version })).toMatchObject({ status: 'rejected' })
    expect(await admin(db => db.one('select status from proposals where id = $1', [other.id]))).toEqual({ status: 'dismissed' })
  })

  it('refuses a stale version, an expired item, another organization\'s item, a decision not offered, and staff', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const lib = await libraryDraft(NW.org)
    const v = (await listPendingApprovals(nw, { source: 'library' })).items.find(i => i.id === lib)!.version
    // the content changed after it was shown
    await admin(db => db.query(`update library_actions set payload = '{"subject":"Summer","to":"list"}' where id = $1`, [lib]))
    await expect(decideApproval(nw, 'library', lib, 'approve', { version: v })).rejects.toMatchObject({ code: 'hash_mismatch' })
    // another organization: simply not found
    const fresh = (await listPendingApprovals(nw, { source: 'library' })).items.find(i => i.id === lib)!.version
    await expect(decideApproval(hb, 'library', lib, 'approve', { version: fresh })).rejects.toMatchObject({ code: 'not_found' })
    // expired
    await admin(db => db.query(`update library_actions set expires_at = now() - interval '1 minute' where id = $1`, [lib]))
    const expiredV = (await admin(db => db.one<{ id: string; action_type: string; title: string; summary: string; evidence: Record<string, unknown>; payload: Record<string, unknown>; status: string; expires_at: string }>('select * from library_actions where id = $1', [lib])))!
    const { libraryVersion } = await import('../../lib/approvals/sources')
    await expect(decideApproval(nw, 'library', lib, 'approve', { version: libraryVersion(expiredV) })).rejects.toMatchObject({ code: 'expired' })
    expect((await listPendingApprovals(nw, { source: 'library' })).items.some(i => i.id === lib)).toBe(false)
    // drafts-only agent: its change can only be rejected
    const drafts = await grantedAgent(nw, NW, 'Drafter', { approvalMode: 'draft' })
    await runAgent(drafts, { trigger: 'test', actor: nw.label })
    const d = (await listPendingApprovals(nw, { source: 'engine' })).items.find(i => i.agent?.id === drafts)!
    expect(d.decisions).toEqual(['reject'])
    await expect(decideApproval(nw, 'engine', d.id, 'approve', { version: d.version })).rejects.toMatchObject({ code: 'forbidden' })
    // staff read with no decisions and cannot decide
    const staff = await staffActor()
    const seen = await listPendingApprovals(staff, { orgId: NW.org })
    expect(seen.items.length).toBeGreaterThan(0)
    expect(seen.items.every(i => i.decisions.length === 0)).toBe(true)
    await expect(decideApproval(staff, 'engine', d.id, 'reject', { version: d.version })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(decideApproval(nw, 'nope', d.id, 'reject', { version: d.version })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a registered source is listed and decided through the same guarantees; a failing source does not hide the others', async () => {
    const nw = await merchantActor(NW)
    const decided: string[] = []
    const item = { source: 'test-office', id: '00000000-0000-4000-8000-000000000001', orgId: NW.org, kind: 'office_action', title: 'Send the follow-up', agent: null, createdAt: new Date().toISOString(), expiresAt: null, version: 'a'.repeat(64), decisions: ['approve', 'reject'] as ('approve' | 'reject')[], why: null, content: { to: 'lead@example.com' } }
    registerApprovalSource({ key: 'test-office', label: 'Test', list: async (_db, orgId) => (orgId === NW.org ? [item] : []), find: async (_db, orgId, id) => (orgId === NW.org && id === item.id ? item : null), decide: async (_db, _a, id, d) => { decided.push(`${id}:${d}`); return { status: d } } })
    registerApprovalSource({ key: 'test-broken', label: 'Broken', list: async () => { throw new Error('office is down') }, find: async () => null, decide: async () => ({ status: 'x' }) })
    const r = await listPendingApprovals(nw)
    expect(r.items.some(i => i.source === 'test-office')).toBe(true)
    expect(r.errors).toEqual([{ source: 'test-broken', message: 'office is down' }])
    await expect(decideApproval(nw, 'test-office', item.id, 'approve', { version: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'hash_mismatch' })
    expect(await decideApproval(nw, 'test-office', item.id, 'approve', { version: item.version })).toMatchObject({ status: 'approve' })
    await expect(decideApproval(await merchantActor(HB), 'test-office', item.id, 'approve', { version: item.version })).rejects.toMatchObject({ code: 'not_found' })
    expect(decided).toEqual([`${item.id}:approve`])
  })
})
