/**
 * Change polling for connections without push: every CRM (people created or changed), QuickBooks (the change data
 * capture feed: invoices and payments) and Buildium (work orders, leases, rental applications, resident requests),
 * plus the Outlook calendar delta. Each stream keeps its own position (connection_sync_cursors); every change becomes
 * one agent event (lib/connections/events.ts), deduped on the record id and its version (updated time), so a change
 * read twice reaches the agents once. A position moves only after its changes are recorded; a failed poll keeps the
 * old position and records the error code (a 401 has already been retried with a refreshed token by the client).
 *
 * The `connections.poll` job runs every ten minutes (queued by enqueueDueWork); a stream is polled at most every
 * POLL_EVERY_MS. The first poll of a stream looks back FIRST_LOOKBACK_MS only.
 */
import { admin } from '../db'
import { enqueue, registerJobHandler } from '../jobs/queue'
import { log } from '../log'
import { OfficeHttpError } from '../office/http'
import { OfficeAuthError } from '../office/credentials'
import { isCrmProvider } from '../office/config'
import type { OfficeConnectionRow } from '../office/connections'
import { buildiumFor, crmFor, quickbooksWriterFor } from '../office/providers'
import type { CrmClient } from '../crm/types'
import type { BuildiumApi } from '../buildium/client'
import type { QuickBooksFullApi } from '../office/quickbooks'
import { readCursor, saveCursor } from './cursors'
import { emitConnectionEvent, type ConnectionEvent } from './events'
import { syncOutlookCalendar } from '../outlook/calendar'

export const POLL_EVERY_MS = 10 * 60_000
export const FIRST_LOOKBACK_MS = 24 * 3600e3
const MAX_PAGES = 5

type Change = Omit<ConnectionEvent, 'orgId' | 'connectionId' | 'source'>
type StreamResult = { changes: Change[]; position: string }
type Stream = { name: string; source: ConnectionEvent['source']; run: (since: Date, position: string | null) => Promise<StreamResult> }

const later = (a: string | null | undefined, b: string) => (a && a > b ? a : b)

/** Streams of one connection, with the client for it (tests pass their own clients). */
export function streamsFor(c: OfficeConnectionRow, clients: { crm?: CrmClient; buildium?: BuildiumApi; quickbooks?: QuickBooksFullApi } = {}): Stream[] {
  if (c.is_synthetic) return []
  if (isCrmProvider(c.provider)) {
    const crm = clients.crm ?? crmFor(c)
    return [{ name: 'crm.contacts', source: 'crm', run: async since => {
      const changes: Change[] = []
      let page: string | null = null, max = since.toISOString()
      for (let n = 0; n < MAX_PAGES; n++) {
        const r = await crm.listChangedContacts({ since, page, limit: 100 })
        for (const p of r.contacts) {
          const v = p.updatedAt ?? since.toISOString()
          max = later(p.updatedAt ? new Date(p.updatedAt).toISOString() : null, max)
          changes.push({ type: 'crm.contact.changed', externalId: `${c.provider}:${p.kind}:${p.id}:${v}`, occurredAt: new Date(v).toISOString(), payload: { provider: c.provider, connectionId: c.id, contact: p } })
        }
        if (!r.next) break
        page = r.next
      }
      return { changes, position: max }
    } }]
  }
  if (c.provider === 'quickbooks') {
    const qb = clients.quickbooks ?? quickbooksWriterFor(c)
    return [{ name: 'quickbooks.cdc', source: 'quickbooks', run: async since => {
      const started = new Date().toISOString()
      const changes = (await qb.changes(since)).map(x => ({ type: x.entity === 'Invoice' ? 'invoice.changed' : 'payment.changed', externalId: `${x.entity.toLowerCase()}:${x.id}:${x.updatedAt ?? 'deleted'}`,
        occurredAt: x.updatedAt ? new Date(x.updatedAt).toISOString() : started, payload: { connectionId: c.id, realmId: c.external_account_id, entity: x.entity, id: x.id, deleted: x.deleted } }))
      return { changes, position: started }
    } }]
  }
  if (c.provider === 'buildium') {
    const b = clients.buildium ?? buildiumFor(c)
    const recs = (name: string, type: string, read: (since: Date) => Promise<{ id: string; updatedAt: string | null; [k: string]: unknown }[]>): Stream => ({ name, source: 'buildium', run: async since => {
      let max = since.toISOString()
      const rows = await read(since)
      const changes = rows.map(r => { const v = r.updatedAt ?? since.toISOString(); max = later(r.updatedAt ? new Date(r.updatedAt).toISOString() : null, max)
        return { type, externalId: `${name}:${r.id}:${v}`, occurredAt: new Date(v).toISOString(), payload: { connectionId: c.id, record: r } } })
      return { changes, position: max }
    } })
    return [
      recs('buildium.workorders', 'buildium.workorder.changed', since => b.listWorkOrders({ updatedSince: since, limit: 1000 })),
      recs('buildium.leases', 'buildium.lease.changed', since => b.listLeases({ updatedSince: since, limit: 1000 })),
      recs('buildium.residentrequests', 'buildium.request.changed', since => b.listResidentRequests({ updatedSince: since, limit: 1000 })),
      recs('buildium.applications', 'buildium.application.changed', async since => {
        const out: { id: string; updatedAt: string | null; applicantId: string; status: string | null }[] = []
        for (const a of await b.listApplicants({ updatedSince: since, limit: 200 })) out.push(...(await b.listApplications(a.id)).filter(x => !x.updatedAt || x.updatedAt >= since.toISOString().slice(0, 19)))
        return out
      }),
    ]
  }
  return []
}

