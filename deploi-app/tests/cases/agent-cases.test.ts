/**
 * Every agent family works through the Resolution Engine: store correction agents (and the merchant's own
 * store checks), the watch checks, the Supplier Chaser's restock requests, the Competitor & Trend Watcher
 * and the agent library. Each family: scan -> case -> approve -> verified execution -> resolved, plus the
 * disappears-on-rescan, stale and refused paths, no duplicates on repeated runs, and organization isolation.
 */
import '../merchant/env'
process.env.AGENT_MAIL_DOMAIN ||= 'agents.getdeploi.test'
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { runScan } from '../../lib/engine/scan'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal } from '../../lib/engine/execute'
import { dismissIssue } from '../../lib/engine/review'
import { updateRule } from '../../lib/engine/rules'
import { createAgent, grantPolicy, pauseAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { syncSupplierRequests } from '../../lib/agents/supplier'
import { caseForRecord, getCase, listCases, runCaseCheck, type CaseRow } from '../../lib/cases'
import { closeCase } from '../../lib/cases/close'
import '../../lib/cases/jobs'
import { mutateSynthetic } from '../../lib/connectors/shopify/synthetic'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { startConnect, completeConnect } from '../../lib/email/accounts'
import { approveMessage } from '../../lib/email/engine'
import { syntheticCode, SYNTH_SEND, SYNTH_READ, getSynthMail, addSynthReply } from '../../lib/email/adapters/synthetic'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { encryptSecret } from '../../lib/connectors/credentials'
import { templatePolicy, TEMPLATES } from '../../lib/agents/templates'
import { setFindingsStatus } from '../../lib/competitors/queries'
import { setSwitch } from '../../lib/library/switches'
import { runLibraryAgent, approveAction, declineAction } from '../../lib/library/actions'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB, merchantActor, resetMerchant } from '../merchant/helpers'
import { resetLibrary, actionsOf } from '../library/helpers'

const ready = await prepareDb()
const { V } = NORTHWIND_IDS
const SUPPLIER = 'orders@supplier.example'
const STORES = ['https://linen-and-loom.example', 'harbor-home.example/collections/all', 'https://oak-and-ember.example']

const wipeCases = (org: string) => admin(db => db.query('delete from cases where org_id = $1', [org]))
const issueOf = (variant: string, check = 'shopify.oversell_policy') => admin(db => db.one<{ id: string; status: string }>(`select id, status from issues where connection_id = $1 and resource_id = $2 and check_key = $3 order by first_detected_at desc limit 1`, [NW.conn, variant, check]))
const proposalOf = (issueId: string) => admin(db => db.one<{ id: string; change_hash: string; status: string }>(`select id, change_hash, status from proposals where issue_id = $1 order by created_at desc limit 1`, [issueId]))
const caseOfIssue = async (issueId: string) => (await admin(db => caseForRecord(db, NW.org, 'issue', issueId)))!
const history = async (c: Pick<CaseRow, 'id'>) => (await admin(db => getCase(db, NW.org, c.id)))!
const statuses = async (c: Pick<CaseRow, 'id'>) => (await history(c)).events.filter(e => e.type === 'status' || e.type === 'verification').map(e => e.to_status)
const kindCount = (org: string, kind?: string) => admin(db => db.one<{ n: number }>(`select count(*)::int as n from cases where org_id = $1 and ($2::text is null or kind = $2)`, [org, kind ?? null])).then(r => r!.n)
const setPolicy = (variant: string, policy: 'CONTINUE' | 'DENY') => mutateSynthetic(NW.conn, s => { for (const p of s.products) for (const v of p.variants) if (v.id === variant) v.inventoryPolicy = policy })

beforeAll(() => { process.env.COMPETITOR_MIN_INTERVAL_MS = '0' })

