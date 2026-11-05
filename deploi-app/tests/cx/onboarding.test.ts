import './helpers'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { merchantActor, staffActor } from '../merchant/helpers'
import { enabledProducts } from '../../lib/products'
import { deleteAgent } from '../../lib/agents/lifecycle'
import {
  wizardView, saveBusiness, chooseProducts, autoSetupAgents, skipAgents, skipDiscovery, completeWizard,
  draftsOnlyTemplatePolicy, assertDraftsOnly, RECOMMENDED_AGENTS, validTimezone,
} from '../../lib/library/onboarding'
import { discoverNow, discoverView, setUpTeam, grantShownTeam } from '../../lib/discovery'
import { recordAcceptance, requiredAgreements } from '../../lib/legal'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { resetOffice } from '../office/helpers'
import { resetDiscovery } from '../discovery/helpers'
import { createOwnOrganization } from '../../lib/platform/signup'
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
    await resetDiscovery(NW)
    await resetCx(NW); await resetCx(HB)
    original = (await admin(db => db.one<{ name: string }>('select name from agencies where id = $1', [NW.org])))!.name
  })
  afterEach(async () => {
    delete process.env.AGENT_MAIL_DOMAIN
    await admin(db => db.query('update agencies set name = $2 where id = $1', [NW.org, original]))
    await resetDiscovery(NW)
    await resetCx(NW)
  })

  it('one path: business, agreements (gate off), products, connect, discovery and done; persisted and resumable', async () => {
    const actor = await merchantActor(NW)
    let v = await wizardView(actor)
    expect(v.steps.map(s => s.key)).toEqual(['business', 'agreements', 'products', 'connect', 'discover', 'done'])
    expect(v.current).toBe('business')
    // LEGAL_GATE is off here: the agreements step is not needed
    expect(v.steps.find(s => s.key === 'agreements')!.state).toBe('skipped')
    await expect(saveBusiness(actor, { name: original, timezone: 'Nowhere/Here' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(saveBusiness(actor, { name: '', timezone: 'UTC' })).rejects.toMatchObject({ code: 'invalid_input' })
    await saveBusiness(actor, { name: original, timezone: 'America/Chicago' })
    v = await wizardView(actor)
    expect(v.current).toBe('products')
    expect(v.business).toMatchObject({ name: original, timezone: 'America/Chicago', saved: true })

    await expect(chooseProducts(actor, { commerce: false, office: false })).rejects.toMatchObject({ code: 'invalid_input' })
    await chooseProducts(actor, { commerce: true, office: true, platform: 'shopify' })
    expect(await admin(db => enabledProducts(db, NW.org))).toEqual(['commerce', 'office'])
    v = await wizardView(actor)
    // the synthetic Shopify store is already connected, so connect is done and discovery is next
    expect(v.steps.find(s => s.key === 'connect')!.state).toBe('done')
    expect(v.current).toBe('discover')
    expect(v.discovery).toMatchObject({ ran: false, activeAgents: 0 })

    await discoverNow(actor)
    v = await wizardView(actor)
    expect(v.discovery.ran).toBe(true)
    expect(v.discovery.recommended).toBeGreaterThan(0)
    expect(v.current).toBe('discover') // found work, but nothing is set up or granted automatically
    await setUpTeam(actor)
    expect((await wizardView(actor)).current).toBe('discover')
    await expect(completeWizard(actor)).rejects.toMatchObject({ code: 'needs_setup' })
    const shown = (await discoverView(actor)).team.filter(t => t.agent?.pending?.draftsOnly)
    expect(shown.length).toBeGreaterThan(0)
    const g = await grantShownTeam(actor, shown.map(t => ({ agentId: t.agent!.agentId, policyId: t.agent!.pending!.policyId, policyHash: t.agent!.pending!.policyHash })))
    expect(g.filter(x => x.ok)).toHaveLength(shown.length)
    v = await wizardView(actor)
    expect(v.discovery.activeAgents).toBe(shown.length)
    expect(v.current).toBe('done')
    expect(await completeWizard(actor)).toMatchObject({ completed: true })
    v = await wizardView(actor)
    expect(v.completedAt).toBeTruthy()
    expect(v.steps.every(s => s.state === 'done' || s.state === 'skipped')).toBe(true)
    // granted agents are still drafts only: the grant did not widen anything
    expect((await agentsOf(NW.org)).filter(a => a.policy_status === 'active').every(a => a.approval_mode === 'draft')).toBe(true)
  })

  it('with LEGAL_GATE on, a new organization\'s setup waits on the agreements step for the real acceptances', async () => {
    process.env.LEGAL_GATE = 'draft'
    // a throwaway organization: acceptances are append-only and leave only with their organization
    const email = `legal.${Date.now()}@new-business.example`
    const uid = (await admin(db => db.one<{ id: string }>(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email])))!.id
    const session = { uid, email, role: 'client' as const, agencyId: null }
    const { orgId } = await createOwnOrganization(session, { name: 'Gate Test Co', timezone: 'UTC' })
    try {
      const actor = { kind: 'profile' as const, session: { ...session, agencyId: orgId, orgType: 'merchant' }, orgId, label: `user:${email}` }
      let v = await wizardView(actor)
      expect(v.steps.find(s => s.key === 'business')!.state).toBe('done')
      expect(v.current).toBe('agreements')
      expect(v.legal.missing.length).toBeGreaterThan(0)
      const docs = requiredAgreements('commerce')
      await admin(db => recordAcceptance(db, { orgId, userId: uid, product: 'commerce', documents: docs.map(d => ({ key: d.key, version: d.version, sha256: d.sha256 })) }, 'draft'))
      v = await wizardView(actor)
      expect(v.legal.missing).toEqual([])
      expect(v.steps.find(s => s.key === 'agreements')!.state).toBe('done')
      expect(v.current).toBe('products')
    } finally {
      delete process.env.LEGAL_GATE
      await admin(async db => { await db.query('delete from agencies where id = $1', [orgId]); await db.query('delete from auth.users where id = $1', [uid]) })
    }
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

  it('without agent mailboxes the agents have no email permission at all; discovery can be skipped for now', async () => {
    const actor = await merchantActor(NW)
    await chooseProducts(actor, { commerce: true, office: false })
    await autoSetupAgents(actor)
    expect((await agentsOf(NW.org)).every(r => r.email_permission === null && r.approval_mode === 'draft')).toBe(true)
    await skipAgents(actor)
    await skipDiscovery(actor)
    expect((await wizardView(actor)).steps.find(s => s.key === 'discover')!.state).toBe('skipped')
  })

  it('Office only: connecting an Office tool completes the connect step; Commerce is switched off', async () => {
    const actor = await merchantActor(NW)
    await chooseProducts(actor, { commerce: false, office: true })
    expect(await admin(db => enabledProducts(db, NW.org))).toEqual(['office'])
    let v = await wizardView(actor)
    expect(v.agents).toEqual([])
    expect(v.steps.find(s => s.key === 'connect')!.state).not.toBe('done')
    await connectSyntheticOffice(actor, 'hubspot', { demoData: false })
    v = await wizardView(actor)
    expect(v.office.connected).toEqual(['hubspot'])
    expect(v.steps.find(s => s.key === 'connect')!.state).toBe('done')
    expect(await autoSetupAgents(actor)).toEqual({ created: [], existing: [], failed: [] })
    await resetOffice(NW)
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
