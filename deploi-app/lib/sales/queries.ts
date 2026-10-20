import type { Db } from '../db'
import type { Stage } from './stages'

export type Prospect = {
  id: string; agency_name: string; owner_name: string | null; email: string | null; phone: string | null
  city: string | null; county: string | null; state: string | null; programs: string[]; source: string
  stage: Stage; owner_notes: string | null; email_invalid: boolean; biggest_leak: string | null
  next_step: string | null; follow_up_at: string | null; agency_id: string | null; created_at: string; updated_at: string
  last_touch_at?: string | null
}
export type Touch = {
  id: string; prospect_id: string; channel: string; direction: 'inbound' | 'outbound'; subject: string | null
  body: string | null; at: string; meta: Record<string, unknown>
}
export type Filters = { program?: string; county?: string; stage?: string; q?: string }

export async function listProspects(db: Db, f: Filters = {}): Promise<Prospect[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (f.program) { params.push(f.program); where.push(`$${params.length} = any(p.programs)`) }
  if (f.county) { params.push(f.county); where.push(`p.county = $${params.length}`) }
  if (f.stage) { params.push(f.stage); where.push(`p.stage = $${params.length}::prospect_stage`) }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(p.agency_name ilike $${params.length} or p.owner_name ilike $${params.length})`) }
  const w = where.length ? 'where ' + where.join(' and ') : ''
  return db.query<Prospect>(
    `select p.*, (select max(t.at) from touches t where t.prospect_id = p.id) as last_touch_at
     from prospects p ${w} order by p.updated_at desc`, params)
}

export async function getProspect(db: Db, id: string) {
  const p = await db.one<Prospect>('select * from prospects where id = $1', [id])
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
