import type { Db } from '../db'
import { type Engagement, type Status, sumHours, laborBudget, contribution, targetDate } from './states'

export type EngagementRow = Engagement & {
  agency_name: string | null; owner_name: string | null; prospect_email: string | null; prospect_phone: string | null
  hours_logged: number
}
export type Labor = { id: string; website_engagement_id: string; hours: string | number; kind: string; note: string | null; logged_by: string | null; logged_at: string }
export type Transition = { id: string; website_engagement_id: string; from_status: string | null; to_status: string; actor_id: string | null; at: string; note: string | null }

// date columns are selected as text (after w.*, so the text value wins) to avoid timezone-shifted JS Dates
const DATES_AS_TEXT = 'w.target_date::text as target_date, w.content_received_at::text as content_received_at'
const SELECT = `select w.*, ${DATES_AS_TEXT}, p.agency_name, p.owner_name, p.email as prospect_email, p.phone as prospect_phone,
  coalesce((select sum(l.hours) from website_labor l where l.website_engagement_id = w.id), 0)::float as hours_logged
  from website_engagements w left join prospects p on p.id = w.prospect_id`

export async function listEngagements(db: Db, f: { status?: string } = {}): Promise<EngagementRow[]> {
  const params: unknown[] = []
  let where = ''
  if (f.status) { params.push(f.status); where = `where w.status = $${params.length}` }
  return db.query<EngagementRow>(`${SELECT} ${where} order by w.updated_at desc`, params)
}

export async function statusCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.query<{ status: string; n: string }>('select status, count(*)::text as n from website_engagements group by status')
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]))
}

export async function getEngagement(db: Db, id: string) {
  const e = await db.one<EngagementRow>(`${SELECT} where w.id = $1`, [id])
  if (!e) return null
  const labor = await db.query<Labor>('select * from website_labor where website_engagement_id = $1 order by logged_at desc', [id])
  const transitions = await db.query<Transition>('select * from website_transitions where website_engagement_id = $1 order by at desc', [id])
  const hours = sumHours(labor)
  const rate = await internalRateCents(db)
  return { engagement: e, labor, transitions, hours, budget: laborBudget(hours), economics: contribution(e.price_cents, hours, rate) }
}

export async function getEngagementRaw(db: Db, id: string): Promise<Engagement | null> {
  return db.one<Engagement>(`select w.*, ${DATES_AS_TEXT} from website_engagements w where w.id = $1`, [id])
}

/** Internal review/build rate from the econ stream's internal_rates table when it exists; null = "rates not configured". */
export async function internalRateCents(db: Db): Promise<number | null> {
  const t = await db.one<{ r: string | null }>("select to_regclass('public.internal_rates')::text as r")
  if (!t?.r) return null
  try {
    const row = await db.one<{ hourly_cents: number }>(
      "select hourly_cents from internal_rates where key in ('build_labor','review_labor') order by case key when 'build_labor' then 0 else 1 end limit 1")
    return row ? Number(row.hourly_cents) : null
  } catch { return null }
}

/** Recomputes target_date from paid_at / access_received_at / content_received_at. */
export async function refreshTargetDate(db: Db, id: string) {
  const e = await db.one<Pick<Engagement, 'paid_at' | 'access_received_at' | 'content_received_at'>>(
    'select paid_at, access_received_at, content_received_at from website_engagements where id = $1', [id])
  if (!e) return null
  const t = targetDate(e)
  await db.query('update website_engagements set target_date = $2::date where id = $1', [id, t])
  return t
}

/** Latest website engagement per prospect, for pipeline cards. */
export async function engagementForProspect(db: Db, prospectId: string): Promise<{ id: string; status: Status } | null> {
  return db.one<{ id: string; status: Status }>('select id, status from website_engagements where prospect_id = $1 order by created_at desc limit 1', [prospectId])
}
