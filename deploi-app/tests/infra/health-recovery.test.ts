/**
 * Monitoring and crash recovery:
 *  - /api/health reports database reachability, queue depth, oldest due job age, dead jobs and the last
 *    cron runs, and never an organization, agent, address or payload;
 *  - an approved store write interrupted before it was written resumes through every gate exactly once;
 *    one interrupted during the write is never repeated blindly (it becomes "unknown").
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { GET as health } from '../../app/api/health/route'
import { enqueue, recordHeartbeat } from '../../lib/jobs'
import { runAgent } from '../../lib/agents/run'
import { approveProposal } from '../../lib/engine/approve'
import { queueExecution } from '../../lib/engine/execute'
import { recoverInterruptedExecutions } from '../../lib/engine/recover'
import type { ProposalRow } from '../../lib/engine/proposals'
import { merchantActor, resetMerchant } from '../merchant/helpers'
import { NW, grantedAgent, cleanInfra } from './helpers'

const ready = await prepareDb()
beforeEach(async () => { if (ready) { await cleanInfra(); await resetMerchant(NW) } })
afterAll(async () => { if (ready) { await cleanInfra(); await admin(db => db.query(`delete from cron_heartbeats where job_key = 'test.health'`)) } })

describe.skipIf(!ready)('health endpoint', () => {
  it('reports the database, the queue and the crons without tenant data', async () => {
    await enqueue({ kind: 'test.health', orgId: NW.org, payload: { secret: 'owner@northwind-goods.example' }, runAfter: new Date(Date.now() - 90_000) })
    await admin(db => db.query(`insert into jobs (kind, org_id, status, attempts, last_error, finished_at) values ('test.health', $1, 'dead', 5, 'boom', now())`, [NW.org]))
    await recordHeartbeat('test.health', 'ok', { ran: 1 })
    const res = await health()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ ok: true, db: { reachable: true }, queue: { depth: expect.any(Number), due: expect.any(Number), dead: expect.any(Number), oldestDueAgeSec: expect.any(Number) } })
    expect(j.queue.depth).toBeGreaterThanOrEqual(1)
    expect(j.queue.dead).toBeGreaterThanOrEqual(1)
    expect(j.queue.oldestDueAgeSec).toBeGreaterThanOrEqual(85)
    expect(j.crons['test.health']).toMatchObject({ status: 'ok', lastRunAt: expect.any(String) })
    const text = JSON.stringify(j)
    for (const leak of [NW.org, 'northwind', 'boom', 'secret']) expect(text).not.toContain(leak)
  })
})

describe.skipIf(!ready)('interrupted store writes', () => {
  let agentId: string | null = null
  async function approvedProposal() {
    const actor = await merchantActor(NW)
    if (!agentId || !(await admin(db => db.one('select 1 from agents where id = $1', [agentId])))) {
      agentId = await grantedAgent(actor, NW, 'Recover')
      await runAgent(agentId, { trigger: 'test', actor: actor.label })
    }
    const id = agentId
    const p = (await admin(db => db.one<ProposalRow>(`select * from proposals where agent_id = $1 and status = 'pending_approval' order by created_at limit 1`, [id])))!
    const a = await approveProposal(actor, p.id, p.change_hash)
    const execId = await admin(db => queueExecution(db, p, a.approvalId))
    return { p, execId }
  }
  const writes = async () => Number((await admin(db => db.one<{ n: string }>(`select count(*)::text as n from executions where connection_id = $1 and status = 'verified'`, [NW.conn])))!.n)

  it('a queued or prechecking write left by a crashed worker resumes once, through every gate', async () => {
    const { execId } = await approvedProposal()
    await admin(db => db.query(`update executions set status = 'prechecking', started_at = now() - interval '20 minutes' where id = $1`, [execId]))
    const before = await writes()
    const r = await recoverInterruptedExecutions()
    expect(r.resumed.map(x => x.status)).toEqual(['verified'])
    expect(await writes()).toBe(before + 1)
    // running it again finds nothing to do
    expect((await recoverInterruptedExecutions()).resumed).toEqual([])
    expect(await writes()).toBe(before + 1)
  })

  it('a write interrupted mid-flight is marked unknown, never repeated', async () => {
    const { execId } = await approvedProposal()
    await admin(db => db.query(`update executions set status = 'executing', started_at = now() - interval '20 minutes' where id = $1`, [execId]))
    const r = await recoverInterruptedExecutions()
    expect(r).toMatchObject({ resumed: [], markedUnknown: 1 })
    expect(await admin(db => db.one('select status from executions where id = $1', [execId]))).toEqual({ status: 'unknown' })
    // recent work is left alone
    const fresh = await approvedProposal()
    await admin(db => db.query(`update executions set status = 'executing' where id = $1`, [fresh.execId]))
    expect((await recoverInterruptedExecutions()).markedUnknown).toBe(0)
  })
})
