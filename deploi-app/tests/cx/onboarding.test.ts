import './helpers'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { merchantActor, staffActor } from '../merchant/helpers'
import { enabledProducts } from '../../lib/products'
import { grantPolicy, deleteAgent } from '../../lib/agents/lifecycle'
import {
  wizardView, saveBusiness, chooseProducts, setAgreements, autoSetupAgents, skipAgents, firstScan, completeWizard,
  draftsOnlyTemplatePolicy, assertDraftsOnly, RECOMMENDED_AGENTS, validTimezone,
} from '../../lib/library/onboarding'
import { NW, HB, resetCx } from './helpers'

const ready = await prepareDb()

const agentsOf = (org: string) => admin(db => db.query<{ id: string; name: string; status: string; approval_mode: string | null; email_permission: string | null; policy_status: string }>(
  `select a.id, a.name, a.status, p.policy->>'approvalMode' as approval_mode, p.policy->'email'->>'permission' as email_permission, p.status as policy_status
   from agents a join agent_policies p on p.agent_id = a.id where a.org_id = $1 and a.status <> 'deleted' order by a.created_at`, [org]))

describe('drafts-only policy for automatic setup', () => {
  it('forces every tool to drafts only and refuses anything higher', () => {
    for (const key of RECOMMENDED_AGENTS.commerce) {
      const p = draftsOnlyTemplatePolicy(key, { connectionId: '00000000-0000-0000-0000-000000000001', timezone: 'UTC', notify: 'owner@example.com', withEmail: true })
      expect(p.approvalMode).toBe('draft')
      expect((p.email as { permission: string }).permission).toBe('draft')
      const noMail = draftsOnlyTemplatePolicy(key, { connectionId: '00000000-0000-0000-0000-000000000001', timezone: 'UTC', notify: null, withEmail: false })
      expect(noMail.email).toBeUndefined()
    }
    expect(() => assertDraftsOnly({ approvalMode: 'review' })).toThrow(/drafts only/)
    expect(() => assertDraftsOnly({ approvalMode: 'draft', email: { permission: 'send_autonomous' } })).toThrow(/drafts only/)
    expect(validTimezone('Europe/London')).toBe(true)
    expect(validTimezone('Mars/Base')).toBe(false)
  })
})

