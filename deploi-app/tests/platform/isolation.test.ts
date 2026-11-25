/**
 * The platform tables are inside the catalog-driven isolation sweep (tests/security/tenant-isolation.test.ts):
 * each org-scoped one has an org read policy, and plans / plan_changes are staff-only. A merchant session reads
 * none of another organization's usage, budgets, costs or deletion requests.
 */
import { describe, it, expect } from 'vitest'
import { prepareDb, SESSIONS, ORG_HB } from '../db/helpers'
import { withOwner, publicTables, orgColumn } from '../security/pg'
import { admin, withUser } from '../../lib/db'

const ready = await prepareDb()
const ORG_SCOPED = ['ai_usage', 'ai_budget_overrides', 'workflow_costs', 'org_deletion_requests']

describe.skipIf(!ready)('platform tables: tenant isolation', () => {
  it('every new org-scoped table is covered by the sweep; plans are staff-only', async () => {
    const t = await withOwner(c => publicTables(c))
    for (const name of ORG_SCOPED) expect(orgColumn(t.find(x => x.table === name)!), name).toBe('org_id')
    for (const name of ['plans', 'plan_changes']) {
      const p = t.find(x => x.table === name)!
      expect(p.rls).toBe(true)
      expect(p.policies.map(x => x.qual)).toEqual(['is_staff()'])
    }
  })

  it("a merchant reads only its own rows and no plan internals", async () => {
    await admin(async db => {
      await db.query(`insert into ai_usage (org_id, agent_ref, purpose, tier, model, outcome) values ($1, 'engine:iso', 'iso.test', 'routine', 'm', 'ok')`, [ORG_HB])
      await db.query(`insert into workflow_costs (org_id, month, metric, count) values ($1, '2026-11-01', 'job_run', 1) on conflict do nothing`, [ORG_HB])
    })
    const nw = await withUser(SESSIONS.northwind, db => db.query(`select org_id from ai_usage where purpose = 'iso.test' union all select org_id from workflow_costs where org_id = $1`, [ORG_HB]))
    const hb = await withUser(SESSIONS.harbor, db => db.query(`select org_id from ai_usage where purpose = 'iso.test'`))
    const plans = await withUser(SESSIONS.northwind, db => db.query('select key from plans'))
    expect(nw).toEqual([])
    expect(hb.length).toBeGreaterThan(0)
    expect(plans).toEqual([])
    await admin(async db => { await db.query(`delete from ai_usage where purpose = 'iso.test'`); await db.query(`delete from workflow_costs where org_id = $1 and month = '2026-11-01' and metric = 'job_run'`, [ORG_HB]) })
  })
})
