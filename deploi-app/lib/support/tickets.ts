/**
 * Customer support. "Get help" (the help menu on every page) opens a ticket for the person's organization:
 * a category, the message and, optionally, the reference of the case it is about (DC-000123, which must be one
 * of the organization's own cases). Staff are told through the system mailer; their replies are emailed to the
 * person who asked and appear in the customer's own support view (/store/support).
 *
 * Isolation: customers read tickets through RLS (support_tickets / support_messages: is_staff() or
 * org_id = current_org_id()) and every query also names the actor's organization. Staff read every ticket
 * (support) and reply; a staff actor can never open a ticket for a customer.
 */
import { randomBytes } from 'node:crypto'
import { admin, type Db } from '../db'
import { env } from '../env'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import { withActor, type Actor } from '../engine/actor'
import { sendSystemEmail, supportInbox } from '../email/system'

export const SUPPORT_CATEGORIES = ['question', 'problem', 'billing', 'account', 'agent', 'other'] as const
export type SupportCategory = typeof SUPPORT_CATEGORIES[number]
export const CATEGORY_LABEL: Record<SupportCategory, string> = { question: 'A question', problem: 'Something is not working', billing: 'Billing', account: 'My account or team', agent: 'An agent did something unexpected', other: 'Something else' }
export const SUPPORT_STATUSES = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'] as const
export type SupportStatus = typeof SUPPORT_STATUSES[number]

export type Ticket = { id: string; ref: string; category: SupportCategory; subject: string; caseRef: string | null; page: string | null; status: SupportStatus; createdByEmail: string; createdAt: string; updatedAt: string; lastStaffReplyAt: string | null; orgId: string; orgName?: string }
export type TicketMessage = { id: string; authorKind: 'customer' | 'staff'; authorEmail: string; body: string; createdAt: string; emailStatus?: string | null }

type TicketRow = { id: string; ref: string; category: SupportCategory; subject: string; case_ref: string | null; page: string | null; status: SupportStatus; created_by_email: string; created_at: string; updated_at: string; last_staff_reply_at: string | null; org_id: string; org_name?: string }
const COLS = `t.id, t.ref, t.category, t.subject, t.case_ref, t.page, t.status, t.created_by_email, t.created_at::text, t.updated_at::text, t.last_staff_reply_at::text, t.org_id`
const toTicket = (r: TicketRow): Ticket => ({ id: r.id, ref: r.ref, category: r.category, subject: r.subject, caseRef: r.case_ref, page: r.page, status: r.status, createdByEmail: r.created_by_email, createdAt: r.created_at, updatedAt: r.updated_at, lastStaffReplyAt: r.last_staff_reply_at, orgId: r.org_id, ...(r.org_name ? { orgName: r.org_name } : {}) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const appLink = (path: string) => `${env.appUrl.replace(/\/$/, '')}${path}`

function customer(actor: Actor): Exclude<Actor, { kind: 'staff' }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'support requests are opened by a customer; staff reply from the staff support page')
  return actor
}
const authorEmail = (actor: Exclude<Actor, { kind: 'staff' }>) => (actor.kind === 'profile' ? actor.session.email.toLowerCase() : `shopify user ${actor.userId} (${actor.shop})`.slice(0, 320))
const text = (v: unknown, max: number, what: string) => {
  const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : ''
  if (!s) throw new EngineError('invalid_input', `${what} is required`)
  if (s.length > max) throw new EngineError('invalid_input', `${what} must be at most ${max} characters`)
  return s
}
const newRef = () => `SUP-${randomBytes(4).toString('hex').toUpperCase()}`

export type NewTicket = { category: unknown; message: unknown; subject?: unknown; caseRef?: unknown; page?: unknown }

