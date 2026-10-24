/**
 * Builds and sends the morning report for one agency to every client user. Used by the cron and the preview page.
 * Duplicate-safe: the cron wraps it in withJobLock (lib/jobs/lock.ts); in addition this function takes a
 * per-agency transaction lock and skips when a worker_runs row for today (agency-local) already exists.
 * A preview/test send (record: false) bypasses the guard and records nothing; force: true resends and records.
 */
import type { Db } from '../db'
import { env } from '../env'
import { log } from '../log'
import { sendEmail, type SendResult } from '../adapters/email'
import { getMetrics, getAgency } from './metrics'
import { localDayStart } from './time'
import { buildMorningReport } from '@/emails/morning-report'
import { simulatedSummary, simulatedReportLine } from '../workers/outcomes'

export type MorningReportResult =
  | { skipped: true; reason: 'already_sent_today'; recipients: 0; results: SendResult[]; subject: null }
  | { skipped: false; recipients: number; results: SendResult[]; subject: string }

export async function sendMorningReport(db: Db, agencyId: string, now = new Date(), opts: { to?: string[]; record?: boolean; force?: boolean } = {}): Promise<MorningReportResult> {
  const record = opts.record !== false
  if (record && !opts.force) {
    // serialise concurrent callers for this agency inside the current transaction, then check today's run
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`morning_report:${agencyId}`])
    const agency = await getAgency(db, agencyId)
    const dayStart = localDayStart(agency.timezone || 'America/New_York', now)
    const already = await db.one<{ id: string }>(
      "select id from worker_runs where agency_id = $1 and worker = 'morning_report' and dry_run = false and started_at >= $2 limit 1", [agencyId, dayStart])
    if (already) {
      log.info('morning_report.skipped', { agencyId, reason: 'already_sent_today' })
      return { skipped: true, reason: 'already_sent_today', recipients: 0, results: [], subject: null }
    }
  }
  const metrics = await getMetrics(db, agencyId, now)
  // Simulated (mock-adapter) sends in the last day are named as such in every report.
  const sim = await simulatedSummary(db, agencyId, new Date(now.getTime() - 86400e3))
  const mail = await buildMorningReport(metrics, env.appUrl, now, { simulatedLine: sim && sim.simulated ? simulatedReportLine(sim) : null })
  const recipients = opts.to ?? (await db.query<{ email: string }>("select email from profiles where role = 'client' and agency_id = $1", [agencyId])).map(r => r.email)
  const results: SendResult[] = []
  for (const to of recipients) results.push(await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text }))
  if (record) {
    await db.query("insert into worker_runs (agency_id, worker, dry_run, finished_at, summary) values ($1, 'morning_report', false, now(), $2)",
      [agencyId, JSON.stringify({ recipients: recipients.length, sent: results.filter(r => r.ok).length, mocked: results.every(r => r.mocked) })])
  }
  log.info('morning_report.sent', { agencyId, recipients: recipients.length, mocked: results.every(r => r.mocked) })
  return { skipped: false, recipients: recipients.length, results, subject: mail.subject }
}