describe.skipIf(!ready)('store correction agents and store checks work through cases', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB); await wipeCases(NW.org); await wipeCases(HB.org) })

  it('scan -> case -> approve -> verified execution -> resolved, with the verified read as the evidence', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const issues = await admin(db => db.query<{ id: string }>(`select id from issues where connection_id = $1 and status = 'open'`, [NW.conn]))
    expect(issues.length).toBeGreaterThan(0)
    // one case per issue, of the issue's own kind
    expect(await kindCount(NW.org)).toBe(issues.length)
    const issue = (await issueOf(V(2001)))!
    const c0 = await caseOfIssue(issue.id)
    expect(c0).toMatchObject({ kind: 'shopify_oversell_policy', suite: 'commerce', source_app: 'shopify', status: 'awaiting_approval', approval_required: true })
    expect(c0.records.map(r => r.type)).toEqual(['issue', 'store_resource'])
    // the store's own check has no agent; the case says it waits for the merchant
    expect(c0.next_action).toMatch(/Approve or decline/)

    const actor = await merchantActor(NW)
    const p = (await proposalOf(issue.id))!
    await approveProposal(actor, p.id, p.change_hash)
    expect((await caseOfIssue(issue.id)).status).toBe('executing')
    const r = await executeProposal(p.id, { actor: actor.label })
    expect(r.status).toBe('verified')
    const done = (await history(c0))
    expect(done.case.status).toBe('resolved')
    expect(done.case.outcome!.verifiedBy).toMatch(/shopify read after the change/)
    expect(done.case.outcome!.evidence[0]).toMatchObject({ source: 'shopify', ref: { type: 'execution', id: r.executionId }, detail: { field: 'inventoryPolicy', observed: 'DENY', expected: 'DENY' } })
    expect(await statuses(c0)).toEqual(['proposed', 'awaiting_approval', 'executing', 'verifying', 'resolved'])
    // the write is recorded as an action, and the execution is linked
    expect(done.events.filter(e => e.type === 'action').map(e => e.summary)).toEqual([expect.stringMatching(/Wrote inventoryPolicy .* "CONTINUE" to "DENY"/)])
    expect(await admin(db => db.one(`select 1 from case_links where case_id = $1 and ref_type = 'execution' and ref_id = $2`, [c0.id, r.executionId]))).toBeTruthy()
    // the Completed view shows it; Work in Progress does not
    expect((await admin(db => listCases(db, NW.org, { view: 'completed' }))).map(c => c.id)).toContain(c0.id)
    expect((await admin(db => listCases(db, NW.org, { view: 'in_progress' }))).map(c => c.id)).not.toContain(c0.id)
  })

  it('a problem gone on a rescan is resolved with the rescan as evidence; repeated scans never duplicate cases', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const n = await kindCount(NW.org)
    await runScan(NW.conn, { trigger: 'test' })
    await runScan(NW.conn, { trigger: 'test' })
    expect(await kindCount(NW.org)).toBe(n)
    const issue = (await issueOf(V(2003)))!
    const c = await caseOfIssue(issue.id)
    const eventsBefore = (await history(c)).events.length
    await runScan(NW.conn, { trigger: 'test' })
    expect((await history(c)).events.length).toBe(eventsBefore) // an unchanged problem adds no history
    // fixed outside Deploi: the next fresh read no longer finds it
    await setPolicy(V(2003), 'DENY')
    const scan = await runScan(NW.conn, { trigger: 'test' })
    const after = (await history(c)).case
    expect(after.status).toBe('resolved')
    expect(after.outcome!.summary).toBe('No longer present on a fresh read of the store')
    expect(after.outcome!.evidence[0]).toMatchObject({ label: 'The problem is no longer present on a fresh read of the store', ref: { type: 'scan', id: scan.scanId } })
    // no execution happened, so none is claimed
    expect((await history(c)).events.some(e => e.type === 'action')).toBe(false)
    // the problem coming back is a new problem: a new case
    await setPolicy(V(2003), 'CONTINUE')
    await runScan(NW.conn, { trigger: 'test' })
    const again = await caseOfIssue((await issueOf(V(2003)))!.id)
    expect(again.id).not.toBe(c.id)
    expect(again.status).toBe('awaiting_approval')
  })

  it('stale: an outside change after approval sends the case back to investigating with the reason; a changed rule refuses approval the same way', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    // the merchant tags the product as a pre-order after approving: the check no longer proposes this change
    const i1 = (await issueOf(V(2004)))!
    const p1 = (await proposalOf(i1.id))!
    await approveProposal(actor, p1.id, p1.change_hash)
    await mutateSynthetic(NW.conn, s => { for (const p of s.products) if (p.variants.some(v => v.id === V(2004))) p.tags = ['pre-order'] })
    const r = await executeProposal(p1.id, { actor: actor.label })
    expect(r.status).toBe('stale')
    const c1 = await caseOfIssue(i1.id)
    expect(c1.status).toBe('investigating')
    expect(c1.status_reason).toMatch(/went stale: the check no longer proposes this exact change/)
    expect(await statuses(c1)).not.toContain('resolved')

    // already fixed in Shopify before the write: the fresh read before writing is the evidence
    const i0 = (await issueOf(V(2011)))!
    const p0 = (await proposalOf(i0.id))!
    await approveProposal(actor, p0.id, p0.change_hash)
    await setPolicy(V(2011), 'DENY')
    expect((await executeProposal(p0.id, { actor: actor.label })).reason).toBe('already in the proposed state')
    const c0 = await caseOfIssue(i0.id)
    expect(c0.status).toBe('resolved')
    expect(c0.outcome!.summary).toMatch(/Already corrected outside Deploi/)
    expect(c0.outcome!.evidence[0].label).toMatch(/A fresh read shows "DENY"/)

    const i2 = (await issueOf(V(2003)))!
    const p2 = (await proposalOf(i2.id))!
    const rule = await admin(db => db.one<{ config: Record<string, unknown> }>(`select config from merchant_rules where connection_id = $1 and check_key = 'shopify.oversell_policy'`, [NW.conn]))
    await admin(db => updateRule(db, { connectionId: NW.conn, checkKey: 'shopify.oversell_policy', config: { ...rule!.config, exemptTags: ['something-new'] }, actor: 'test' }))
    await expect(approveProposal(actor, p2.id, p2.change_hash)).rejects.toMatchObject({ code: 'rule_changed' })
    // the refusal is kept: the proposal is retired and the case says why
    expect((await proposalOf(i2.id))!.status).toBe('stale')
    const c2 = await caseOfIssue(i2.id)
    expect(c2).toMatchObject({ status: 'investigating', status_reason: expect.stringMatching(/the rule changed after this proposal was made/) })
  })

  it('dismissing closes the case as cancelled with the reason, never as resolved', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const i = (await issueOf(V(2001)))!
    await dismissIssue(await merchantActor(NW), i.id, 'we sell this on backorder')
    const c = await caseOfIssue(i.id)
    expect(c).toMatchObject({ status: 'cancelled', status_reason: 'Closed by you: we sell this on backorder', outcome: null })
  })

  it('agents: a drafts-only agent proposes; a review agent waits for approval; a paused agent blocks its case; one case per problem across agent and store check', async () => {
    const actor = await merchantActor(NW)
    await runScan(NW.conn, { trigger: 'test' }) // the store check finds it first
    const legacy = await kindCount(NW.org, 'shopify_oversell_policy')
    const drafts = await createAgent(actor, { name: 'Stock Guardian', taskText: '', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], approvalMode: 'draft' } })
    await grantPolicy(actor, drafts.agentId, drafts.policyId, drafts.policyHash)
    await runAgent(drafts.agentId, { trigger: 'test', actor: actor.label })
    // the agent takes over the store check's drafts: still one case per problem
    expect(await kindCount(NW.org, 'shopify_oversell_policy')).toBe(legacy)
    const agentIssue = (await admin(db => db.one<{ id: string }>(`select id from issues where agent_id = $1 and resource_id = $2`, [drafts.agentId, V(2001)])))!
    const c = await caseOfIssue(agentIssue.id)
    expect(c.status).toBe('proposed')
    expect(c.status_reason).toMatch(/only shows the exact change/)
    await runAgent(drafts.agentId, { trigger: 'test', actor: actor.label })
    expect(await kindCount(NW.org, 'shopify_oversell_policy')).toBe(legacy)
    expect((await history(c)).events.filter(e => e.type === 'status').length).toBe((await statuses(c)).length) // sanity
    await pauseAgent(actor, drafts.agentId)

    await resetMerchant(NW); await wipeCases(NW.org)
    const review = await createAgent(actor, { name: 'Stock Guardian', taskText: '', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], approvalMode: 'review' } })
    await grantPolicy(actor, review.agentId, review.policyId, review.policyHash)
    await runAgent(review.agentId, { trigger: 'test', actor: actor.label })
    const ri = (await admin(db => db.one<{ id: string }>(`select id from issues where agent_id = $1 and resource_id = $2`, [review.agentId, V(2001)])))!
    const rc = await caseOfIssue(ri.id)
    expect(rc).toMatchObject({ status: 'awaiting_approval', agent_kind: 'engine', agent_ref: review.agentId })
    // refused: pausing the agent retires its waiting changes; the case is blocked with the reason
    await pauseAgent(actor, review.agentId)
    const blocked = await caseOfIssue(ri.id)
    expect(blocked.status).toBe('blocked')
    expect(blocked.status_reason).toMatch(/Refused before anything was written: the agent was paused/)
  })

  it('watch checks (Inventory Watcher, Store Health Checker): a needs-a-person finding is investigated, never "fixed" by Deploi', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const watch = await admin(db => db.one<{ id: string }>(`select id from issues where connection_id = $1 and check_key = 'shopify.oversold_stop_selling' and status = 'open' limit 1`, [NW.conn]))
    expect(watch).toBeTruthy()
    const c = await caseOfIssue(watch!.id)
    expect(c).toMatchObject({ kind: 'shopify_oversold_stop_selling', status: 'investigating', status_reason: expect.stringMatching(/^Needs a person:/) })
    expect(c.next_action).toBeTruthy()
    // a registered checker looks again later
    expect(c.next_check_at).not.toBeNull()
    await runCaseCheck(c.id, new Date(Date.now() + 7 * 3600e3))
    expect((await caseOfIssue(watch!.id)).status).toBe('investigating')
  })

  it('organization isolation: a scan opens cases only in its own organization; another organization can neither see nor close them', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    expect(await kindCount(HB.org)).toBe(0)
    const nw = (await admin(db => db.one<{ id: string; ref: string }>(`select id, ref from cases where org_id = $1 limit 1`, [NW.org])))!
    const seen = await withUser({ uid: (await merchantActor(HB) as Extract<Actor, { kind: 'profile' }>).session.uid, email: HB.email, role: 'client', agencyId: HB.org, orgType: 'merchant' }, db => db.query('select id from cases where id = $1', [nw.id]))
    expect(seen).toEqual([])
    await expect(closeCase(await merchantActor(HB), nw.ref, { reason: 'mine now' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe.skipIf(!ready)('Supplier Chaser restock requests work through cases', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB); await wipeCases(NW.org) })

  async function setup() {
    const actor = await merchantActor(NW)
    const { url } = await startConnect(actor, { provider: 'synthetic', read: true })
    const acc = (await completeConnect(actor, { state: new URL(url, 'http://x').searchParams.get('state')!, code: syntheticCode('agent@northwind-goods.example', [SYNTH_SEND, SYNTH_READ]), error: null })).account
    const email = { accountId: acc.id, permission: 'send_approved', purpose: 'Ask suppliers to restock low-stock products and follow up once', tasks: ['supplier_reorder', 'supplier_followup'],
      recipients: { addresses: [SUPPLIER], domains: [] }, notify: [], read: { enabled: true }, supplierReorder: { supplierAddress: SUPPLIER, thresholdAvailable: 0, cooldownDays: 7, followupDays: 3 } }
    const c = await createAgent(actor, { name: 'Supplier Chaser', taskText: 'chase suppliers', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, approvalMode: 'draft', email } })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    return { actor, acc, agentId: c.agentId }
  }
  const restockCases = () => admin(db => db.query<CaseRow>(`select * from cases where org_id = $1 and kind = 'supplier_restock' order by opened_at`, [NW.org]))

  it('request -> approval -> sent (waiting on the supplier) -> reply recorded -> resolved only when a fresh read shows the stock back', async () => {
    const { actor, acc, agentId } = await setup()
    await runAgent(agentId, { trigger: 'test', actor: actor.label })
    let [c] = await restockCases()
    expect(c).toMatchObject({ status: 'awaiting_approval', agent_kind: 'engine', agent_ref: agentId, source_app: 'shopify' })
    await runAgent(agentId, { trigger: 'test', actor: actor.label })
    expect(await restockCases()).toHaveLength(1) // a second run the same day: no duplicate

    const msg = (await admin(db => db.one<{ id: string; content_hash: string }>(`select id, content_hash from email_messages where agent_id = $1 and task_key = 'supplier_reorder'`, [agentId])))!
    expect((await approveMessage(actor, msg.id, msg.content_hash)).status).toBe('accepted')
    await syncSupplierRequests(agentId)
    ;[c] = await restockCases()
    expect(c.status).toBe('waiting_external')
    expect(c.status_reason).toMatch(/waiting for the supplier to reply/)
    const h1 = await history(c)
    expect(h1.events.filter(e => e.type === 'action').map(e => e.summary)).toEqual([`Restock request sent to ${SUPPLIER}`])
    // the send is an action, not a resolution
    expect(await statuses(c)).not.toContain('resolved')

    // the supplier replies: recorded as evidence, the case now checks the stock
    const box = await getSynthMail(acc.id)
    await addSynthReply(acc.id, box.sent[0].threadId, SUPPLIER)
    await admin(async db => {
      const row = await db.one<{ id: string }>(`insert into email_inbound (org_id, account_id, agent_id, provider_email_id, from_address, classification, status, thread_message_id, key_id, content_ciphertext, received_at)
        values ($1,$2,$3,'prov-restock',$4,'reply','accepted',$5,'pending','pending',now()) returning id`, [NW.org, acc.id, agentId, SUPPLIER, msg.id])
      const e = encryptSecret(JSON.stringify({ subject: 'Re: Restock', text: 'We can ship by 2026-12-01.' }), `email-inbound:${row!.id}`)
      await db.query('update email_inbound set key_id = $2, content_ciphertext = $3 where id = $1', [row!.id, e.keyId, e.ciphertext])
    })
    await syncSupplierRequests(agentId)
    ;[c] = await restockCases()
    expect(c.status).toBe('verifying')
    expect(c.evidence.map(e => e.label)).toContainEqual(expect.stringMatching(/replied; a date is mentioned: 2026-12-01 \(read from the reply, not confirmed\)/))

    // still low on a fresh read: not resolved
    await runCaseCheck(c.id, new Date(Date.now() + 2 * 864e5))
    expect((await history(c)).case.status).toBe('verifying')
    // stock arrives: the next check's fresh read resolves it, with each item's level as evidence
    const items = (await admin(db => db.query<{ ref_id: string }>(`select ref_id from case_links where case_id = $1 and ref_type = 'store_resource'`, [c.id]))).map(r => r.ref_id)
    expect(items.length).toBeGreaterThan(0)
    await mutateSynthetic(NW.conn, s => { for (const p of s.products) for (const v of p.variants) if (items.includes(v.id)) { v.levels[0].available = 12; v.levels[0].onHand = 12; v.levels[0].committed = 0 } })
    await runCaseCheck(c.id, new Date(Date.now() + 4 * 864e5))
    const done = (await history(c)).case
    expect(done.status).toBe('resolved')
    expect(done.outcome!.evidence).toHaveLength(items.length)
    expect(done.outcome!.evidence.every(e => /12 available/.test(e.label))).toBe(true)
    expect(await statuses(c)).toEqual(['proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying', 'resolved'])
  })

  it('the owner can close a restock request with a reason (cancelled, never resolved); a reason is required', async () => {
    const { actor, agentId } = await setup()
    await runAgent(agentId, { trigger: 'test', actor: actor.label })
    const [c] = await restockCases()
    await expect(closeCase(actor, c.ref, { reason: '  ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(closeCase(await merchantActor(HB), c.ref, { reason: 'no' })).rejects.toMatchObject({ code: 'not_found' })
    const closed = await closeCase(actor, c.ref, { reason: 'ordered by phone instead' })
    expect(closed).toMatchObject({ status: 'cancelled', status_reason: 'Closed by you: ordered by phone instead', outcome: null })
    // a later sync never reopens or resolves it
    await syncSupplierRequests(agentId)
    expect((await history(c)).case.status).toBe('cancelled')
  })
})

describe.skipIf(!ready)('Competitor & Trend Watcher findings are informational cases', () => {
  beforeEach(async () => {
    setEmailFetch(async url => { throw new Error(`unexpected HTTP call in test: ${url}`) })
    await resetMerchant(NW); await wipeCases(NW.org)
  })
  afterEach(() => setEmailFetch(null))

  it('one market_signal case per new finding (none for the baseline); acknowledging closes it as cancelled "acknowledged", never resolved', async () => {
    const actor = await merchantActor(NW)
    const t = TEMPLATES.find(x => x.key === 'competitor_watcher')!
    const policy = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', notify: null, competitor: { stores: STORES, keywords: [], cadence: 'daily' } })
    const c = await createAgent(actor, { name: 'Trend Watcher', taskText: t.job, policy, mailbox: false, templateKey: t.key })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    // the baseline is a starting point, not news: only the cross-store inferences of the first run are signals
    const firstRun = (await admin(db => db.one<{ n: number }>(`select count(*)::int as n from competitor_findings where agent_id = $1 and kind <> 'baseline'`, [c.agentId])))!.n
    expect(await kindCount(NW.org, 'market_signal')).toBe(firstRun)
    expect(await admin(db => db.query(`select 1 from cases c join case_links l on l.case_id = c.id join competitor_findings f on f.id::text = l.ref_id where c.org_id = $1 and f.kind = 'baseline'`, [NW.org]))).toEqual([])
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    const findings = await admin(db => db.query<{ id: string }>(`select id from competitor_findings where agent_id = $1 and kind <> 'baseline' and status = 'new'`, [c.agentId]))
    expect(findings.length).toBeGreaterThan(1)
    expect(await kindCount(NW.org, 'market_signal')).toBe(findings.length)
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    const all = (await admin(db => db.one<{ n: number }>(`select count(*)::int as n from competitor_findings where agent_id = $1 and kind <> 'baseline'`, [c.agentId])))!.n
    expect(await kindCount(NW.org, 'market_signal')).toBe(all) // still one case per finding, none twice

    const first = (await admin(db => caseForRecord(db, NW.org, 'competitor_finding', findings[0].id)))!
    expect(first).toMatchObject({ suite: 'commerce', source_app: 'public_web', status: 'detected', priority: 'low' })
    expect(first.evidence[0].detail).toHaveProperty('url')
    const ack = await closeCase(actor, first.ref, {})
    expect(ack).toMatchObject({ status: 'cancelled', status_reason: 'acknowledged', outcome: null })
    expect(await admin(db => db.one('select status from competitor_findings where id = $1', [findings[0].id]))).toEqual({ status: 'seen' })
    // marking the rest seen in the watcher's own view acknowledges their cases too
    await setFindingsStatus(actor, c.agentId, 'seen', null)
    const open = await admin(db => db.query(`select 1 from cases where org_id = $1 and kind = 'market_signal' and status not in ('cancelled')`, [NW.org]))
    expect(open).toEqual([])
    expect(await admin(db => db.query(`select 1 from cases where org_id = $1 and kind = 'market_signal' and status = 'resolved'`, [NW.org]))).toEqual([])
  })
})

describe.skipIf(!ready)('agent library work follows the engine lifecycle', () => {
  const NOW = new Date('2026-10-29T12:00:00Z')
  beforeEach(async () => { await resetLibrary(NW, 'pro'); await wipeCases(NW.org) })
  const libCases = () => admin(db => db.query<CaseRow>(`select * from cases where org_id = $1 and kind = 'library_action' order by opened_at`, [NW.org]))
  const caseOfAction = async (id: string) => (await admin(db => caseForRecord(db, NW.org, 'library_action', id)))!

  it('draft -> awaiting approval -> approved write -> resolved by a separate fresh read; decline cancels; repeated runs never duplicate', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'listing_writer', true)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const drafts = await actionsOf(NW, 'listing_writer')
    expect(drafts.length).toBeGreaterThan(1)
    expect((await libCases()).length).toBe(drafts.length)
    expect((await libCases()).every(c => c.status === 'awaiting_approval' && c.agent_kind === 'library' && c.agent_ref === 'listing_writer')).toBe(true)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    expect((await libCases()).length).toBe(drafts.length)

    const title = drafts.find(a => a.action_type === 'draft_title')!
    const r = await approveAction(actor, title.id, NOW)
    expect(r.status).toBe('done')
    const c = await caseOfAction(title.id)
    expect(c.status).toBe('resolved')
    expect(c.outcome!.evidence[0].label).toBe('A fresh read shows the title as approved')
    expect(c.outcome!.evidence[0].detail).toMatchObject({ observed: title.payload.to, expected: title.payload.to })
    expect(await statuses(c)).toEqual(['proposed', 'awaiting_approval', 'executing', 'verifying', 'resolved'])

    const other = drafts.find(a => a.id !== title.id)!
    await declineAction(actor, other.id, 'I write my own', NOW)
    expect(await caseOfAction(other.id)).toMatchObject({ status: 'cancelled', status_reason: 'Declined by you: I write my own' })
  })

  it('a reported problem gone on the next run is resolved with that read as evidence and its waiting draft withdrawn; an expired draft goes back to investigating', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'listing_writer', true)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const desc = (await actionsOf(NW, 'listing_writer')).filter(a => a.action_type === 'draft_description')
    expect(desc.length).toBeGreaterThan(1)
    const [gone, expiring] = desc
    // the merchant writes a full description themselves
    await mutateSynthetic(NW.conn, s => {
      const lib = ((s as unknown as { library?: { descriptions?: Record<string, string> } }).library ??= {})
      lib.descriptions = { ...(lib.descriptions ?? {}), [String(gone.payload.productId)]: 'A long and careful description written by the owner, with materials, sizes, care instructions and where it is made, for every customer.' }
    })
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const g = await caseOfAction(gone.id)
    expect(g.status).toBe('resolved')
    expect(g.outcome!.summary).toBe('No longer present on a fresh read of the store')
    expect((await actionsOf(NW, 'listing_writer')).find(a => a.id === gone.id)!.status).toBe('expired')

    await admin(db => db.query(`update library_actions set expires_at = now() - interval '1 day' where id = $1`, [expiring.id]))
    await expect(approveAction(actor, expiring.id)).rejects.toMatchObject({ code: 'conflict' })
    const ec = await caseOfAction(expiring.id)
    await runCaseCheck(ec.id, new Date(Date.now() + 2 * 864e5))
    expect(await caseOfAction(expiring.id)).toMatchObject({ status: 'investigating', status_reason: expect.stringMatching(/The draft expired/) })
  })

  it('an engine-backed library agent leaves the stock cases to its engine agent: no duplicate case for the same problem', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'inventory_watcher', true, { settings: { notify: NW.email } }).catch(async () => setSwitch(actor, 'inventory_watcher', true))
    await runLibraryAgent({ orgId: NW.org, agentKey: 'inventory_watcher', trigger: 'test', actor: actor.label, now: NOW })
    const flags = (await actionsOf(NW, 'inventory_watcher')).filter(a => a.action_type === 'flag_oversold' || a.action_type === 'draft_inventory_policy_fix')
    expect(flags.length).toBeGreaterThan(0)
    expect(await libCases()).toEqual([])
    // the engine agent's issues carry them, one case per problem
    const dupes = await admin(db => db.query(`select dedupe_key from cases where org_id = $1 and status not in ('resolved','cancelled') group by dedupe_key having count(*) > 1`, [NW.org]))
    expect(dupes).toEqual([])
    expect(await kindCount(NW.org)).toBeGreaterThan(0)
  })
})
