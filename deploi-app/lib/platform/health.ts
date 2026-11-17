/** Platform job lag for /api/health: counts and ages only, never an organization. */
import type { Db } from '../db'

export async function platformLag(db: Db, now = new Date()) {
  const hb = await db.one<{ last_run_at: string; last_status: string }>(`select last_run_at::text, last_status from cron_heartbeats where job_key = 'platform.retention'`)
  const d = await db.one<{ overdue: string; oldest: string | null; failed: string }>(
    `select count(*) filter (where status in ('pending','executing') and execute_after <= $1)::text as overdue,
            min(execute_after) filter (where status in ('pending','executing','failed') and execute_after <= $1)::text as oldest,
            count(*) filter (where status = 'failed')::text as failed
     from org_deletion_requests`, [now.toISOString()])
  const ageH = (iso: string | null | undefined) => (iso ? Math.round((now.getTime() - new Date(iso).getTime()) / 36e5 * 10) / 10 : null)
  return {
    retention: { lastRunAt: hb ? new Date(hb.last_run_at).toISOString() : null, status: hb?.last_status ?? 'never', lagHours: ageH(hb?.last_run_at) },
    deletion: { overdue: Number(d?.overdue ?? 0), failed: Number(d?.failed ?? 0), oldestOverdueHours: ageH(d?.oldest) },
  }
}
