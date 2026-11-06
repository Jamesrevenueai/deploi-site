/**
 * Crew: the business's own people who do the physical work (packers, warehouse staff, field crew).
 *
 *  - Owners and admins add, edit, deactivate and reactivate crew members (Settings → Crew); every member of
 *    the organization can see the crew and today's jobs.
 *  - Agents (or the owner) give a crew member jobs (crew_jobs); notifyCrew sends that person one clear message
 *    with today's jobs: address (with a map link), details, photos, what changed since the last message, and
 *    a one-time "Mark done" link per job. Email goes through the system mailer (held unless EMAIL_LIVE_SENDS
 *    allows the address); text goes through the channel adapter (simulated by default: nothing leaves).
 *  - "Mark done" links are signed (HMAC with the app secret), single-use and expiring (CREW_LINK_TTL_HOURS,
 *    default 36). Opening a link only shows the job; the button (a POST) marks it done, so a mail scanner
 *    that opens links never completes a job. A reply "DONE <job>" from the crew member's phone or address
 *    does the same (handleCrewReply).
 *  - A job becomes done once: that transition emits one AgentEvent { source: 'crew', type: 'crew.done' }.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { admin, type Db } from '../db'
import { env } from '../env'
import { log } from '../log'
import { audit } from '../engine/audit'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { actorRole, assertCan } from '../platform/rbac'
import { sendSystemEmail } from '../email/system'
import type { CrewMessage, NotifyResult } from './index'
import { channelAdapter, normalizePhone, TEXT_LIMIT } from './channels'
import { emitAgentEvent } from './events'
import { safeUrl, type CrewData, type CrewJobView } from './templates'

export const CREW_ROLES = ['packer', 'warehouse', 'field', 'other'] as const
export type CrewRole = typeof CREW_ROLES[number]
export type CrewMember = { id: string; name: string; role: CrewRole; email: string | null; phone: string | null; channels: ('email' | 'text')[]; active: boolean; createdAt: string }
export type CrewJob = {
  id: string; jobRef: string; crewMemberId: string | null; crewName: string | null; date: string; address: string | null; details: string | null; photos: string[]
  status: 'scheduled' | 'sent' | 'in_progress' | 'done' | 'cancelled'; sourceAgent: string | null; sourceCaseRef: string | null; doneAt: string | null; doneVia: string | null; lastSentAt: string | null
}

const ID = /^[0-9a-f-]{36}$/i
const EMAIL = /^[^\s@<>(),;:"[\]\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i
const today = (now = new Date()) => now.toISOString().slice(0, 10)

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'the crew belongs to a customer organization')
  return actor.orgId
}

type MemberRow = { id: string; name: string; role: CrewRole; email: string | null; phone: string | null; channels: ('email' | 'text')[]; active: boolean; created_at: string }
const member = (r: MemberRow): CrewMember => ({ id: r.id, name: r.name, role: r.role, email: r.email, phone: r.phone, channels: r.channels, active: r.active, createdAt: r.created_at })
type JobRow = { id: string; job_ref: string; crew_member_id: string | null; crew_name: string | null; job_date: string; address: string | null; details: string | null; photos: string[]; status: CrewJob['status']; source_agent: string | null; source_case_ref: string | null; done_at: string | null; done_via: string | null; last_sent_at: string | null; last_sent: Snapshot | null; created_at: string }
const job = (r: JobRow): CrewJob => ({ id: r.id, jobRef: r.job_ref, crewMemberId: r.crew_member_id, crewName: r.crew_name, date: r.job_date, address: r.address, details: r.details, photos: r.photos, status: r.status, sourceAgent: r.source_agent, sourceCaseRef: r.source_case_ref, doneAt: r.done_at, doneVia: r.done_via, lastSentAt: r.last_sent_at })
const JOB_COLS = `j.id, j.job_ref, j.crew_member_id, m.name as crew_name, j.job_date::text as job_date, j.address, j.details, j.photos, j.status, j.source_agent, j.source_case_ref, j.done_at::text as done_at, j.done_via, j.last_sent_at::text as last_sent_at, j.last_sent, j.created_at::text as created_at`

// ------------------------------------------------------------------ members

function memberInput(input: Record<string, unknown>, partial: boolean) {
  const out: Partial<Omit<CrewMember, 'id' | 'createdAt' | 'active'>> = {}
  if (!partial || 'name' in input) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 120) throw new EngineError('invalid_input', 'a name of 1 to 120 characters is required')
    out.name = name
  }
  if (!partial || 'role' in input) {
    const role = input.role ?? 'other'
    if (!(CREW_ROLES as readonly unknown[]).includes(role)) throw new EngineError('invalid_input', 'role must be packer, warehouse, field or other')
    out.role = role as CrewRole
  }
  if (!partial || 'email' in input) {
    const e = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (e && (!EMAIL.test(e) || e.length > 320)) throw new EngineError('invalid_input', 'that email address does not look right')
    out.email = e || null
  }
  if (!partial || 'phone' in input) {
    const raw = typeof input.phone === 'string' ? input.phone.trim() : ''
    const p = raw ? normalizePhone(raw) : null
    if (raw && !p) throw new EngineError('invalid_input', 'enter the phone number in international form, e.g. +15551234567')
    out.phone = p
  }
  if (!partial || 'channels' in input) {
    const ch = Array.isArray(input.channels) ? [...new Set(input.channels.filter((c): c is 'email' | 'text' => c === 'email' || c === 'text'))] : ['email' as const]
    out.channels = ch
  }
  return out
}
function checkReachable(m: { email: string | null; phone: string | null; channels: string[] }) {
  if (!m.channels.length) throw new EngineError('invalid_input', 'choose at least one way to reach this person (email or text)')
  if (m.channels.includes('email') && !m.email) throw new EngineError('invalid_input', 'add an email address, or turn email off for this person')
  if (m.channels.includes('text') && !m.phone) throw new EngineError('invalid_input', 'add a phone number, or turn text off for this person')
}

/** Everyone in the organization may see the crew. */
export async function listCrew(actor: Actor): Promise<{ members: CrewMember[]; canManage: boolean }> {
  const orgId = orgOf(actor)
  return admin(async db => {
    const role = await actorRole(actor, orgId, db)
    if (!role) throw new EngineError('forbidden', 'you are not a member of this organization')
    const rows = await db.query<MemberRow>(`select id, name, role, email, phone, channels, active, created_at::text from crew_members where org_id = $1 order by active desc, name, id`, [orgId])
    return { members: rows.map(member), canManage: role === 'owner' || role === 'admin' }
  })
}