/** Open a ticket for the actor's organization and tell staff. */
export async function createTicket(actor: Actor, input: NewTicket): Promise<{ ticket: Ticket; staffNotified: string }> {
  const a = customer(actor)
  if (!SUPPORT_CATEGORIES.includes(input.category as SupportCategory)) throw new EngineError('invalid_input', `category must be one of ${SUPPORT_CATEGORIES.join(', ')}`)
  const category = input.category as SupportCategory
  const message = text(input.message, 8000, 'a message')
  const subject = typeof input.subject === 'string' && input.subject.trim() ? text(input.subject, 200, 'the subject') : message.split('\n')[0].slice(0, 80)
  const rawRef = typeof input.caseRef === 'string' ? input.caseRef.trim().toUpperCase() : ''
  if (rawRef && !/^DC-\d{1,12}$/.test(rawRef)) throw new EngineError('invalid_input', 'a case reference looks like DC-000123')
  const page = typeof input.page === 'string' && input.page.startsWith('/') ? input.page.slice(0, 300) : null
  const r = await admin(async db => {
    if (rawRef) {
      const c = await db.one('select 1 from cases where ref = $1 and org_id = $2', [rawRef, a.orgId])
      if (!c) throw new EngineError('invalid_input', `there is no case ${rawRef} in your organization`)
    }
    const org = await db.one<{ name: string }>('select name from agencies where id = $1', [a.orgId])
    const row = (await db.one<TicketRow>(`insert into support_tickets (org_id, ref, created_by, created_by_email, category, subject, case_ref, page) values ($1,$2,$3,$4,$5,$6,$7,$8)
      returning ${COLS.replace(/t\./g, '')}`, [a.orgId, newRef(), a.kind === 'profile' ? a.session.uid : null, authorEmail(a), category, subject, rawRef || null, page]))!
    await db.query(`insert into support_messages (ticket_id, org_id, author_kind, author_email, body) values ($1,$2,'customer',$3,$4)`, [row.id, a.orgId, authorEmail(a), message])
    await audit(db, { orgId: a.orgId, entityType: 'org', entityId: a.orgId, event: 'support.ticket_opened', actor: a.label, detail: { ticket: row.ref, category, case_ref: rawRef || null } })
    return { row, orgName: org?.name ?? 'an organization' }
  })
  const mail = await sendSystemEmail({
    key: `support:new:${r.row.id}`, template: 'support_ticket_staff', to: supportInbox(), orgId: a.orgId, related: { ticket_id: r.row.id },
    params: { ref: r.row.ref, category: CATEGORY_LABEL[category], subject, from: authorEmail(a), org: r.orgName, caseRef: rawRef, page: page ?? '', message, link: appLink(`/staff/support?ticket=${r.row.id}`) },
    replyTo: a.kind === 'profile' ? a.session.email : null,
  })
  return { ticket: toTicket(r.row), staffNotified: mail.status }
}

/** The organization's tickets, newest first (read under RLS as the actor). */
export async function listTickets(actor: Actor): Promise<Ticket[]> {
  const a = customer(actor)
  return withActor(a, async db => (await db.query<TicketRow>(`select ${COLS} from support_tickets t where t.org_id = $1 order by t.updated_at desc limit 200`, [a.orgId])).map(toTicket))
}

async function messages(db: Db, ticketId: string): Promise<TicketMessage[]> {
  return (await db.query<{ id: string; author_kind: 'customer' | 'staff'; author_email: string; body: string; created_at: string; email_status: string | null }>(
    `select m.id, m.author_kind, m.author_email, m.body, m.created_at::text, null::text as email_status from support_messages m where m.ticket_id = $1 order by m.created_at, m.id`, [ticketId]))
    .map(m => ({ id: m.id, authorKind: m.author_kind, authorEmail: m.author_email, body: m.body, createdAt: m.created_at }))
}

/** One ticket with its conversation, if it belongs to the actor's organization. */
export async function getTicket(actor: Actor, id: unknown): Promise<{ ticket: Ticket; messages: TicketMessage[] }> {
  const a = customer(actor)
  if (typeof id !== 'string' || !UUID.test(id)) throw new EngineError('not_found', 'no such support request')
  return withActor(a, async db => {
    const t = await db.one<TicketRow>(`select ${COLS} from support_tickets t where t.id = $1 and t.org_id = $2`, [id, a.orgId])
    if (!t) throw new EngineError('not_found', 'no such support request')
    return { ticket: toTicket(t), messages: await messages(db, t.id) }
  })
}

/** The customer adds to the conversation; staff are told. A resolved request opens again. */
export async function customerReply(actor: Actor, id: unknown, body: unknown) {
  const a = customer(actor)
  const msg = text(body, 8000, 'a message')
  const { ticket } = await getTicket(a, id)
  const r = await admin(async db => {
    const m = (await db.one<{ id: string }>(`insert into support_messages (ticket_id, org_id, author_kind, author_email, body) values ($1,$2,'customer',$3,$4) returning id`, [ticket.id, a.orgId, authorEmail(a), msg]))!
    await db.query(`update support_tickets set status = 'open', updated_at = now() where id = $1 and org_id = $2`, [ticket.id, a.orgId])
    const org = await db.one<{ name: string }>('select name from agencies where id = $1', [a.orgId])
    return { messageId: m.id, orgName: org?.name ?? '' }
  })
  await sendSystemEmail({ key: `support:customer:${r.messageId}`, template: 'support_customer_reply', to: supportInbox(), orgId: a.orgId, related: { ticket_id: ticket.id },
    params: { ref: ticket.ref, from: authorEmail(a), org: r.orgName, message: msg, link: appLink(`/staff/support?ticket=${ticket.id}`) }, replyTo: a.kind === 'profile' ? a.session.email : null })
  return getTicket(a, ticket.id)
}

