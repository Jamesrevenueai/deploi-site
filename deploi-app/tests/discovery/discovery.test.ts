/**
 * Business discovery: detectors run only when what they read is connected; the profile is built only from
 * connected sources, every fact with its source and time; findings become `detected` cases, deduplicated on
 * a re-run; failures and unreadable sources are recorded (the run is then partial); recommendations are
 * aggregated into one team; one-click setup is idempotent and drafts only; grant-all grants only matching
 * hashes; organizations are isolated; staff are refused; the durable job is queued once per hour.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { admin, withUser } from '../../lib/db'
import { prepareDb, SESSIONS } from '../db/helpers'
import { listDetectors, registerDetector, unregisterDetector, type Detector } from '../../lib/discovery/registry'
import { runDiscovery, discoverView, discoverNow, setUpTeam, grantShownTeam, aggregateRecommendations, requestDiscovery } from '../../lib/discovery'
import { discoveryKey } from '../../lib/discovery/jobs'
import { isDraftsOnly } from '../../lib/discovery/team'
import { lowStock, stockItem } from '../../lib/discovery/store'
import { runDueJobs } from '../../lib/jobs'
import { getCase, runCaseCheck } from '../../lib/cases'
import { mutateSynthetic, injectFault } from '../../lib/connectors/shopify/synthetic'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { injectOfficeFault, mutateOfficeSynth, synthContact } from '../../lib/office/synthetic'
import { NW, HB, merchantActor, staffActor, resetDiscovery, casesOf, agentsOf } from './helpers'

const ready = await prepareDb()

describe('recommendation aggregation (pure)', () => {
  it('one entry per template, ordered by findings, reasons and needs merged, unknown templates set up by hand', () => {
    const team = aggregateRecommendations([
      { rec: { template: 'store_health_checker', suite: 'commerce', name: 'Store Health Checker', reason: 'weekly', needs: [] }, findings: 0, detector: 'store-health' },
      { rec: { template: 'inventory_watcher', suite: 'commerce', name: 'Inventory Watcher', reason: '3 oversold', needs: [] }, findings: 3, detector: 'store-issues' },
      { rec: { template: 'inventory_watcher', suite: 'commerce', name: 'Inventory Watcher', reason: '5 low', needs: ['x'] }, findings: 5, detector: 'inventory-low' },
      { rec: { template: 'receivables_chaser', suite: 'office', name: 'Receivables', reason: '2 overdue invoices', needs: ['a QuickBooks connection'] }, findings: 2, detector: 'office-receivables' },
    ])
    expect(team.map(t => t.template)).toEqual(['inventory_watcher', 'receivables_chaser', 'store_health_checker'])
    expect(team[0]).toMatchObject({ findings: 8, reason: '5 low', reasons: ['5 low', '3 oversold'], needs: ['x'], detectors: ['inventory-low', 'store-issues'], setup: 'automatic' })
    expect(team[0].approval).toMatch(/Drafts only/)
    expect(team[0].monitors).toBeTruthy()
    expect(team[0].schedule).toBeTruthy()
    expect(team[0].limits.length).toBeGreaterThan(0)
    expect(team[1]).toMatchObject({ setup: 'manual', needs: ['a QuickBooks connection'], monitors: null })
  })

  it('drafts only means every tool at drafts', () => {
    expect(isDraftsOnly('engine', { approvalMode: 'draft' })).toBe(true)
    expect(isDraftsOnly('engine', { approvalMode: 'draft', email: { permission: 'send_approved' } })).toBe(false)
    expect(isDraftsOnly('engine', { approvalMode: 'review' })).toBe(false)
    expect(isDraftsOnly('office', { email: { tier: 'draft' }, crm: { tier: 'draft' } })).toBe(true)
    expect(isDraftsOnly('office', { email: { tier: 'draft' }, calendar: { tier: 'send_autonomous' } })).toBe(false)
  })

  it('low stock leaves out untracked, unpublished, pre-order and oversold items', () => {
    const base = { resourceType: 'variant', fetchedAt: new Date().toISOString(), productTitle: 'P', variantTitle: 'Default Title', productStatus: 'ACTIVE', tracked: true, productTags: [] as string[] }
    const items = [
      { ...base, resourceId: 'a', totalAvailable: 0 }, { ...base, resourceId: 'b', totalAvailable: 2 }, { ...base, resourceId: 'c', totalAvailable: 3 },
      { ...base, resourceId: 'd', totalAvailable: -1 }, { ...base, resourceId: 'e', totalAvailable: 1, tracked: false }, { ...base, resourceId: 'f', totalAvailable: 1, productStatus: 'DRAFT' },
      { ...base, resourceId: 'g', totalAvailable: 1, productTags: ['Pre-Order'] }, { resourceType: 'woo_stock_object', resourceId: 'h', fetchedAt: base.fetchedAt, name: 'W', status: 'publish', manageStock: true, stockQuantity: 1, tags: [] },
    ].map(stockItem).filter(x => x !== null)
    expect(lowStock(items).map(i => i.resourceId)).toEqual(['a', 'b', 'h'])
  })
})

describe.skipIf(!ready)('business discovery', () => {
  beforeEach(async () => { await resetDiscovery(NW); await resetDiscovery(HB) })
  afterAll(async () => { await resetDiscovery(NW); await resetDiscovery(HB) })

  it('registers the built-in detectors; each runs only when what it reads is connected', async () => {
    expect(listDetectors().map(d => d.key)).toEqual(expect.arrayContaining(['store-issues', 'inventory-low', 'store-health']))
    for (const d of listDetectors().filter(x => ['store-issues', 'inventory-low', 'store-health'].includes(x.key))) expect(await admin(db => d.available(db, NW.org)), d.key).toBe(true)
    // an organization with nothing connected: nothing is read, nothing is found, nothing is invented
    const org = (await admin(db => db.one<{ id: string }>(`insert into agencies (name, state, timezone, org_type) values ('Empty test org', '', 'UTC', 'merchant') returning id`)))!.id
    try {
      for (const d of listDetectors().filter(x => ['store-issues', 'inventory-low', 'store-health'].includes(x.key))) expect(await admin(db => d.available(db, org))).toBe(false)
      const { run } = await runDiscovery(org, { trigger: 'test' })
      expect(run.status).toBe('completed')
      expect(run.detectors.filter(d => ['store-issues', 'inventory-low', 'store-health'].includes(d.key)).every(d => d.status === 'not_available')).toBe(true)
      expect(run).toMatchObject({ findings_count: 0, cases_opened: 0, recommendations: [], sources: [] })
      const p = (await admin(db => db.one<{ profile: { platforms: unknown[]; facts: unknown[] } }>('select profile from business_profiles where org_id = $1', [org])))!.profile
      expect(p.platforms).toEqual([])
      expect(p.facts).toEqual([])
      expect(await casesOf(org)).toEqual([])
    } finally { await admin(db => db.query('delete from agencies where id = $1', [org])) }
  })

  it('builds the profile only from connected sources, each fact with its source and time', async () => {
    const { run } = await runDiscovery(NW.org, { trigger: 'test' })
    const p = (await discoverView(await merchantActor(NW))).profile!
    expect(p.runId).toBe(run.id)
    expect(p.platforms.map(x => x.app)).toEqual(['shopify'])
    for (const f of p.facts) {
      expect(f.source, f.key).toBeTruthy()
      expect(Number.isNaN(Date.parse(f.observedAt)), f.key).toBe(false)
    }
    const fact = (k: string) => p.facts.find(f => f.key.endsWith(k))
    expect(fact('.items')).toMatchObject({ value: 19, source: 'shopify' })
    expect(fact('.products')).toMatchObject({ value: 15, source: 'shopify' })
    expect(fact('.oversold')!.value).toBe(1)
    expect(fact('.low_stock')!.value).toBe(4)
    // nothing about a CRM or mailbox Deploi was not given, and orders are said to be unread, not guessed
    expect(p.facts.some(f => f.key.startsWith('crm.') || f.key.startsWith('mail.'))).toBe(false)
    expect(p.notRead.map(n => n.reason)).toContain('Orders not read: Deploi reads products and inventory, not orders')
    expect(run.sources).toEqual([expect.objectContaining({ app: 'shopify', status: 'read' })])

    // HubSpot connected: leads are counted (never named), with HubSpot as the source
    await resetDiscovery(NW, { office: true })
    const hub = await connectSyntheticOffice(await merchantActor(NW), 'hubspot', { demoData: false })
    const recent = new Date(Date.now() - 864e5).toISOString(), old = new Date(Date.now() - 90 * 864e5).toISOString()
    await mutateOfficeSynth(hub.id, s => { s.contacts = [synthContact('1', 'a@lead.example', { updatedAt: recent }), synthContact('2', 'b@lead.example', { updatedAt: recent }), synthContact('3', 'c@lead.example', { updatedAt: old })] })
    await runDiscovery(NW.org, { trigger: 'test' })
    const p2 = (await discoverView(await merchantActor(NW))).profile!
    expect(p2.platforms.map(x => x.app).sort()).toEqual(['hubspot', 'shopify'])
    expect(p2.facts.find(f => f.key === 'crm.leads_30d')).toMatchObject({ value: 2, source: 'hubspot' })
    expect(JSON.stringify(p2)).not.toMatch(/lead\.example/)
  })

  it('turns findings into detected cases and deduplicates them on a re-run', async () => {
    const first = (await runDiscovery(NW.org, { trigger: 'test' })).run
    const cases = await casesOf(NW.org)
    expect(first.cases_opened).toBe(cases.length)
    expect(cases.length).toBe(10)
    expect(cases.every(c => c.status === 'detected')).toBe(true)
    expect(new Set(cases.map(c => c.kind))).toEqual(new Set(['shopify_oversell_policy', 'shopify_oversold_stop_selling', 'inventory_low']))
    // kinds with a checker are looked at again later
    expect(cases.every(c => c.next_check_at !== null)).toBe(true)
    const second = (await runDiscovery(NW.org, { trigger: 'test' })).run
    expect(second.cases_opened).toBe(0)
    expect(second.detectors.reduce((n, d) => n + d.casesExisting, 0)).toBe(10)
    expect(await casesOf(NW.org)).toHaveLength(10)
    expect([...second.case_ids].sort()).toEqual(cases.map(c => c.id).sort())
    const h = (await admin(db => getCase(db, NW.org, cases[0].id)))!
    expect(h.events.map(e => e.type)).toEqual(['opened', 'redetected'])
    // one scan per store per run, shared by the store detectors
    expect((await admin(db => db.one<{ n: number }>(`select count(*)::int as n from scans where connection_id = $1`, [NW.conn])))!.n).toBe(2)
  })

  it('a low-stock case resolves once a fresh read shows the item restocked', async () => {
    await runDiscovery(NW.org, { trigger: 'test' })
    const low = (await casesOf(NW.org)).find(c => c.kind === 'inventory_low' && c.dedupe_key.endsWith('/2012'))!
    expect(low).toBeTruthy()
    await runCaseCheck(low.id, new Date(Date.now() + 2 * 864e5))
    expect((await admin(db => getCase(db, NW.org, low.id)))!.case.status).toBe('detected')
    await mutateSynthetic(NW.conn, s => { for (const p of s.products) for (const v of p.variants) if (v.id.endsWith("/2012")) v.levels[0].available = 30 })
    await runCaseCheck(low.id, new Date(Date.now() + 4 * 864e5))
    const c = (await admin(db => getCase(db, NW.org, low.id)))!.case
    expect(c.status).toBe('resolved')
    expect(c.outcome!.evidence[0].label).toMatch(/available/)
  })

  it('records partial results honestly: a reauth-needing source, a failing and a slow detector', async () => {
    await resetDiscovery(NW, { office: true })
    const hub = await connectSyntheticOffice(await merchantActor(NW), 'hubspot', { demoData: false })
    await admin(db => db.query(`update office_connections set status = 'needs_reauth' where id = $1`, [hub.id]))
    const broken: Detector = { key: 'test-broken', suite: 'office', sourceApp: 'hubspot', available: async () => true, detect: async () => { throw new Error('the API answered 500') } }
    const slow: Detector = { key: 'test-slow', suite: 'office', sourceApp: 'hubspot', available: async () => true, detect: () => new Promise(r => setTimeout(() => r({ findings: [], recommendation: null, sourcesRead: [] }), 2000)) }
    registerDetector(broken); registerDetector(slow)
    try {
      const { run } = await runDiscovery(NW.org, { trigger: 'test', detectorTimeoutMs: 300 })
      expect(run.status).toBe('partial')
      const by = Object.fromEntries(run.detectors.map(d => [d.key, d]))
      expect(by['test-broken']).toMatchObject({ status: 'failed', notes: ['failed: the API answered 500'] })
      expect(by['test-slow'].status).toBe('timeout')
      expect(by['store-issues'].status).toBe('ok')
      expect(run.sources).toContainEqual(expect.objectContaining({ app: 'hubspot', status: 'not_read', reason: 'needs reauth' }))
      expect(run.status_reason).toMatch(/HubSpot not read: needs reauth/)
      const p = (await discoverView(await merchantActor(NW))).profile!
      expect(p.notRead.map(n => n.reason)).toContain('HubSpot not read: needs reauth')
      expect(run.cases_opened).toBe(10) // what could be read is still recorded
    } finally { unregisterDetector('test-broken'); unregisterDetector('test-slow') }

    // HubSpot answers 401 while reading: recorded as needs reauth; a store that cannot be read is recorded too.
    // Two readers ask HubSpot for leads (the CRM follow-up detector and the profile), so the fault lasts for both.
    await admin(db => db.query(`update office_connections set status = 'active' where id = $1`, [hub.id]))
    await injectOfficeFault(hub.id, { op: 'searchLeads', mode: 'auth', remaining: 5 })
    await injectFault(NW.conn, { op: 'DeploiVariants', mode: 'read_error', remaining: 50 })
    const { run } = await runDiscovery(NW.org, { trigger: 'test' })
    expect(run.status).toBe('partial')
    expect(run.sources).toContainEqual(expect.objectContaining({ app: 'hubspot', status: 'failed', reason: 'needs reauth' }))
    expect(run.sources).toContainEqual(expect.objectContaining({ app: 'shopify', status: 'failed' }))
    expect(run.detectors.find(d => d.key === 'store-issues')!.notes[0]).toMatch(/not read/)
    await mutateSynthetic(NW.conn, s => { s.faults = [] })
  })

  it('recommends a team from the findings, strongest first, with what is still needed', async () => {
    await runDiscovery(NW.org, { trigger: 'test' })
    const v = await discoverView(await merchantActor(NW))
    expect(v.team.map(t => t.template)).toEqual(['inventory_watcher', 'supplier_chaser', 'store_health_checker'])
    expect(v.team[0]).toMatchObject({ findings: 10, setup: 'automatic', agent: null })
    expect(v.team[1].needs).toEqual(["your supplier's email address"])
    expect(v.findings).toMatchObject({ total: 10, open: 10 })
    expect(v.findings.byKind[0]).toEqual({ kind: 'shopify_oversell_policy', count: 5 })
  })

  it('one-click setup creates the team at drafts only, once; a needed input blocks only its own agent', async () => {
    await runDiscovery(NW.org, { trigger: 'test' })
    const owner = await merchantActor(NW)
    const [a, b] = await Promise.all([setUpTeam(owner), setUpTeam(owner)])
    const created = [...a, ...b].filter(i => i.status === 'created').map(i => i.template).sort()
    expect(created).toEqual(['inventory_watcher', 'store_health_checker'])
    const supplier = a.find(i => i.template === 'supplier_chaser')!
    expect(supplier).toMatchObject({ status: 'blocked', needs: ["your supplier's email address"], agent: null })
    let agents = await agentsOf(NW.org)
    expect(agents.map(x => x.name).sort()).toEqual(['Inventory Watcher', 'Store Health Checker'])
    for (const x of agents) {
      expect(x.status).toBe('draft')
      expect(x.approval_mode).toBe('draft')
      expect(x.email_permission === null || x.email_permission === 'draft').toBe(true)
    }
    for (const i of a.filter(x => x.status === 'created')) {
      expect(i.agent!.pending).toMatchObject({ draftsOnly: true, version: 1 })
      expect(i.agent!.pending!.policyHash).toMatch(/^[0-9a-f]{64}$/)
      expect(i.agent!.pending!.summary.grants.length).toBeGreaterThan(0)
    }
    const again = await setUpTeam(owner)
    expect(again.filter(i => i.status === 'created')).toEqual([])
    expect(again.filter(i => i.status === 'existing').map(i => i.template).sort()).toEqual(['inventory_watcher', 'store_health_checker'])
    agents = await agentsOf(NW.org)
    expect(agents).toHaveLength(2)
  })

  it('links an agent the setup wizard already created instead of creating a second one', async () => {
    const { autoSetupAgents, chooseProducts } = await import('../../lib/library/onboarding')
    const owner = await merchantActor(NW)
    await chooseProducts(owner, { commerce: true, office: false, platform: 'shopify' })
    await autoSetupAgents(owner)
    expect(await agentsOf(NW.org)).toHaveLength(2)
    await runDiscovery(NW.org, { trigger: 'test' })
    const r = await setUpTeam(owner)
    expect(r.filter(i => i.status === 'existing')).toHaveLength(2)
    expect(await agentsOf(NW.org)).toHaveLength(2)
  })

  it('grant all shown grants each agent only when its hash matches the pending version', async () => {
    await runDiscovery(NW.org, { trigger: 'test' })
    const owner = await merchantActor(NW)
    const items = (await setUpTeam(owner)).filter(i => i.agent?.pending)
    const [iw, sh] = [items.find(i => i.template === 'inventory_watcher')!, items.find(i => i.template === 'store_health_checker')!]
    const results = await grantShownTeam(owner, [
      { agentId: iw.agent!.agentId, policyId: iw.agent!.pending!.policyId, policyHash: iw.agent!.pending!.policyHash },
      { agentId: sh.agent!.agentId, policyId: sh.agent!.pending!.policyId, policyHash: '0'.repeat(64) },
      { agentId: '00000000-0000-4000-8000-000000000001', policyHash: 'x' },
    ])
    expect(results.map(r => [r.ok, r.code ?? null])).toEqual([[true, null], [false, 'hash_mismatch'], [false, 'not_found']])
    const agents = await agentsOf(NW.org)
    expect(agents.find(a => a.name === 'Inventory Watcher')!.status).toBe('active')
    expect(agents.find(a => a.name === 'Store Health Checker')!.status).toBe('draft')
    // a version wider than drafts is never granted from here, even with the right hash
    await admin(db => db.query(`update agent_policies set policy = jsonb_set(policy, '{approvalMode}', '"review"') where agent_id = $1 and status = 'pending_grant'`, [sh.agent!.agentId]))
    const wide = await grantShownTeam(owner, [{ agentId: sh.agent!.agentId, policyHash: sh.agent!.pending!.policyHash }])
    expect(wide[0]).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await grantShownTeam(owner, [{ agentId: iw.agent!.agentId, policyHash: iw.agent!.pending!.policyHash }])).toEqual([expect.objectContaining({ ok: false, code: 'not_pending' })])
  })

  it('keeps organizations apart', async () => {
    await runDiscovery(NW.org, { trigger: 'test' })
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const items = await setUpTeam(nw)
    const hv = await discoverView(hb)
    expect(hv.run).toBeNull()
    expect(hv.findings.total).toBe(0)
    expect(hv.team).toEqual([])
    await expect(setUpTeam(hb)).rejects.toMatchObject({ code: 'invalid_input' }) // Harbor has no run of its own
    const iw = items.find(i => i.template === 'inventory_watcher')!
    expect((await grantShownTeam(hb, [{ agentId: iw.agent!.agentId, policyHash: iw.agent!.pending!.policyHash }]))[0]).toMatchObject({ ok: false, code: 'not_found' })
    expect((await agentsOf(NW.org)).find(a => a.name === 'Inventory Watcher')!.status).toBe('draft')
    const seen = await withUser(SESSIONS.harbor, async db => ({
      runs: await db.query('select id from discovery_runs where org_id = $1', [NW.org]),
      profiles: await db.query('select org_id from business_profiles where org_id = $1', [NW.org]),
      links: await db.query('select template from discovery_agents where org_id = $1', [NW.org]),
    }))
    expect(seen).toEqual({ runs: [], profiles: [], links: [] })
    expect((await withUser(SESSIONS.northwind, db => db.query('select id from discovery_runs where org_id = $1', [NW.org]))).length).toBe(1)
    await expect(withUser(SESSIONS.northwind, db => db.query(`update discovery_runs set status = 'failed' where org_id = $1`, [NW.org]))).rejects.toThrow(/permission denied/)
  })

  it('refuses staff', async () => {
    const staff = await staffActor()
    await expect(discoverView(staff)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(discoverNow(staff)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setUpTeam(staff)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(grantShownTeam(staff, [{ agentId: '00000000-0000-4000-8000-000000000001', policyHash: 'x' }])).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a connection queues one discovery job per organization, connection and hour; the job runs discovery', async () => {
    const at = new Date('2026-11-05T10:15:00Z')
    expect(discoveryKey('shopify:c1', at)).toBe('shopify:c1@2026-11-05T10:00:00.000Z')
    const a = await requestDiscovery(NW.org, `shopify:${NW.conn}`)
    const b = await requestDiscovery(NW.org, `shopify:${NW.conn}`)
    expect(a).toMatchObject({ created: true })
    expect(b).toMatchObject({ created: false, id: a!.id })
    expect(await requestDiscovery('not-an-org', 'x')).toBeNull()
    const ran = await runDueJobs({ kinds: ['discovery.run'] })
    const mine = ran.ran.find(r => r.jobId === a!.id)!
    expect(mine).toMatchObject({ status: 'succeeded' })
    expect(mine.result).toMatchObject({ started: true, casesOpened: 10 })
    const run = (await admin(db => db.one<{ trigger: string; source: string }>('select trigger, source from discovery_runs where org_id = $1', [NW.org])))!
    expect(run).toEqual({ trigger: 'connection', source: `shopify:${NW.conn}` })
  })

  it('one run at a time per organization', async () => {
    const [x, y] = await Promise.all([runDiscovery(NW.org, { trigger: 'test' }), runDiscovery(NW.org, { trigger: 'test' })])
    expect([x.started, y.started].sort()).toEqual([false, true])
    expect(await casesOf(NW.org)).toHaveLength(10)
  })
})
