/** "Deploi — morning pipeline": data builder + sender. Runs as service role from the cron. */
import { formatInTimeZone, toZonedTime } from 'date-fns-tz'
import type { Db } from '../db'
import { admin } from '../db'
import { env } from '../env'
import { sendEmail } from '../adapters/email'
import { log } from '../log'
import { getConversationGate } from './conversations'
import { STAGE_LABEL, type Stage } from './stages'

export const ET = 'America/New_York'

export type MorningItem = { id: string; agency_name: string; owner_name: string | null; stage: string; when: string | null; note: string | null }
export type MorningData = {
  dateLabel: string
  replies: MorningItem[]
  callsToday: MorningItem[]
  followUpsDue: MorningItem[]
  conversations: { held: number; goal: number }
  appUrl: string
}

type Row = { id: string; agency_name: string; owner_name: string | null; stage: Stage; when: string | null; note: string | null }

export async function buildMorningPipeline(db: Db, now = new Date()): Promise<MorningData> {
  const todayEt = formatInTimeZone(now, ET, 'yyyy-MM-dd')
  const since = new Date(now.getTime() - 24 * 3600e3).toISOString()
  const replies = await db.query<Row>(
    `select p.id, p.agency_name, p.owner_name, p.stage, t.at as "when", coalesce(t.subject, t.body) as note
     from touches t join prospects p on p.id = t.prospect_id
     where t.direction = 'inbound' and t.at >= $1 order by t.at desc`, [since])
  const callsToday = await db.query<Row>(
    `select id, agency_name, owner_name, stage, follow_up_at::text as "when", next_step as note
     from prospects where stage = 'call_booked' and follow_up_at = $1::date order by agency_name`, [todayEt])
  const followUpsDue = await db.query<Row>(
    `select id, agency_name, owner_name, stage, follow_up_at::text as "when", next_step as note
     from prospects where follow_up_at <= $1::date and stage not in ('lost','retainer','call_booked') order by follow_up_at, agency_name`, [todayEt])
  const gate = await getConversationGate(db)
  const label = (r: Row): MorningItem => ({ ...r, stage: STAGE_LABEL[r.stage] ?? r.stage })
  return {
    dateLabel: formatInTimeZone(now, ET, 'EEEE, MMMM d'),
    replies: replies.map(label), callsToday: callsToday.map(label), followUpsDue: followUpsDue.map(label),
    conversations: { held: gate.held, goal: gate.goal }, appUrl: env.appUrl,
  }
}

export function isSevenAmEt(now = new Date()) {
  return toZonedTime(now, ET).getHours() === 7
}

/** Sends once per ET day. Returns what happened. */
export async function runMorningPipeline(opts: { force?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date()
  const todayEt = formatInTimeZone(now, ET, 'yyyy-MM-dd')
  return admin(async db => {
    if (!opts.force && !isSevenAmEt(now)) return { sent: false, reason: 'not 7am ET' }
    const already = await db.one(`select id from worker_runs where worker = 'morning_pipeline' and (summary->>'date') = $1 and (summary->>'sent') = 'true'`, [todayEt])
    if (already && !opts.force) return { sent: false, reason: 'already sent today' }
    const data = await buildMorningPipeline(db, now)
    const { renderMorningPipeline } = await import('../../emails/morning-pipeline')
    const { html, text } = await renderMorningPipeline(data)
    const res = await sendEmail({ to: env.staffNotifyEmail, subject: 'Deploi — morning pipeline', html, text })
    await db.query(`insert into worker_runs (worker, dry_run, finished_at, summary) values ('morning_pipeline', false, now(), $1)`,
      [JSON.stringify({ date: todayEt, sent: res.ok, mocked: res.mocked, replies: data.replies.length, calls: data.callsToday.length, followups: data.followUpsDue.length, held: data.conversations.held })])
    log.info('morning_pipeline.sent', { ok: res.ok, mocked: res.mocked })
    return { sent: res.ok, mocked: res.mocked, counts: { replies: data.replies.length, calls: data.callsToday.length, followups: data.followUpsDue.length } }
  })
}
