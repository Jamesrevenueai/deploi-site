/**
 * The office scheduler (/api/cron/office). Each call: reconcile uncertain outcomes; then, for a bounded
 * number of organizations with Office enabled and an active office agent, take that organization's
 * lease (so overlapping calls never process one organization twice at once), run its due agents
 * (lead polling, follow-ups, reply checks, inbound mail, CRM logging) and carry out due queued actions.
 */
import { randomUUID } from 'node:crypto'
import { admin } from '../db'
import { log } from '../log'
import { officeConfig } from './config'
import { reconcileOfficeActions } from './actions'
import { executeDue, runOfficeAgent } from './run'

export async function acquireOrgLock(orgId: string, holder: string, now = new Date()): Promise<boolean> {
  const r = await admin(db => db.one(`insert into office_org_locks (org_id, locked_until, locked_by) values ($1, $2, $3)
    on conflict (org_id) do update set locked_until = excluded.locked_until, locked_by = excluded.locked_by where office_org_locks.locked_until < $4 returning org_id`,
    [orgId, new Date(now.getTime() + officeConfig.lockLeaseMs).toISOString(), holder, now.toISOString()]))
  return Boolean(r)
}
export async function releaseOrgLock(orgId: string, holder: string) {
  await admin(db => db.query(`update office_org_locks set locked_until = 'epoch', last_run_at = now() where org_id = $1 and locked_by = $2`, [orgId, holder]))
}

export async function runOfficeScheduler(opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date()
  const holder = `cron:${randomUUID()}`
  const reconciled = await reconcileOfficeActions({ now })
  const orgs = await admin(db => db.query<{ org_id: string }>(`select distinct a.org_id from office_agents a join org_products p on p.org_id = a.org_id and p.product = 'office' and p.status = 'active'
    where a.status = 'active' order by a.org_id limit $1`, [officeConfig.orgsPerRun]))
  const results: { orgId: string; skipped?: 'locked'; agents?: number; executed?: number }[] = []
  for (const { org_id } of orgs) {
    if (!(await acquireOrgLock(org_id, holder, now))) { results.push({ orgId: org_id, skipped: 'locked' }); continue }
    try {
      const due = await admin(db => db.query<{ id: string }>(`select id from office_agents where org_id = $1 and status = 'active' and (next_run_at is null or next_run_at <= $2) order by next_run_at nulls first limit 10`, [org_id, now.toISOString()]))
      for (const a of due) await runOfficeAgent(a.id, { trigger: 'schedule', now, execute: false })
      const executed = await executeDue(org_id, { now })
      results.push({ orgId: org_id, agents: due.length, executed: executed.length })
    } catch (e) {
      log.error('office.scheduler.org_failed', { error: (e as Error).message })
    } finally { await releaseOrgLock(org_id, holder) }
  }
  return { reconciled: reconciled.length, orgs: results }
}