export async function addCrewMember(actor: Actor, input: Record<string, unknown>): Promise<CrewMember> {
  const orgId = orgOf(actor)
  const v = memberInput(input, false) as Required<ReturnType<typeof memberInput>>
  checkReachable(v)
  return admin(async db => {
    await assertCan(actor, orgId, 'settings', db)
    const r = (await db.one<MemberRow>(`insert into crew_members (org_id, name, role, email, phone, channels) values ($1,$2,$3,$4,$5,$6) returning id, name, role, email, phone, channels, active, created_at::text`,
      [orgId, v.name, v.role, v.email, v.phone, v.channels]))!
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'crew.member_added', actor: actor.label, detail: { crew_member_id: r.id, role: r.role } })
    return member(r)
  })
}

export async function updateCrewMember(actor: Actor, id: string, input: Record<string, unknown>): Promise<CrewMember> {
  const orgId = orgOf(actor)
  if (!ID.test(id)) throw new EngineError('invalid_input', 'a crew member id is required')
  const v = memberInput(input, true)
  return admin(async db => {
    await assertCan(actor, orgId, 'settings', db)
    const cur = await db.one<MemberRow>('select id, name, role, email, phone, channels, active, created_at::text from crew_members where id = $1 and org_id = $2 for update', [id, orgId])
    if (!cur) throw new EngineError('not_found', 'no such crew member')
    const next = { ...cur, ...v }
    checkReachable(next)
    const r = (await db.one<MemberRow>(`update crew_members set name = $3, role = $4, email = $5, phone = $6, channels = $7, updated_at = now() where id = $1 and org_id = $2 returning id, name, role, email, phone, channels, active, created_at::text`,
      [id, orgId, next.name, next.role, next.email, next.phone, next.channels]))!
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'crew.member_updated', actor: actor.label, detail: { crew_member_id: id, fields: Object.keys(v) } })
    return member(r)
  })
}