describe.skipIf(!ready)('setup wizard', () => {
  let original = ''
  beforeEach(async () => {
    await resetCx(NW); await resetCx(HB)
    original = (await admin(db => db.one<{ name: string }>('select name from agencies where id = $1', [NW.org])))!.name
  })
  afterEach(async () => {
    delete process.env.AGENT_MAIL_DOMAIN
    await admin(db => db.query('update agencies set name = $2 where id = $1', [NW.org, original]))
    await resetCx(NW)
  })

  it('walks business, products, connect, agreements, agents, scan and done, and persists each step', async () => {
    const actor = await merchantActor(NW)
    let v = await wizardView(actor)
    expect(v.current).toBe('business')
    expect(v.steps.map(s => s.key)).toEqual(['business', 'products', 'connect', 'agreements', 'agents', 'scan', 'done'])
    await expect(saveBusiness(actor, { name: original, timezone: 'Nowhere/Here' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(saveBusiness(actor, { name: '', timezone: 'UTC' })).rejects.toMatchObject({ code: 'invalid_input' })
    await saveBusiness(actor, { name: original, timezone: 'America/Chicago' })
    v = await wizardView(actor)
    expect(v.current).toBe('products')
    expect(v.business).toMatchObject({ name: original, timezone: 'America/Chicago', saved: true })

    await expect(chooseProducts(actor, { commerce: false, office: false })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(autoSetupAgents(actor)).rejects.toMatchObject({ code: 'needs_setup' })
    await chooseProducts(actor, { commerce: true, office: true, platform: 'shopify' })
    expect(await admin(db => enabledProducts(db, NW.org))).toEqual(['commerce', 'office'])
    v = await wizardView(actor)
    // the synthetic Shopify store is already connected, so connect is done and agreements is next
    expect(v.steps.find(s => s.key === 'connect')!.state).toBe('done')
    expect(v.current).toBe('agreements')
    await expect(setAgreements(actor, 'maybe')).rejects.toMatchObject({ code: 'invalid_input' })
    await setAgreements(actor, 'skipped')
    v = await wizardView(actor)
    expect(v.steps.find(s => s.key === 'agreements')!.state).toBe('skipped')
    expect(v.current).toBe('agents')
    expect(v.agents.map(a => a.status)).toEqual(['not_created', 'not_created'])

    const r = await autoSetupAgents(actor)
    expect(r.created).toEqual(['inventory_watcher', 'store_health_checker'])
    v = await wizardView(actor)
    expect(v.current).toBe('agents') // created, but nothing is granted automatically
    for (const a of v.agents) {
      expect(a.status).toBe('draft')
      expect(a.tier).toBe('draft')
      expect(a.pending?.summary.grants.length).toBeGreaterThan(0)
    }
    await expect(completeWizard(actor)).rejects.toMatchObject({ code: 'needs_setup' })
    for (const a of v.agents) await grantPolicy(actor, a.agentId!, a.pending!.policyId, a.pending!.policyHash)
    v = await wizardView(actor)
    expect(v.agents.map(a => a.status)).toEqual(['active', 'active'])
    expect(v.current).toBe('scan')
    const scan = await firstScan(actor)
    expect(scan.resourcesScanned).toBeGreaterThan(0)
    v = await wizardView(actor)
    expect(v.current).toBe('done')
    expect(await completeWizard(actor)).toMatchObject({ completed: true })
    v = await wizardView(actor)
    expect(v.completedAt).toBeTruthy()
    expect(v.steps.every(s => s.state === 'done' || s.state === 'skipped')).toBe(true)
    // granted agents are still drafts only: the grant did not widen anything
    expect((await agentsOf(NW.org)).filter(a => a.policy_status === 'active').every(a => a.approval_mode === 'draft')).toBe(true)
  })

  it('creates the recommended agents at drafts only, once, even when asked twice at the same time', async () => {
    process.env.AGENT_MAIL_DOMAIN = 'agents.getdeploi.test'
    const actor = await merchantActor(NW)
    await chooseProducts(actor, { commerce: true, office: false })
    const [a, b] = await Promise.all([autoSetupAgents(actor), autoSetupAgents(actor)])
    expect([...a.created, ...b.created].sort()).toEqual(['inventory_watcher', 'store_health_checker'])
    await autoSetupAgents(actor)
    const rows = await agentsOf(NW.org)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.status).toBe('draft')
      expect(row.policy_status).toBe('pending_grant')
      expect(row.approval_mode).toBe('draft')
      expect(row.email_permission).toBe('draft')
    }
    // each got its own mailbox (agents with email tasks), and nothing was sent or granted
    const boxes = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from email_accounts where org_id = $1 and provider = 'deploi'`, [NW.org]))
    expect(boxes!.n).toBe(2)
    // deleting one and re-running recreates only that one
    await deleteAgent(actor, rows[0].id)
    const again = await autoSetupAgents(actor)
    expect(again.created).toHaveLength(1)
    expect(again.existing).toHaveLength(1)
    expect(await agentsOf(NW.org)).toHaveLength(2)
  })

  it('without agent mailboxes the agents have no email permission at all; skipping is recorded', async () => {
    const actor = await merchantActor(NW)
    await chooseProducts(actor, { commerce: true, office: false })
    await autoSetupAgents(actor)
    expect((await agentsOf(NW.org)).every(r => r.email_permission === null && r.approval_mode === 'draft')).toBe(true)
    await skipAgents(actor)
    expect((await wizardView(actor)).steps.find(s => s.key === 'agents')!.state).toBe('skipped')
  })

  it('Office only: no store agents, connect and scan are not needed; Commerce is switched off', async () => {
    const actor = await merchantActor(NW)
    await chooseProducts(actor, { commerce: false, office: true })
    expect(await admin(db => enabledProducts(db, NW.org))).toEqual(['office'])
    const v = await wizardView(actor)
    expect(v.agents).toEqual([])
    expect(v.steps.find(s => s.key === 'connect')!.state).toBe('done')
    expect(v.steps.find(s => s.key === 'agents')!.state).toBe('skipped')
    expect(v.steps.find(s => s.key === 'scan')!.state).toBe('skipped')
    expect(await autoSetupAgents(actor)).toEqual({ created: [], existing: [], failed: [] })
  })

  it('is per organization: another store sees its own wizard; staff cannot run it', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    await chooseProducts(nw, { commerce: true, office: false })
    await autoSetupAgents(nw)
    const hv = await wizardView(hb)
    expect(hv.productsChosen).toBe(false)
    expect(hv.agents).toEqual([])
    expect(await agentsOf(HB.org)).toHaveLength(0)
    const staff = await staffActor()
    await expect(wizardView(staff)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(autoSetupAgents(staff)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(chooseProducts(staff, { commerce: true, office: true })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
