/**
 * Staff service queue. Tickets are staff-only (RLS is_staff()); clients never see them.
 * Support coverage comes from the engagement's support hours; no continuous human coverage is implied.
 */
import type { Db } from '../db'

export const SEVERITIES = ['low', 'medium', 'high', 'urgent'] as const
export type Severity = (typeof SEVERITIES)[number]
export const CLASSIFICATIONS = ['defect', 'support_request', 'new_scope'] as const
export type Classification = (typeof CLASSIFICATIONS)[number]
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_on_agency', 'resolved', 'closed'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const STATUS_LABEL: Record<TicketStatus, string> = { open: 'Open', in_progress: 'In progress', waiting_on_agency: 'Waiting on agency', resolved: 'Resolved', closed: 'Closed' }
export const CLASSIFICATION_LABEL: Record<Classification, string> = { defect: 'Defect', support_request: 'Support request', new_scope: 'New scope' }
export const SEVERITY_TONE: Record<Severity, 'muted' | 'none' | 'warn' | 'danger'> = { low: 'muted', medium: 'none', high: 'warn', urgent: 'danger' }
export const SUPPORT_COVERAGE_NOTE = 'Support coverage comes from the engagement’s support hours. No continuous human coverage is implied; tickets are worked during those hours.'

export type Ticket = {
  id: string; agency_id: string; agency_name?: string | null; engagement_ref: string | null; title: string; detail: string | null
  severity: Severity; classification: Classification; owner: string | null; status: TicketStatus
  next_action: string | null; resolution: string | null; created_by: string | null; created_at: string; updated_at: string; resolved_at: string | null
}

export type TicketInput = {
  agency_id: string; title: string; detail?: string | null; engagement_ref?: string | null
  severity?: Severity; classification?: Classification; owner?: string | null; next_action?: string | null
}

export type TicketFilters = { status?: string; severity?: string; classification?: string; agency?: string }

const isIn = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === 'string' && (list as readonly string[]).includes(v)

export function validateTicketInput(i: TicketInput): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(i.agency_id ?? '')) return 'agency-required'
  if (!i.title || !i.title.trim()) return 'title-required'
  if (i.title.length > 200) return 'title-too-long'
  if (i.severity !== undefined && !isIn(SEVERITIES, i.severity)) return 'bad-severity'
  if (i.classification !== undefined && !isIn(CLASSIFICATIONS, i.classification)) return 'bad-classification'
  return null
}

export async function listTickets(db: Db, f: TicketFilters = {}): Promise<Ticket[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (f.status && f.status !== 'all') {
    if (f.status === 'active') where.push("t.status in ('open','in_progress','waiting_on_agency')")
    else if (isIn(TICKET_STATUSES, f.status)) { params.push(f.status); where.push(`t.status = $${params.length}`) }
  }
  if (isIn(SEVERITIES, f.severity)) { params.push(f.severity); where.push(`t.severity = $${params.length}`) }
  if (isIn(CLASSIFICATIONS, f.classification)) { params.push(f.classification); where.push(`t.classification = $${params.length}`) }
  if (f.agency && /^[0-9a-f-]{36}$/i.test(f.agency)) { params.push(f.agency); where.push(`t.agency_id = $${params.length}`) }
  const w = where.length ? 'where ' + where.join(' and ') : ''
  return db.query<Ticket>(
    `select t.id, t.agency_id, g.name as agency_name, t.engagement_ref, t.title, t.detail, t.severity, t.classification, t.owner, t.status, t.next_action, t.resolution,
            t.created_by, t.created_at::text, t.updated_at::text, t.resolved_at::text
     from service_tickets t left join agencies g on g.id = t.agency_id ${w}
     order by case t.status when 'open' then 0 when 'in_progress' then 1 when 'waiting_on_agency' then 2 when 'resolved' then 3 else 4 end,
              case t.severity when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, t.created_at desc
     limit 300`, params)
}

export async function getTicket(db: Db, id: string): Promise<Ticket | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  return db.one<Ticket>(
    `select t.id, t.agency_id, g.name as agency_name, t.engagement_ref, t.title, t.detail, t.severity, t.classification, t.owner, t.status, t.next_action, t.resolution,
            t.created_by, t.created_at::text, t.updated_at::text, t.resolved_at::text
     from service_tickets t left join agencies g on g.id = t.agency_id where t.id = $1`, [id])
}

export async function createTicket(db: Db, i: TicketInput, createdBy: string | null): Promise<string> {
  const err = validateTicketInput(i)
  if (err) throw new Error(err)
  const r = await db.one<{ id: string }>(
    `insert into service_tickets (agency_id, engagement_ref, title, detail, severity, classification, owner, next_action, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [i.agency_id, i.engagement_ref || null, i.title.trim(), i.detail || null, i.severity ?? 'medium', i.classification ?? 'support_request', i.owner || null, i.next_action || null, createdBy])
  if (!r) throw new Error('insert-failed')
  return r.id
}

export type TicketPatch = Partial<Pick<Ticket, 'title' | 'detail' | 'severity' | 'classification' | 'owner' | 'status' | 'next_action' | 'resolution' | 'engagement_ref'>>

export async function updateTicket(db: Db, id: string, p: TicketPatch): Promise<boolean> {
  const sets: string[] = []
  const params: unknown[] = [id]
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`) }
  if (p.title !== undefined) { if (!p.title.trim()) throw new Error('title-required'); set('title', p.title.trim()) }
  if (p.detail !== undefined) set('detail', p.detail || null)
  if (p.engagement_ref !== undefined) set('engagement_ref', p.engagement_ref || null)
  if (p.severity !== undefined) { if (!isIn(SEVERITIES, p.severity)) throw new Error('bad-severity'); set('severity', p.severity) }
  if (p.classification !== undefined) { if (!isIn(CLASSIFICATIONS, p.classification)) throw new Error('bad-classification'); set('classification', p.classification) }
  if (p.owner !== undefined) set('owner', p.owner || null)
  if (p.next_action !== undefined) set('next_action', p.next_action || null)
  if (p.resolution !== undefined) set('resolution', p.resolution || null)
  if (p.status !== undefined) {
    if (!isIn(TICKET_STATUSES, p.status)) throw new Error('bad-status')
    set('status', p.status)
    sets.push(p.status === 'resolved' || p.status === 'closed' ? 'resolved_at = coalesce(resolved_at, now())' : 'resolved_at = null')
  }
  if (!sets.length) return false
  const r = await db.query<{ id: string }>(`update service_tickets set ${sets.join(', ')} where id = $1 returning id`, params)
  return r.length > 0
}

export async function ticketCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.query<{ status: string; n: string }>('select status, count(*)::text as n from service_tickets group by status')
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]))
}