/** Deactivate (no more messages, links stop working) or reactivate a crew member. Their history is kept. */
export async function setCrewActive(actor: Actor, id: string, active: boolean): Promise<CrewMember> {
  const orgId = orgOf(actor)
  if (!ID.test(id)) throw new EngineError('invalid_input', 'a crew member id is required')
  return admin(async db => {
    await assertCan(actor, orgId, 'settings', db)
    const r = await db.one<MemberRow>(`update crew_members set active = $3, updated_at = now() where id = $1 and org_id = $2 returning id, name, role, email, phone, channels, active, created_at::text`, [id, orgId, active])
    if (!r) throw new EngineError('not_found', 'no such crew member')
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: active ? 'crew.member_reactivated' : 'crew.member_deactivated', actor: actor.label, detail: { crew_member_id: id } })
    return member(r)
  })
}

// ------------------------------------------------------------------ jobs

export type JobInput = { orgId: string; jobRef: string; crewMemberId?: string | null; date?: string | null; address?: string | null; details?: string | null; photos?: string[]; sourceAgent?: string | null; sourceCaseRef?: string | null }

/** Create or update a job by its reference (agents call this; the owner does through the jobs API). */
export async function upsertCrewJob(db: Db, i: JobInput): Promise<CrewJob> {
  const ref = String(i.jobRef ?? '').trim()
  if (!ref || ref.length > 60) throw new EngineError('invalid_input', 'a job reference of 1 to 60 characters is required')
  if (i.crewMemberId) {
    const m = await db.one('select 1 from crew_members where id = $1 and org_id = $2', [i.crewMemberId, i.orgId])
    if (!m) throw new EngineError('not_found', 'no such crew member')
  }
  const date = i.date && /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : null
  const photos = i.photos === undefined ? null : i.photos.map(p => safeUrl(p)).filter((p): p is string => Boolean(p)).slice(0, 20)
  const r = await db.one<{ id: string }>(
    `insert into crew_jobs (org_id, job_ref, crew_member_id, job_date, address, details, photos, source_agent, source_case_ref)
     values ($1,$2,$3,coalesce($4::date, current_date),$5,$6,coalesce($7::text[], '{}'),$8,$9)
     on conflict (org_id, job_ref) do update set
       crew_member_id = coalesce(excluded.crew_member_id, crew_jobs.crew_member_id),
       job_date = case when $4::date is null then crew_jobs.job_date else excluded.job_date end,
       address = coalesce(excluded.address, crew_jobs.address), details = coalesce(excluded.details, crew_jobs.details),
       photos = case when $7::text[] is null then crew_jobs.photos else excluded.photos end,
       source_agent = coalesce(crew_jobs.source_agent, excluded.source_agent), source_case_ref = coalesce(crew_jobs.source_case_ref, excluded.source_case_ref), updated_at = now()
     returning id`,
    [i.orgId, ref, i.crewMemberId ?? null, date, i.address?.slice(0, 500) ?? null, i.details?.slice(0, 4000) ?? null, photos, i.sourceAgent?.slice(0, 80) ?? null, i.sourceCaseRef?.slice(0, 40) ?? null])
  return (await jobById(db, i.orgId, r!.id))!
}

async function jobById(db: Db, orgId: string, id: string) {
  const r = await db.one<JobRow>(`select ${JOB_COLS} from crew_jobs j left join crew_members m on m.id = j.crew_member_id where j.id = $1 and j.org_id = $2`, [id, orgId])
  return r ? job(r) : null
}

/** One day's jobs (default today, UTC) for everyone in the crew. Any member of the organization may look. */
export async function crewJobsFor(actor: Actor, date?: string | null): Promise<{ date: string; jobs: CrewJob[]; canManage: boolean }> {
  const orgId = orgOf(actor)
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today()
  return admin(async db => {
    const role = await actorRole(actor, orgId, db)
    if (!role) throw new EngineError('forbidden', 'you are not a member of this organization')
    const rows = await db.query<JobRow>(`select ${JOB_COLS} from crew_jobs j left join crew_members m on m.id = j.crew_member_id where j.org_id = $1 and j.job_date = $2 order by m.name nulls last, j.created_at, j.id`, [orgId, d])
    return { date: d, jobs: rows.map(job), canManage: role === 'owner' || role === 'admin' }
  })
}

