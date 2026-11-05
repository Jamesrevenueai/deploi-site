/**
 * Synthetic HubSpot and Google Calendar for tests and demos. Stateful (office_synthetic_state, one row
 * per synthetic connection), entirely inside Deploi: nothing leaves the machine. A synthetic connection
 * is flagged is_synthetic and is never mixed with real providers (an agent may not combine a synthetic
 * connection with a real one, or a synthetic CRM with a real mailbox). Faults can be injected to test
 * rate limits, server errors and answers lost after the write happened.
 */
import { randomBytes } from 'node:crypto'
import { admin } from '../db'
import { encryptSecret } from '../connectors/credentials'
import { OfficeHttpError } from './http'
import type { BusyInterval, CalendarApi, CalendarEvent, HubSpotApi, HubSpotContact } from './types'

export type SynthFault = { op: string; mode: 'rate_limited' | 'server_error' | 'timeout_after_write' | 'timeout_before_write' | 'auth'; remaining: number }
export type SynthContact = HubSpotContact & { dealIds?: string[] }
export type SynthOffice = {
  nextId: number
  contacts: SynthContact[]
  notes: { id: string; contactId: string; body: string; timestamp: string }[]
  tasks: { id: string; contactId: string; subject: string; body: string; dueAt: string }[]
  deals: { id: string; stage: string; contactIds: string[] }[]
  busy: BusyInterval[]
  events: (CalendarEvent & { description: string; timeZone: string })[]
  faults: SynthFault[]
  /** every call, in order (op name only), so tests can assert what was and was not done */
  calls: string[]
}
const empty = (): SynthOffice => ({ nextId: 1000, contacts: [], notes: [], tasks: [], deals: [], busy: [], events: [], faults: [], calls: [] })

export async function getOfficeSynth(connectionId: string): Promise<SynthOffice> {
  return admin(async db => ({ ...empty(), ...((await db.one<{ state: SynthOffice }>('select state from office_synthetic_state where connection_id = $1', [connectionId]))?.state ?? {}) }))
}

export async function mutateOfficeSynth<T>(connectionId: string, fn: (s: SynthOffice) => T): Promise<T> {
  return admin(async db => {
    const row = await db.one<{ state: SynthOffice; org_id: string }>('select state, org_id from office_synthetic_state where connection_id = $1 for update', [connectionId])
    const s = { ...empty(), ...(row?.state ?? {}) }
    const out = fn(s)
    if (row) await db.query('update office_synthetic_state set state = $2, updated_at = now() where connection_id = $1', [connectionId, JSON.stringify(s)])
    else {
      const c = await db.one<{ org_id: string }>('select org_id from office_connections where id = $1 and is_synthetic', [connectionId])
      if (!c) throw new Error('not a synthetic office connection')
      await db.query('insert into office_synthetic_state (connection_id, org_id, state) values ($1,$2,$3)', [connectionId, c.org_id, JSON.stringify(s)])
    }
    return out
  })
}

export const injectOfficeFault = (connectionId: string, f: Omit<SynthFault, 'remaining'> & { remaining?: number }) =>
  mutateOfficeSynth(connectionId, s => { s.faults.push({ remaining: 1, ...f }) })

export function synthContact(id: string, email: string, extra: Partial<SynthContact> = {}): SynthContact {
  const now = new Date().toISOString()
  return { id, email: email.toLowerCase(), firstName: null, lastName: null, company: null, lifecycleStage: 'lead', optedOut: false, createdAt: now, updatedAt: now, ...extra }
}

/** Demo data for a fresh synthetic HubSpot: two leads on reserved example domains. */
export function demoContacts(now = new Date()): SynthContact[] {
  const at = new Date(now.getTime() - 3600e3).toISOString()
  return [
    synthContact('501', 'maya.chen@brightpath.example', { firstName: 'Maya', lastName: 'Chen', company: 'Brightpath Studio', createdAt: at, updatedAt: at }),
    synthContact('502', 'liam.okafor@harborline.example', { firstName: 'Liam', lastName: 'Okafor', company: 'Harborline Logistics', createdAt: at, updatedAt: at }),
  ]
}

function step(s: SynthOffice, op: string): { mode: SynthFault['mode'] } | null {
  s.calls.push(op)
  const f = s.faults.find(x => (x.op === op || x.op === '*') && x.remaining > 0)
  if (!f) return null
  f.remaining--
  s.faults = s.faults.filter(x => x.remaining > 0)
  return { mode: f.mode }
}

type P = 'hubspot' | 'google_calendar'
function fail(provider: P, mode: SynthFault['mode']): never {
  if (mode === 'rate_limited') throw new OfficeHttpError(429, 'rate_limited', 'rate limited (synthetic)', provider)
  if (mode === 'server_error') throw new OfficeHttpError(503, 'server', 'server error (synthetic)', provider)
  if (mode === 'auth') throw new OfficeHttpError(401, 'auth', 'token rejected (synthetic)', provider)
  throw new OfficeHttpError(0, 'network', 'no response from the provider (synthetic)', provider)
}

