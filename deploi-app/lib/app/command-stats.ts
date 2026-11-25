/**
 * The extra numbers the Command center (design-ref/app-command-center.html) shows beside the existing CommandCenter
 * read: 7-day series for the KPI sparklines, "handled without you", the health ring, today vs the same day last week,
 * the age of the oldest request, and the owner's first name. Everything is counted from `cases` and `case_events`
 * (the same records "Done, with proof" lists); no number is invented, and a series with no data is all zeros.
 *
 *   handled without you  resolved cases in the last 7 days that never waited for approval / all resolved, in %
 *   health               resolved / (resolved + blocked + cancelled) over the last 7 days, in % (null with no cases)
 */
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import type { Workspace } from './contract'
import { merchantOrg } from './feeds'

export type CommandStats = {
  firstName: string | null
  /** oldest first, one value per day for the last 7 days (today last), in the organization's time zone */
  doneSeries: number[]; ownSeries: number[]; askedSeries: number[]
  doneToday: number; doneSameDayLastWeek: number
  handledWithoutYouPct: number | null
  healthPct: number | null
  oldestWaitingAt: string | null
}

export async function commandStats(actor: Actor, workspace: Workspace, opts: { now?: Date; timeZone?: string } = {}): Promise<CommandStats> {
  const orgId = merchantOrg(actor)
  const now = opts.now ?? new Date()
  const tz = opts.timeZone ?? 'UTC'
  const suite = workspace === 'store' ? 'commerce' : 'office'
  return admin(async db => {
    const profile = actor.kind === 'profile' ? await db.one<{ full_name: string | null }>('select full_name from profiles where id = $1', [actor.session.uid]) : null
    const first = (profile?.full_name ?? '').trim().split(/\s+/)[0] || null
    // per local day for the last 15 days (7 for the series, plus the same weekday last week)
    const days = await db.query<{ d: string; done: number; own: number }>(
      `with c as (select (closed_at at time zone $3)::date as d, not exists (select 1 from case_events e where e.case_id = cases.id and e.to_status = 'awaiting_approval') as own
         from cases where org_id = $1 and suite = $2 and status = 'resolved' and closed_at >= $4)
       select d::text, count(*)::int as done, count(*) filter (where own)::int as own from c group by d`,
      [orgId, suite, tz, new Date(now.getTime() - 15 * 864e5).toISOString()])
    const asked = await db.query<{ d: string; n: number }>(
      `select (e.at at time zone $3)::date::text as d, count(*)::int as n from case_events e join cases c on c.id = e.case_id
       where c.org_id = $1 and c.suite = $2 and e.to_status = 'awaiting_approval' and e.at >= $4 group by 1`,
      [orgId, suite, tz, new Date(now.getTime() - 8 * 864e5).toISOString()])
    const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    const keys = Array.from({ length: 7 }, (_, i) => localDay(new Date(now.getTime() - (6 - i) * 864e5)))
    const at = (k: string) => days.find(x => x.d === k)
    const doneSeries = keys.map(k => at(k)?.done ?? 0), ownSeries = keys.map(k => at(k)?.own ?? 0)
    const askedSeries = keys.map(k => asked.find(x => x.d === k)?.n ?? 0)
    const lastWeek = at(localDay(new Date(now.getTime() - 7 * 864e5)))?.done ?? 0
    const week = await db.one<{ resolved: number; own: number; bad: number }>(
      `select count(*) filter (where status = 'resolved')::int as resolved,
              count(*) filter (where status = 'resolved' and not exists (select 1 from case_events e where e.case_id = cases.id and e.to_status = 'awaiting_approval'))::int as own,
              count(*) filter (where status in ('blocked', 'cancelled'))::int as bad
       from cases where org_id = $1 and suite = $2 and coalesce(closed_at, updated_at) >= $3`, [orgId, suite, new Date(now.getTime() - 7 * 864e5).toISOString()])
    const r = week?.resolved ?? 0, own = week?.own ?? 0, bad = week?.bad ?? 0
    const oldest = await db.one<{ at: string | null }>(`select min(updated_at)::text as at from cases where org_id = $1 and suite = $2 and status = 'awaiting_approval'`, [orgId, suite])
    return {
      firstName: first, doneSeries, ownSeries, askedSeries,
      doneToday: doneSeries[6], doneSameDayLastWeek: lastWeek,
      handledWithoutYouPct: r ? Math.round((own / r) * 100) : null,
      healthPct: r + bad ? Math.round((r / (r + bad)) * 100) : null,
      oldestWaitingAt: oldest?.at ? new Date(oldest.at).toISOString() : null,
    }
  })
}