export type PollOutcome = { stream: string; status: 'polled' | 'not_due' | 'failed'; changes: number; emitted: number; code?: string }

/** Poll every due stream of one connection. Never throws for a provider error: it is recorded on the stream. */
export async function pollConnection(c: OfficeConnectionRow, opts: { now?: Date; force?: boolean; clients?: Parameters<typeof streamsFor>[1] } = {}): Promise<PollOutcome[]> {
  const now = opts.now ?? new Date()
  const out: PollOutcome[] = []
  let streams: Stream[]
  try { streams = streamsFor(c, opts.clients) } catch (e) { log.warn('connections.poll_unavailable', { provider: c.provider, error: (e as Error).message.slice(0, 120) }); return [] }
  for (const s of streams) {
    const cur = await admin(db => readCursor(db, c.id, s.name))
    if (!opts.force && cur?.last_polled_at && now.getTime() - new Date(cur.last_polled_at).getTime() < POLL_EVERY_MS) { out.push({ stream: s.name, status: 'not_due', changes: 0, emitted: 0 }); continue }
    const since = cur?.sync_position && !Number.isNaN(Date.parse(cur.sync_position)) ? new Date(cur.sync_position) : new Date(now.getTime() - FIRST_LOOKBACK_MS)
    let r: StreamResult
    try { r = await s.run(since, cur?.sync_position ?? null) } catch (e) {
      const code = e instanceof OfficeAuthError ? 'auth' : e instanceof OfficeHttpError ? e.code : 'error'
      await admin(db => saveCursor(db, { orgId: c.org_id, connectionId: c.id, stream: s.name, position: null, changes: 0, errorCode: code, at: now }))
      out.push({ stream: s.name, status: 'failed', changes: 0, emitted: 0, code }); continue
    }
    let emitted = 0
    await admin(async db => {
      for (const ch of r.changes) if ((await emitConnectionEvent(db, { ...ch, source: s.source, orgId: c.org_id, connectionId: c.id })) === 'emitted') emitted++
      await saveCursor(db, { orgId: c.org_id, connectionId: c.id, stream: s.name, position: r.position, changes: r.changes.length, at: now })
    })
    out.push({ stream: s.name, status: 'polled', changes: r.changes.length, emitted })
  }
  return out
}

/** Every active, real connection that has a change stream, and every Microsoft 365 account with calendar access. */
export async function pollAllConnections(opts: { now?: Date; orgIds?: string[]; deadline?: number } = {}) {
  const rows = await admin(db => db.query<OfficeConnectionRow>(`select * from office_connections where status = 'active' and not is_synthetic and provider in ('hubspot','salesforce','pipedrive','zoho_crm','quickbooks','buildium')
    and ($1::uuid[] is null or org_id = any($1::uuid[])) order by connected_at`, [opts.orgIds ?? null]))
  const results: { connectionId: string; outcomes: PollOutcome[] }[] = []
  for (const c of rows) {
    if (opts.deadline && Date.now() > opts.deadline - 30_000) break
    results.push({ connectionId: c.id, outcomes: await pollConnection(c, { now: opts.now }) })
  }
  const accounts = await admin(db => db.query<{ id: string }>(`select id from email_accounts where provider = 'microsoft' and status = 'active' and 'Calendars.ReadWrite' = any(granted_scopes)
    and ($1::uuid[] is null or org_id = any($1::uuid[]))`, [opts.orgIds ?? null]))
  for (const a of accounts) {
    if (opts.deadline && Date.now() > opts.deadline - 30_000) break
    try { await syncOutlookCalendar(a.id) } catch (e) { log.warn('connections.calendar_sync_failed', { account_id: a.id, error: (e as Error).message.slice(0, 120) }) }
  }
  return results
}

registerJobHandler('connections.poll', async (_p, ctx) => ({ connections: (await pollAllConnections({ deadline: ctx.deadline })).length }), { agentWork: false, maxAttempts: 2, leaseMs: 10 * 60_000 })

/** Queue one poll per ten-minute window. */
export function enqueueConnectionPolls(now = new Date()) {
  return enqueue({ kind: 'connections.poll', idempotencyKey: `poll@${new Date(Math.floor(now.getTime() / 600e3) * 600e3).toISOString()}` })
}