/**
 * Run one synthetic call. Faults: rate_limited / server_error / auth / timeout_before_write fail without
 * effect; timeout_after_write applies the write and then loses the answer (an uncertain outcome).
 */
async function synthCall<T>(connectionId: string, provider: P, op: string, fn: (s: SynthOffice) => T): Promise<T> {
  const r = await mutateOfficeSynth(connectionId, s => {
    const f = step(s, op)
    if (f && f.mode !== 'timeout_after_write') return { fault: f.mode }
    const value = fn(s)
    return f ? { fault: f.mode, value } : { value }
  })
  if ('fault' in r && r.fault) fail(provider, r.fault)
  return (r as { value: T }).value
}

const tokenContains = (body: string, marker: string) => body.split(/[^\w:-]+/).includes(marker)

export function syntheticHubSpot(connectionId: string): HubSpotApi {
  const call = <T>(op: string, fn: (s: SynthOffice) => T) => synthCall(connectionId, 'hubspot', op, fn)
  const nid = (s: SynthOffice) => String(s.nextId++)
  const strip = (c: SynthContact): HubSpotContact => { const { dealIds: _d, ...rest } = c; void _d; return rest }
  return {
    searchLeads: ({ since, after, limit }) => call('searchLeads', s => {
      const all = s.contacts.filter(c => c.lifecycleStage === 'lead' && new Date(c.updatedAt ?? 0).getTime() >= since.getTime())
        .sort((a, b) => new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime() || Number(a.id) - Number(b.id))
      const start = after ? Number(after) : 0
      const page = all.slice(start, start + limit)
      return { contacts: page.map(strip), next: start + limit < all.length ? String(start + limit) : null }
    }),
    getContact: id => call('getContact', s => { const c = s.contacts.find(x => x.id === id); return c ? strip(c) : null }),
    updateContact: (id, props) => call('updateContact', s => {
      const c = s.contacts.find(x => x.id === id)
      if (!c) throw new OfficeHttpError(404, 'not_found', 'contact not found (synthetic)', 'hubspot')
      if (props.lifecyclestage !== undefined) c.lifecycleStage = props.lifecyclestage
      if (props.hs_email_optout !== undefined) c.optedOut = props.hs_email_optout === 'true'
      c.updatedAt = new Date().toISOString()
      return strip(c)
    }),
    createNote: ({ contactId, body, timestamp }) => call('createNote', s => { const id = nid(s); s.notes.push({ id, contactId, body, timestamp: timestamp.toISOString() }); return { id } }),
    getNote: id => call('getNote', s => { const n = s.notes.find(x => x.id === id); return n ? { id: n.id, body: n.body } : null }),
    findNoteByMarker: marker => call('findNoteByMarker', s => { const n = s.notes.find(x => tokenContains(x.body, marker)); return n ? { id: n.id } : null }),
    createTask: ({ contactId, subject, body, dueAt }) => call('createTask', s => { const id = nid(s); s.tasks.push({ id, contactId, subject, body, dueAt: dueAt.toISOString() }); return { id } }),
    getTask: id => call('getTask', s => { const t = s.tasks.find(x => x.id === id); return t ? { id: t.id, body: t.body } : null }),
    findTaskByMarker: marker => call('findTaskByMarker', s => { const t = s.tasks.find(x => tokenContains(x.body, marker)); return t ? { id: t.id } : null }),
    listContactDeals: contactId => call('listContactDeals', s => s.deals.filter(d => d.contactIds.includes(contactId)).map(d => d.id)),
    getDeal: id => call('getDeal', s => { const d = s.deals.find(x => x.id === id); return d ? { id: d.id, stage: d.stage } : null }),
    updateDealStage: (id, stage) => call('updateDealStage', s => {
      const d = s.deals.find(x => x.id === id)
      if (!d) throw new OfficeHttpError(404, 'not_found', 'deal not found (synthetic)', 'hubspot')
      d.stage = stage
      return { id: d.id, stage: d.stage }
    }),
  }
}