// ------------------------------------------------------------------ staff

function staff(actor: Actor): Extract<Actor, { kind: 'staff' }> {
  if (actor.kind !== 'staff') throw new EngineError('forbidden', 'staff only')
  return actor
}

/** Every organization's tickets for staff (open ones first), optionally by status. */
export async function staffListTickets(actor: Actor, opts: { status?: unknown } = {}): Promise<Ticket[]> {
  staff(actor)
  const status = SUPPORT_STATUSES.includes(opts.status as SupportStatus) ? opts.status as SupportStatus : null
  return admin(async db => (await db.query<TicketRow>(`select ${COLS}, g.name as org_name from support_tickets t join agencies g on g.id = t.org_id
    where ($1::text is null or t.status = $1) order by (t.status in ('resolved','closed')), t.updated_at desc limit 300`, [status])).map(toTicket))
}

export async function staffGetTicket(actor: Actor, id: unknown) {
  staff(actor)
  if (typeof id !== 'string' || !UUID.test(id)) throw new EngineError('not_found', 'no such support request')
  return admin(async db => {
    const t = await db.one<TicketRow>(`select ${COLS}, g.name as org_name from support_tickets t join agencies g on g.id = t.org_id where t.id = $1`, [id])
    if (!t) throw new EngineError('not_found', 'no such support request')
    const ms = await db.query<{ id: string; author_kind: 'customer' | 'staff'; author_email: string; body: string; created_at: string; email_status: string | null }>(
      `select m.id, m.author_kind, m.author_email, m.body, m.created_at::text, e.status as email_status from support_messages m left join system_emails e on e.id = m.system_email_id where m.ticket_id = $1 order by m.created_at, m.id`, [id])
    return { ticket: toTicket(t), messages: ms.map(m => ({ id: m.id, authorKind: m.author_kind, authorEmail: m.author_email, body: m.body, createdAt: m.created_at, emailStatus: m.email_status })) }
  })
}

/** Staff answer: recorded on the ticket, emailed to the person who asked, and shown in their support view. */
export async function staffReply(actor: Actor, id: unknown, body: unknown, status: unknown = 'waiting_on_customer') {
  const s = staff(actor)
  const msg = text(body, 8000, 'a reply')
  const next: SupportStatus = SUPPORT_STATUSES.includes(status as SupportStatus) ? status as SupportStatus : 'waiting_on_customer'
  const { ticket } = await staffGetTicket(s, id)
  const messageId = await admin(async db => {
    const m = (await db.one<{ id: string }>(`insert into support_messages (ticket_id, org_id, author_kind, author_email, body) values ($1,$2,'staff',$3,$4) returning id`, [ticket.id, ticket.orgId, s.session.email.toLowerCase(), msg]))!
    await db.query(`update support_tickets set status = $2, updated_at = now(), last_staff_reply_at = now() where id = $1`, [ticket.id, next])
    await audit(db, { orgId: ticket.orgId, entityType: 'org', entityId: ticket.orgId, event: 'support.staff_replied', actor: s.label, detail: { ticket: ticket.ref, status: next } })
    return m.id
  })
  const to = /@/.test(ticket.createdByEmail) ? ticket.createdByEmail : null
  if (to) {
    const mail = await sendSystemEmail({ key: `support:reply:${messageId}`, template: 'support_reply', to, orgId: ticket.orgId, related: { ticket_id: ticket.id, message_id: messageId },
      params: { ref: ticket.ref, subject: ticket.subject, message: msg, link: appLink(`/store/support?ticket=${ticket.id}`) } })
    await admin(db => db.query('update support_messages set system_email_id = $2 where id = $1', [messageId, mail.id]))
  }
  return staffGetTicket(s, ticket.id)
}

export async function staffSetStatus(actor: Actor, id: unknown, status: unknown) {
  const s = staff(actor)
  if (!SUPPORT_STATUSES.includes(status as SupportStatus)) throw new EngineError('invalid_input', `status must be one of ${SUPPORT_STATUSES.join(', ')}`)
  const { ticket } = await staffGetTicket(s, id)
  await admin(async db => {
    await db.query('update support_tickets set status = $2, updated_at = now() where id = $1', [ticket.id, status])
    await audit(db, { orgId: ticket.orgId, entityType: 'org', entityId: ticket.orgId, event: 'support.status', actor: s.label, detail: { ticket: ticket.ref, status } })
  })
  return staffGetTicket(s, ticket.id)
}