export async function addJobAsOwner(actor: Actor, input: Record<string, unknown>): Promise<CrewJob> {
  const orgId = orgOf(actor)
  return admin(async db => {
    await assertCan(actor, orgId, 'settings', db)
    const j = await upsertCrewJob(db, {
      orgId, jobRef: String(input.jobRef ?? ''), crewMemberId: typeof input.crewMemberId === 'string' && ID.test(input.crewMemberId) ? input.crewMemberId : null,
      date: typeof input.date === 'string' ? input.date : null, address: typeof input.address === 'string' ? input.address.trim() || null : null,
      details: typeof input.details === 'string' ? input.details.trim() || null : null, photos: Array.isArray(input.photos) ? input.photos.filter((p): p is string => typeof p === 'string') : undefined, sourceAgent: 'owner',
    })
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'crew.job_saved', actor: actor.label, detail: { job_id: j.id, job_ref: j.jobRef } })
    return j
  })
}

export async function cancelJobAsOwner(actor: Actor, jobId: string) {
  const orgId = orgOf(actor)
  if (!ID.test(jobId)) throw new EngineError('invalid_input', 'a job id is required')
  return admin(async db => {
    await assertCan(actor, orgId, 'settings', db)
    const r = await db.one<{ id: string }>(`update crew_jobs set status = 'cancelled', updated_at = now() where id = $1 and org_id = $2 and status not in ('done','cancelled') returning id`, [jobId, orgId])
    if (!r) throw new EngineError('invalid_input', 'that job is already done or cancelled, or does not exist')
    // its links stop working: a cancelled job is closed (lib/notify/crew.ts stateOf)
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'crew.job_cancelled', actor: actor.label, detail: { job_id: jobId } })
    return { cancelled: jobId }
  })
}

export async function markDoneAsOwner(actor: Actor, jobId: string) {
  const orgId = orgOf(actor)
  if (!ID.test(jobId)) throw new EngineError('invalid_input', 'a job id is required')
  await assertCan(actor, orgId, 'settings')
  const r = await markJobDone(orgId, jobId, 'owner', actor.label)
  if (!r.changed) throw new EngineError('invalid_input', 'that job is already done or cancelled, or does not exist')
  return r
}

/**
 * Mark a job done. Only the first transition counts: it records how (link, reply, owner) and emits one
 * crew.done event. A repeat (second click, a reply after the link) changes nothing and emits nothing.
 */
export async function markJobDone(orgId: string, jobId: string, via: 'link' | 'reply' | 'owner', actor = `crew:${via}`): Promise<{ changed: boolean; job: CrewJob | null; event: boolean }> {
  const r = await admin(async db => {
    const u = await db.one<{ id: string }>(`update crew_jobs set status = 'done', done_at = now(), done_via = $3, updated_at = now() where id = $1 and org_id = $2 and status not in ('done', 'cancelled') returning id`, [jobId, orgId, via])
    if (!u) return { changed: false, job: await jobById(db, orgId, jobId) }
    await db.query('update crew_job_links set used_at = coalesce(used_at, now()) where job_id = $1', [jobId])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'crew.job_done', actor, detail: { job_id: jobId, via } })
    return { changed: true, job: await jobById(db, orgId, jobId) }
  })
  if (!r.changed || !r.job) return { ...r, event: false }
  await emitAgentEvent({
    source: 'crew', type: 'crew.done', orgId, externalId: `crew.done:${jobId}`, occurredAt: r.job.doneAt ? new Date(r.job.doneAt).toISOString() : new Date().toISOString(),
    payload: { jobId, jobRef: r.job.jobRef, crewMemberId: r.job.crewMemberId, via, sourceAgent: r.job.sourceAgent, sourceCaseRef: r.job.sourceCaseRef, address: r.job.address },
  })
  log.info('crew.done', { org: orgId, job: jobId, via })
  return { ...r, event: true }
}

// ------------------------------------------------------------------ one-time done links

const linkSecret = () => { const s = (process.env.CREW_LINK_SECRET ?? '').trim() || env.appSecret; return s && s.length >= 16 ? s : null }
const sign = (body: string, key: string) => createHmac('sha256', `deploi-crew-done:${key}`).update(body).digest('base64url')
export const crewLinkTtlMs = () => { const h = Number(process.env.CREW_LINK_TTL_HOURS); return (Number.isFinite(h) && h > 0 && h <= 24 * 14 ? h : 36) * 3600e3 }
export const CREW_DONE_PATH = '/crew/done/'