export function syntheticCalendar(connectionId: string): CalendarApi {
  const call = <T>(op: string, fn: (s: SynthOffice) => T) => synthCall(connectionId, 'google_calendar', op, fn)
  const pub = (e: SynthOffice['events'][number]): CalendarEvent => ({ id: e.id, status: e.status, summary: e.summary, start: e.start, end: e.end, attendees: e.attendees, meetLink: e.meetLink, htmlLink: e.htmlLink })
  return {
    freeBusy: ({ timeMin, timeMax }) => call('freeBusy', s => {
      const lo = new Date(timeMin).getTime(), hi = new Date(timeMax).getTime()
      const own = s.events.filter(e => e.status !== 'cancelled').map(e => ({ start: e.start, end: e.end }))
      return [...s.busy, ...own].filter(b => new Date(b.end).getTime() > lo && new Date(b.start).getTime() < hi)
    }),
    insertEvent: e => call('insertEvent', s => {
      const existing = s.events.find(x => x.id === e.id)
      if (existing) return pub(existing) // the same id twice: the real API answers 409 and the client reads the event back
      const ev = { id: e.id, status: 'confirmed' as const, summary: e.summary, description: e.description, timeZone: e.timeZone, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(),
        attendees: e.attendees.map(a => a.toLowerCase()), meetLink: e.meet ? `https://meet.google.com/syn-${randomBytes(3).toString('hex')}` : null, htmlLink: `https://calendar.google.com/calendar/event?eid=${e.id}` }
      s.events.push(ev)
      return pub(ev)
    }),
    getEvent: id => call('getEvent', s => { const e = s.events.find(x => x.id === id); return e ? pub(e) : null }),
    patchEvent: (id, p) => call('patchEvent', s => {
      const e = s.events.find(x => x.id === id)
      if (!e || e.status === 'cancelled') throw new OfficeHttpError(404, 'not_found', 'event not found (synthetic)', 'google_calendar')
      e.start = new Date(p.start).toISOString(); e.end = new Date(p.end).toISOString()
      return pub(e)
    }),
    deleteEvent: id => call('deleteEvent', s => {
      const e = s.events.find(x => x.id === id)
      if (!e || e.status === 'cancelled') return 'already_gone' as const
      e.status = 'cancelled'
      return 'deleted' as const
    }),
  }
}

/** Create a synthetic connection's encrypted placeholder credential, so the token path is the same as for real ones. */
export function syntheticToken(provider: P) {
  return { accessToken: `synthetic-${provider}:${randomBytes(8).toString('hex')}`, refreshToken: `synthetic-refresh-${provider}`, expiresIn: 3600, scopes: ['synthetic'] }
}

/**
 * Tests and demos: deliver an inbound email to a SYNTHETIC mailbox exactly as the inbound webhook stores it
 * (encrypted content, threaded to our message, accepted only from a recipient of that thread or a member).
 */
export async function injectSyntheticInbound(input: { accountId: string; from: string; subject: string; text: string; threadMessageId?: string | null; receivedAt?: Date; autoReply?: string | null }) {
  return admin(async db => {
    const acc = await db.one<{ id: string; org_id: string; is_synthetic: boolean }>('select id, org_id, is_synthetic from email_accounts where id = $1', [input.accountId])
    if (!acc?.is_synthetic) throw new Error('inbound can be injected only into a synthetic mailbox')
    const from = input.from.trim().toLowerCase()
    const thread = input.threadMessageId ? await db.one<{ id: string; to_addresses: string[]; cc_addresses: string[] }>('select id, to_addresses, cc_addresses from email_messages where id = $1 and account_id = $2', [input.threadMessageId, acc.id]) : null
    const member = await db.one('select id from profiles where agency_id = $1 and lower(email) = $2', [acc.org_id, from])
    const allowed = Boolean(member) || Boolean(thread && [...thread.to_addresses, ...thread.cc_addresses].includes(from))
    const at = (input.receivedAt ?? new Date()).toISOString()
    // an automatic reply (out of office, delivery report) is stored like the inbound webhook stores it: kept, never counted as a reply
    const row = (await db.one<{ id: string }>(`insert into email_inbound (org_id, account_id, agent_id, provider_email_id, internet_message_id, from_address, to_addresses, cc_addresses, classification, status, status_reason,
        thread_message_id, auth_results, key_id, content_ciphertext, attachment_count, received_at, auto_reply, auto_reply_reason)
      values ($1,$2,null,$3,$4,$5,'{}','{}',$6,$7,$8,$9,'{}','pending','pending',0,$10,$11,$12) returning id`,
      [acc.org_id, acc.id, `syn-in-${randomBytes(6).toString('hex')}`, `<syn-${randomBytes(6).toString('hex')}@synthetic.example>`, from, thread ? 'reply' : member ? 'merchant_forward' : 'other',
        allowed ? 'accepted' : 'quarantined', allowed ? null : "the sender is not on this agent's allowed list", thread?.id ?? null, at, Boolean(input.autoReply), input.autoReply ?? null]))!
    const enc = encryptSecret(JSON.stringify({ subject: input.subject.slice(0, 500), text: input.text.slice(0, 100_000) }), `email-inbound:${row.id}`)
    await db.query('update email_inbound set key_id = $2, content_ciphertext = $3 where id = $1', [row.id, enc.keyId, enc.ciphertext])
    if (thread && allowed && !input.autoReply) await db.query('update email_messages set reply_count = reply_count + 1, reply_seen_at = greatest(coalesce(reply_seen_at, $2), $2) where id = $1', [thread.id, at])
    return { inboundId: row.id, status: allowed ? 'accepted' as const : 'quarantined' as const }
  })
}
