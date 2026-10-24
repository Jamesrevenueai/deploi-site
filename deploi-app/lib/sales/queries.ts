import type { Db } from '../db'
import type { Stage } from './stages'

export type Prospect = {
  id: string; agency_name: string; owner_name: string | null; email: string | null; phone: string | null
  city: string | null; county: string | null; state: string | null; programs: string[]; source: string
  stage: Stage; owner_notes: string | null; email_invalid: boolean; biggest_leak: string | null
  next_step: string | null; follow_up_at: string | null; agency_id: string | null; created_at: string; updated_at: string
  last_touch_at?: string | null
  assessment_credit_cents?: number | null
  credit_expires_at?: string | null
  assessment_credit_applied_at?: string | null
  credit_expired?: boolean | null
  /** phase 16: lead tagging */
  service_interest?: 'operations' | 'website_improvement' | string
  tags?: string[]
  website_url?: string | null
  website_goal?: string | null
  website_engagement_id?: string | null
  website_engagement_status?: string | null
}
export const WEBSITE_TAG = 'Website Improvement'
export const isWebsiteLead = (p: Pick<Prospect, 'service_interest' | 'tags'>) => p.service_interest === 'website_improvement' || (p.tags ?? []).includes(WEBSITE_TAG)
export type Touch = {
  id: string; prospect_id: string; channel: string; direction: 'inbound' | 'outbound'; subject: string | null
  body: string | null; at: string; meta: Record<string, unknown>
}
export type Filters = { program?: string; county?: string; stage?: string; q?: string; interest?: string }

const WEBSITE_JOIN = `(select w.id from website_engagements w where w.prospect_id = p.id order by w.created_at desc limit 1) as website_engagement_id,
            (select w.status from website_engagements w where w.prospect_id = p.id order by w.created_at desc limit 1) as website_engagement_status`

export async function listProspects(db: Db, f: Filters = {}): Promise<Prospect[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (f.program) { params.push(f.program); where.push(`$${params.length} = any(p.programs)`) }
  if (f.county) { params.push(f.county); where.push(`p.county = $${params.length}`) }
  if (f.stage) { params.push(f.stage); where.push(`p.stage = $${params.length}::prospect_stage`) }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(p.agency_name ilike $${params.length} or p.owner_name ilike $${params.length})`) }
  if (f.interest === 'website_improvement') { params.push(WEBSITE_TAG); where.push(`(p.service_interest = 'website_improvement' or $${params.length} = any(p.tags))`) }
  else if (f.interest === 'operations') { params.push(WEBSITE_TAG); where.push(`(p.service_interest <> 'website_improvement' and not ($${params.length} = any(p.tags)))`) }
  const w = where.length ? 'where ' + where.join(' and ') : ''
  return db.query<Prospect>(
    `select p.*, (select max(t.at) from touches t where t.prospect_id = p.id) as last_touch_at,
            g.assessment_credit_cents, g.credit_expires_at, g.assessment_credit_applied_at, g.credit_expired,
            ${WEBSITE_JOIN}
     from prospects p left join agencies g on g.id = p.agency_id ${w} order by p.updated_at desc`, params)
}

export async function getProspect(db: Db, id: string) {
  const p = await db.one<Prospect>(`select p.*, ${WEBSITE_JOIN} from prospects p where p.id = $1`, [id])
  if (!p) return null
  const touches = await db.query<Touch>('select * from touches where prospect_id = $1 order by at desc', [id])
  return { prospect: p, touches }
}

export async function stageCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.query<{ stage: string; n: string }>('select stage::text as stage, count(*)::text as n from prospects group by stage')
  return Object.fromEntries(rows.map(r => [r.stage, Number(r.n)]))
}

export async function distinctCounties(db: Db): Promise<string[]> {
  const rows = await db.query<{ county: string }>('select distinct county from prospects where county is not null order by 1')
  return rows.map(r => r.county)
}
