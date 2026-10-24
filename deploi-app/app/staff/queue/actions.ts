'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { log } from '@/lib/log'
import { createTicket, updateTicket, SEVERITIES, CLASSIFICATIONS, TICKET_STATUSES, type Severity, type Classification, type TicketStatus } from '@/lib/queue/tickets'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const oneOf = <T extends readonly string[]>(list: T, v: string): T[number] | undefined => ((list as readonly string[]).includes(v) ? (v as T[number]) : undefined)

export async function createTicketAction(formData: FormData) {
  const session = await requireRole('staff')
  let id: string
  try {
    id = await withUser(session, db => createTicket(db, {
      agency_id: str(formData, 'agency_id'), title: str(formData, 'title'), detail: str(formData, 'detail') || null,
      engagement_ref: str(formData, 'engagement_ref') || null, severity: oneOf(SEVERITIES, str(formData, 'severity')) as Severity | undefined,
      classification: oneOf(CLASSIFICATIONS, str(formData, 'classification')) as Classification | undefined,
      owner: str(formData, 'owner') || null, next_action: str(formData, 'next_action') || null,
    }, session.uid), { ip: await requestIp() })
  } catch (e) {
    redirect(`/staff/queue?error=${encodeURIComponent((e as Error).message.slice(0, 80))}`)
  }
  log.info('queue.ticket.created', { id })
  revalidatePath('/staff/queue')
  redirect(`/staff/queue/${id}?created=1`)
}

export async function updateTicketAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect('/staff/queue?error=bad-id')
  try {
    await withUser(session, db => updateTicket(db, id, {
      title: str(formData, 'title'), detail: str(formData, 'detail'), engagement_ref: str(formData, 'engagement_ref'),
      severity: oneOf(SEVERITIES, str(formData, 'severity')) as Severity | undefined,
      classification: oneOf(CLASSIFICATIONS, str(formData, 'classification')) as Classification | undefined,
      owner: str(formData, 'owner'), status: oneOf(TICKET_STATUSES, str(formData, 'status')) as TicketStatus | undefined,
      next_action: str(formData, 'next_action'), resolution: str(formData, 'resolution'),
    }), { ip: await requestIp() })
  } catch (e) {
    redirect(`/staff/queue/${id}?error=${encodeURIComponent((e as Error).message.slice(0, 80))}`)
  }
  log.info('queue.ticket.updated', { id })
  revalidatePath('/staff/queue')
  revalidatePath(`/staff/queue/${id}`)
  redirect(`/staff/queue/${id}?saved=1`)
}

export async function setTicketStatusAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const status = oneOf(TICKET_STATUSES, str(formData, 'status')) as TicketStatus | undefined
  if (!/^[0-9a-f-]{36}$/i.test(id) || !status) redirect('/staff/queue?error=bad-status')
  await withUser(session, db => updateTicket(db, id, { status }), { ip: await requestIp() })
  log.info('queue.ticket.status', { id, status })
  revalidatePath('/staff/queue')
  redirect(`/staff/queue/${id}?saved=1`)
}
