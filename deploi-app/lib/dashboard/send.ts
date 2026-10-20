/** Builds and sends the morning report for one agency to every client user. Used by the cron and the preview page. */
import type { Db } from '../db'
import { env } from '../env'
import { log } from '../log'
import { sendEmail } from '../adapters/email'
import { getMetrics } from './metrics'
import { buildMorningReport } from '@/emails/morning-report'

export async function sendMorningReport(db: Db, agencyId: string, now = new Date(), opts: { to?: string[]; record?: boolean } = {}) {
  const metrics = await getMetrics(db, agencyId, now)
  const mail = await buildMorningReport(metrics, env.appUrl, now)
  const recipients = opts.to ?? (await db.query<{ email: string }>("select email from profiles where role = 'client' and agency_id = $1", [agencyId])).map(r => r.email)
  const results = []
  for (const to of recipients) results.push(await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text }))
  if (opts.record !== false) {
    await db.query("insert into worker_runs (agency_id, worker, dry_run, finished_at, summary) values ($1, 'morning_report', false, now(), $2)",
      [agencyId, JSON.stringify({ recipients: recipients.length, sent: results.filter(r => r.ok).length, mocked: results.every(r => r.mocked) })])
  }
  log.info('morning_report.sent', { agencyId, recipients: recipients.length, mocked: results.every(r => r.mocked) })
  return { recipients: recipients.length, results, subject: mail.subject }
}