export function crewToken(linkId: string, expiresAt: Date): string | null {
  const key = linkSecret()
  if (!key) return null
  const body = Buffer.from(JSON.stringify({ l: linkId, x: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url')
  return `${body}.${sign(body, key)}`
}
/** The link id and expiry when the signature is valid (expiry is checked separately, so the page can say why). */
export function verifyCrewToken(token: string): { linkId: string; expiresAt: Date } | null {
  const key = linkSecret()
  if (!key || typeof token !== 'string' || token.length > 400) return null
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) return null
  const want = sign(body, key)
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null
  try {
    const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { l?: unknown; x?: unknown }
    if (typeof j.l !== 'string' || !ID.test(j.l) || typeof j.x !== 'number') return null
    return { linkId: j.l, expiresAt: new Date(j.x * 1000) }
  } catch { return null }
}

export type LinkState = { state: 'ready' | 'used' | 'expired' | 'invalid' | 'closed'; jobRef?: string; address?: string | null; crewName?: string | null; orgName?: string | null }

async function linkRow(db: Db, linkId: string) {
  return db.one<{ id: string; org_id: string; job_id: string; expires_at: string; used_at: string | null; job_ref: string; address: string | null; status: string; crew_name: string | null; crew_active: boolean | null; org_name: string | null }>(
    `select l.id, l.org_id, l.job_id, l.expires_at::text, l.used_at::text, j.job_ref, j.address, j.status, m.name as crew_name, m.active as crew_active, a.name as org_name
     from crew_job_links l join crew_jobs j on j.id = l.job_id left join crew_members m on m.id = l.crew_member_id left join agencies a on a.id = l.org_id where l.id = $1`, [linkId])
}
const stateOf = (r: NonNullable<Awaited<ReturnType<typeof linkRow>>>, now: Date): LinkState['state'] =>
  r.used_at || r.status === 'done' ? 'used' : r.status === 'cancelled' || r.crew_active === false ? 'closed' : new Date(r.expires_at) <= now ? 'expired' : 'ready'

/** What the link page shows (GET): changes nothing. */
export async function previewCrewLink(token: string, now = new Date()): Promise<LinkState> {
  const t = verifyCrewToken(token)
  if (!t) return { state: 'invalid' }
  const r = await admin(db => linkRow(db, t.linkId))
  if (!r) return { state: 'invalid' }
  const state = t.expiresAt <= now ? (r.used_at ? 'used' : 'expired') : stateOf(r, now)
  return { state, jobRef: r.job_ref, address: r.address, crewName: r.crew_name, orgName: r.org_name }
}

/** The button (POST): uses the link once and marks its job done. */
export async function completeCrewLink(token: string, now = new Date()): Promise<LinkState & { event?: boolean }> {
  const t = verifyCrewToken(token)
  if (!t) return { state: 'invalid' }
  if (t.expiresAt <= now) return { state: 'expired' }
  const claimed = await admin(async db => {
    const r = await linkRow(db, t.linkId)
    if (!r) return { state: 'invalid' as const }
    const s = stateOf(r, now)
    if (s !== 'ready') return { state: s, jobRef: r.job_ref }
    // single use: only one request can flip used_at
    const u = await db.one<{ id: string }>(`update crew_job_links set used_at = $2 where id = $1 and used_at is null and expires_at > $2 returning id`, [t.linkId, now.toISOString()])
    if (!u) return { state: 'used' as const, jobRef: r.job_ref }
    return { state: 'ready' as const, orgId: r.org_id, jobId: r.job_id, jobRef: r.job_ref, address: r.address, crewName: r.crew_name, orgName: r.org_name }
  })
  if (claimed.state !== 'ready' || !('jobId' in claimed)) return claimed
  const done = await markJobDone(claimed.orgId!, claimed.jobId!, 'link')
  return { state: done.changed ? 'ready' : 'used', jobRef: claimed.jobRef, address: claimed.address, crewName: claimed.crewName, orgName: claimed.orgName, event: done.event }
}

// ------------------------------------------------------------------ replies ("done")

/** "done", "DONE J-1001", "Done #J-1001 thanks", "finished J-1001". Returns the job reference when one is named. */
export function parseCrewReply(text: string): { done: boolean; jobRef: string | null } {
  const first = String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('>')) ?? ''
  const m = /^(?:done|finished|complete|completed)\b[\s:,.!-]*#?([A-Za-z0-9][A-Za-z0-9._-]{0,59})?/i.exec(first)
  if (!m) return { done: false, jobRef: null }
  const ref = m[1] && !/^(thanks?|thank|ok|all|now|today|with)$/i.test(m[1]) ? m[1] : null
  return { done: true, jobRef: ref }
}

/**
 * An inbound reply from a crew member (an inbound text, or a reply email when the inbound path delivers one).
 * The sender must be an active crew member of the organization (matched on phone or address). The reply is
 * logged; "done" with a job reference marks that job, "done" alone marks their only open job today.
 */
export async function handleCrewReply(i: { orgId: string; from: string; text: string; channel: 'text' | 'email'; messageId: string; now?: Date }): Promise<{ ok: boolean; reason: string; jobRef?: string; event?: boolean }> {
  const from = i.channel === 'text' ? normalizePhone(i.from) : String(i.from ?? '').trim().toLowerCase()
  if (!from) return { ok: false, reason: 'unknown sender' }
  const m = await admin(db => db.one<{ id: string; name: string }>(
    `select id, name from crew_members where org_id = $1 and active and ${i.channel === 'text' ? 'phone = $2' : 'lower(email) = $2'} order by created_at limit 1`, [i.orgId, from]))
  if (!m) return { ok: false, reason: 'the sender is not an active crew member' }
  const logged = await admin(db => db.one<{ id: string }>(
    `insert into crew_messages (org_id, crew_member_id, direction, channel, dedupe_key, body, status) values ($1,$2,'in',$3,$4,$5,'received')
     on conflict (org_id, dedupe_key, channel, direction) do nothing returning id`, [i.orgId, m.id, i.channel, `reply:${i.messageId}`.slice(0, 200), String(i.text ?? '').slice(0, 8000)]))
  if (!logged) return { ok: false, reason: 'duplicate: this reply was already handled' }
  const p = parseCrewReply(i.text)
  if (!p.done) return { ok: false, reason: 'not a done reply; kept for the owner to read' }
  const d = today(i.now)
  const open = await admin(db => db.query<{ id: string; job_ref: string }>(
    `select id, job_ref from crew_jobs where org_id = $1 and crew_member_id = $2 and status not in ('done','cancelled') and ($3::text is null and job_date = $4::date or lower(job_ref) = lower($3)) order by created_at`, [i.orgId, m.id, p.jobRef, d]))
  if (!open.length) return { ok: false, reason: p.jobRef ? `no open job ${p.jobRef} for this crew member` : 'no open job today for this crew member' }
  if (open.length > 1) return { ok: false, reason: 'more than one open job: reply DONE and the job number' }
  const r = await markJobDone(i.orgId, open[0].id, 'reply')
  await admin(db => db.query('update crew_messages set job_refs = $2 where id = $1', [logged.id, [open[0].job_ref]]))
  return { ok: r.changed, reason: r.changed ? 'marked done' : 'already done', jobRef: open[0].job_ref, event: r.event }
}

// ------------------------------------------------------------------ the crew message

type Snapshot = { address: string | null; details: string | null; photos: string[]; status: string }
export function jobChanges(prev: Snapshot | null, cur: Snapshot, memberWasMessaged: boolean): string[] {
  if (!prev) return memberWasMessaged ? ['New job since my last message'] : []
  const out: string[] = []
  if (cur.status === 'cancelled' && prev.status !== 'cancelled') out.push('Cancelled: do not do this job')
  if ((prev.address ?? '') !== (cur.address ?? '')) out.push('Address changed')
  if ((prev.details ?? '') !== (cur.details ?? '')) out.push('Details changed')
  const added = cur.photos.filter(p => !prev.photos.includes(p)).length
  if (added) out.push(`${added} new photo${added === 1 ? '' : 's'}`)
  return out
}

const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

/**
 * notifyCrew: record (or update) the job named in the message, then send the crew member one message with all
 * of today's jobs. One message per (organization, dedupeKey).
 */
export async function notifyCrewImpl(m: CrewMessage, opts: { now?: Date } = {}): Promise<NotifyResult> {
  const now = opts.now ?? new Date()
  if (!m?.orgId || !ID.test(m.orgId) || !m.crewMemberId || !ID.test(m.crewMemberId)) return { status: 'failed', id: null, reason: 'an organization and a crew member are required' }
  if (!m.dedupeKey || m.dedupeKey.length > 200) return { status: 'failed', id: null, reason: 'a dedupe key of 1 to 200 characters is required' }
  const d = today(now)
  const prep = await admin(async db => {
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 5960))`, [`crew-msg:${m.orgId}:${m.dedupeKey}`])
    const prior = await db.query<{ id: string; status: string; status_reason: string | null }>(`select id, status, status_reason from crew_messages where org_id = $1 and dedupe_key = $2 and direction = 'out' order by created_at`, [m.orgId, m.dedupeKey])
    if (prior.length) return { kind: 'duplicate' as const, prior }
    const who = await db.one<MemberRow>('select id, name, role, email, phone, channels, active, created_at::text from crew_members where id = $1 and org_id = $2', [m.crewMemberId, m.orgId])
    if (!who) return { kind: 'missing' as const, reason: 'no such crew member in this organization' }
    if (!who.active) return { kind: 'missing' as const, reason: 'this crew member is deactivated' }
    if (m.jobRef) await upsertCrewJob(db, { orgId: m.orgId, jobRef: m.jobRef, crewMemberId: who.id, address: m.address ?? null, details: m.body || null, photos: m.photos, date: d })
    const messagedBefore = Boolean(await db.one(`select 1 from crew_messages where org_id = $1 and crew_member_id = $2 and direction = 'out' and created_at::date = $3::date limit 1`, [m.orgId, who.id, d]))
    const rows = await db.query<JobRow>(`select ${JOB_COLS} from crew_jobs j left join crew_members m on m.id = j.crew_member_id
      where j.org_id = $1 and j.crew_member_id = $2 and j.job_date = $3 and (j.status <> 'cancelled' or (j.last_sent is not null and j.last_sent->>'status' <> 'cancelled')) order by j.created_at, j.id`, [m.orgId, who.id, d])
    const org = await db.one<{ name: string }>('select name from agencies where id = $1', [m.orgId])
    const expires = new Date(now.getTime() + crewLinkTtlMs())
    const links: Record<string, string> = {}
    const views: CrewJobView[] = []
    for (const [i, r] of rows.entries()) {
      const snap: Snapshot = { address: r.address, details: r.details, photos: r.photos, status: r.status }
      let doneParam: string | null = null
      if (r.status !== 'done' && r.status !== 'cancelled') {
        const l = (await db.one<{ id: string }>(`insert into crew_job_links (org_id, job_id, crew_member_id, message_key, expires_at) values ($1,$2,$3,$4,$5) returning id`, [m.orgId, r.id, who.id, m.dedupeKey, expires.toISOString()]))!
        const tok = crewToken(l.id, expires)
        if (tok) { doneParam = `done_${i}`; links[doneParam] = `${env.appUrl.replace(/\/$/, '')}${CREW_DONE_PATH}${tok}` }
      }
      views.push({ jobRef: r.job_ref, address: r.address, details: r.details, photos: r.photos, status: r.status, doneParam, changes: jobChanges(r.last_sent, snap, messagedBefore) })
      await db.query(`update crew_jobs set last_sent = $2, last_sent_at = now(), status = case when status = 'scheduled' then 'sent' else status end where id = $1`, [r.id, JSON.stringify(snap)])
    }
    const data: CrewData = { crewName: who.name, orgName: org?.name ?? 'your team', dateLabel: dateLabel(d), intro: m.subject && m.subject !== m.body ? m.subject : '', jobs: views }
    return { kind: 'ready' as const, who: member(who), data, links, jobRefs: rows.map(r => r.job_ref) }
  })
  if (prep.kind === 'duplicate') return { status: prep.prior.some(p => p.status === 'sent') ? 'sent' : 'held', id: prep.prior[0].id, reason: 'duplicate: this message was already handled' }
  if (prep.kind === 'missing') return { status: 'skipped', id: null, reason: prep.reason }

  const { who, data, links, jobRefs } = prep
  const results: { channel: 'email' | 'text'; id: string; status: string }[] = []
  const logRow = (channel: 'email' | 'text', subject: string | null, body: string, status: string, reason: string | null, ids: { email?: string; outbox?: string }) => admin(db => db.one<{ id: string }>(
    `insert into crew_messages (org_id, crew_member_id, direction, channel, dedupe_key, job_refs, subject, body, status, status_reason, system_email_id, outbox_id)
     values ($1,$2,'out',$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (org_id, dedupe_key, channel, direction) do nothing returning id`,
    [m.orgId, who.id, channel, m.dedupeKey, jobRefs, subject, body.slice(0, 8000), status, reason?.slice(0, 500) ?? null, ids.email ?? null, ids.outbox ?? null]))

  if (who.channels.includes('email') && who.email) {
    const doneKeys = Object.keys(links)
    try {
      const r = await sendSystemEmail({ key: `crew:${m.orgId}:${m.dedupeKey}`.slice(0, 200), template: 'crew_jobs', to: who.email, orgId: m.orgId, params: { data: JSON.stringify(data), ...links }, secretParams: doneKeys, related: { crew_member: who.id, jobs: jobRefs } })
      const st = r.status === 'sent' ? 'sent' : r.status === 'held' ? 'held' : 'failed'
      const stored = await admin(db => db.one<{ subject: string; body_text: string }>('select subject, body_text from system_emails where id = $1', [r.id]))
      const row = await logRow('email', stored?.subject ?? null, stored?.body_text ?? '', st, r.reason, { email: r.id })
      if (row) results.push({ channel: 'email', id: row.id, status: st })
    } catch (e) {
      const row = await logRow('email', null, '(not rendered)', 'failed', (e as Error).message, {})
      if (row) results.push({ channel: 'email', id: row.id, status: 'failed' })
    }
  }
  if (who.channels.includes('text') && who.phone) {
    const open = data.jobs.filter(j => j.status !== 'done' && j.status !== 'cancelled')
    const lines = [`Deploi: Hi ${who.name}, ${open.length} job${open.length === 1 ? '' : 's'} today (${data.dateLabel}).`]
    data.jobs.forEach((j, i) => lines.push(`${i + 1}) ${j.jobRef}${j.status === 'cancelled' ? ' CANCELLED' : j.status === 'done' ? ' (done)' : ''}${j.address ? ` at ${j.address}` : ''}${j.changes.length ? ` [${j.changes.join('; ')}]` : ''}${j.doneParam && links[j.doneParam] ? ` Done: ${links[j.doneParam]}` : ''}`))
    lines.push('Reply DONE and the job number when finished.')
    const body = lines.join('\n').slice(0, TEXT_LIMIT)
    try {
      const a = channelAdapter()
      const r = await admin(db => a.sendText(db, { orgId: m.orgId, audience: 'crew', recipientRef: who.id, toPhone: who.phone!, dedupeKey: `crew:${m.dedupeKey}`, body }))
      // the stored crew log never keeps a working link
      const row = await logRow('text', null, body.replace(/https?:\/\/\S+\/crew\/done\/\S+/g, '[link]'), r.status, r.reason, { outbox: r.id })
      if (row) results.push({ channel: 'text', id: row.id, status: r.status })
    } catch (e) {
      const row = await logRow('text', null, '(not sent)', 'failed', (e as Error).message, {})
      if (row) results.push({ channel: 'text', id: row.id, status: 'failed' })
    }
  }
  if (!results.length) {
    const row = await logRow('email', null, '(nothing sent)', 'skipped', 'this crew member has no way to be reached', {})
    return { status: 'skipped', id: row?.id ?? null, reason: 'this crew member has no way to be reached' }
  }
  const status: NotifyResult['status'] = results.some(r => r.status === 'sent') ? 'sent' : results.some(r => r.status === 'held' || r.status === 'simulated') ? 'held' : 'failed'
  return { status, id: results[0].id }
}

/** The owner's "send today's jobs now" for one crew member (a fresh message each time it is asked for). */
export async function sendTodayAsOwner(actor: Actor, crewMemberId: string, now = new Date()): Promise<NotifyResult> {
  const orgId = orgOf(actor)
  if (!ID.test(crewMemberId)) throw new EngineError('invalid_input', 'a crew member id is required')
  await assertCan(actor, orgId, 'settings')
  return notifyCrewImpl({ orgId, crewMemberId, jobRef: '', subject: '', body: '', dedupeKey: `owner-send:${crewMemberId}:${now.toISOString()}` }, { now })
}
