/** Discovery + QuickBooks: connecting QuickBooks surfaces overdue invoices as cases and sets up the AR agent at drafts only. */
import '../merchant/env'
import { describe, it, expect, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { runDiscovery, setUpTeam } from '../../lib/discovery'
import { NW, HB, t0 } from '../office/helpers'
import { setupReceivables, resetReceivables, inv, day } from '../office/receivables-helpers'

const ready = await prepareDb()
afterAll(async () => { if (ready) { await resetReceivables(NW, { enable: false }); await resetReceivables(HB, { enable: false }); await admin(db => db.query(`delete from cases where org_id = $1 and kind = 'invoice_overdue'`, [NW.org])) } })

describe.skipIf(!ready)('discovery with QuickBooks connected', () => {
  it('finds the overdue invoice, opens one case, recommends Accounts Receivable and creates it at drafts only', async () => {
    const T = t0()
    const s = await setupReceivables(NW, [inv('2001', day(T, -21), 480), inv('2002', day(T, 30), 90)])
    const { run } = await runDiscovery(NW.org, { trigger: 'test' })
    expect(run.sources.map((x: { app?: string; sourceApp?: string } | string) => typeof x === 'string' ? x : (x.app ?? x.sourceApp))).toContain('quickbooks')
    const rec = (run.recommendations as { template: string }[]).find(r => r.template === 'accounts_receivable')
    expect(rec).toBeTruthy()
    const cases = await admin(db => db.query<{ kind: string; status: string; source_app: string }>(`select kind, status, source_app from cases where org_id = $1 and kind = 'invoice_overdue'`, [NW.org]))
    expect(cases).toEqual([{ kind: 'invoice_overdue', status: 'detected', source_app: 'quickbooks' }])
    // a second run does not open a second case for the same invoice
    await runDiscovery(NW.org, { trigger: 'test' })
    expect(await admin(db => db.query(`select id from cases where org_id = $1 and kind = 'invoice_overdue'`, [NW.org]))).toHaveLength(1)

    const items = await setUpTeam(s.actor, { only: ['accounts_receivable'] })
    const ar = items.find(i => i.template === 'accounts_receivable')!
    expect(ar.status).toBe('created')
    const agent = (await admin(db => db.one<{ kind: string; status: string; tier: string }>(
      `select g.kind, g.status, p.policy->'email'->>'tier' as tier from office_agents g join office_agent_policies p on p.agent_id = g.id where g.id = $1 order by p.version desc limit 1`, [ar.agent!.agentId])))!
    expect(agent).toMatchObject({ kind: 'accounts_receivable', tier: 'draft' })
    expect(agent.status).not.toBe('active') // nothing runs until the owner grants it
    expect(ar.agent!.pending?.draftsOnly).toBe(true)
    expect((await setUpTeam(s.actor, { only: ['accounts_receivable'] })).find(i => i.template === 'accounts_receivable')!.status).toBe('existing')
  })
})
