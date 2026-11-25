/** When each scheduled job last ran and how it ended (health endpoint). Holds no tenant data. */
import { admin, type Db } from '../db'

export async function recordHeartbeat(jobKey: string, status: 'ok' | 'failed' | 'paused', detail: Record<string, number | string | boolean | null> = {}) {
  await admin(db => db.query(`insert into cron_heartbeats (job_key, last_run_at, last_status, detail) values ($1, now(), $2, $3)
    on conflict (job_key) do update set last_run_at = now(), last_status = $2, detail = $3`, [jobKey, status, JSON.stringify(detail)]))
}

export async function heartbeats(db: Db) {
  return db.query<{ job_key: string; last_run_at: string; last_status: string }>('select job_key, last_run_at, last_status from cron_heartbeats order by job_key')
}
