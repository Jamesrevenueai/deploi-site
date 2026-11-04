/**
 * Webhook-driven targeted rescans, debounced. Shopify sends bursts (an order touches every variant's
 * inventory level; a product save fires products/update and inventory_items/update together), so each
 * webhook only records the record ids to re-read. The ids of one connection collapse into one row each;
 * a row becomes due `debounceMs` after its latest webhook, and never later than `maxDelayMs` after its
 * first. The webhook then waits out the debounce and flushes what is due; the hourly scheduler flushes
 * anything left (a function that ended early, a failed rescan). Re-reading is always safe: it only
 * updates issues and settles proposals, it never writes to the store.
 */
import { admin, type Db } from '../../db'
import { runScan } from '../../engine/scan'
import { log } from '../../log'

const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d }

export const rescanConfig = {
  /** quiet time after the latest webhook for a record before it is re-read (0 in the test runner) */
  get debounceMs() { return num('SHOPIFY_WEBHOOK_DEBOUNCE_MS', process.env.VITEST ? 0 : 15_000) },
  /** a record that keeps changing is still re-read this long after its first webhook */
  get maxDelayMs() { return num('SHOPIFY_WEBHOOK_MAX_DELAY_MS', 120_000) },
  /** ids per targeted scan */
  batch: 100,
  /** a failed rescan is retried after this long */
  retryMs: 5 * 60e3,
}

/** Record ids to re-read for a connection. Returns how many were new (not already waiting). */
export async function enqueueRescan(db: Db, connectionId: string, ids: string[], topic: string): Promise<number> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return 0
  const rows = await db.query<{ inserted: boolean }>(
    `insert into shopify_rescan_queue (connection_id, resource_id, due_at, topics)
     select $1, id, now() + ($3 || ' milliseconds')::interval, array[$4] from unnest($2::text[]) as id
     on conflict (connection_id, resource_id) do update set
       due_at = least(shopify_rescan_queue.first_seen_at + ($5 || ' milliseconds')::interval, excluded.due_at),
       hits = shopify_rescan_queue.hits + 1,
       topics = array(select distinct unnest(shopify_rescan_queue.topics || excluded.topics))
     returning (xmax = 0) as inserted`,
    [connectionId, unique, String(rescanConfig.debounceMs), topic, String(rescanConfig.maxDelayMs)])
  return rows.filter(r => r.inserted).length
}

export type FlushResult = { connectionId: string; ids: number; status: 'scanned' | 'skipped' | 'failed'; reason?: string }

/**
 * Re-read every due record (of one connection, or of all). Rows are claimed by deleting them, so two
 * flushes never read the same record twice; a failed read puts its ids back for a later retry.
 */
export async function flushRescans(opts: { connectionId?: string; actor?: string } = {}): Promise<FlushResult[]> {
  const claimed = await admin(db => db.query<{ connection_id: string; resource_id: string; status: string }>(
    `with due as (
       select q.connection_id, q.resource_id from shopify_rescan_queue q
       where q.due_at <= now() and ($1::uuid is null or q.connection_id = $1) order by q.due_at limit 2000 for update skip locked)
     delete from shopify_rescan_queue q using due, store_connections c
     where q.connection_id = due.connection_id and q.resource_id = due.resource_id and c.id = q.connection_id
     returning q.connection_id, q.resource_id, c.status`, [opts.connectionId ?? null]))
  const byConn = new Map<string, { status: string; ids: string[] }>()
  for (const r of claimed) { const e = byConn.get(r.connection_id) ?? { status: r.status, ids: [] }; e.ids.push(r.resource_id); byConn.set(r.connection_id, e) }
  const out: FlushResult[] = []
  for (const [connectionId, { status, ids }] of byConn) {
    if (status !== 'active') { out.push({ connectionId, ids: ids.length, status: 'skipped', reason: `the connection is ${status}` }); continue }
    try {
      for (let i = 0; i < ids.length; i += rescanConfig.batch)
        await runScan(connectionId, { trigger: 'webhook', resourceIds: ids.slice(i, i + rescanConfig.batch), actor: opts.actor ?? 'shopify:webhook:rescan' })
      out.push({ connectionId, ids: ids.length, status: 'scanned' })
    } catch (e) {
      const reason = (e as Error).message.slice(0, 200)
      log.warn('shopify.rescan.failed', { connection_id: connectionId, error: reason })
      await admin(db => db.query(
        `insert into shopify_rescan_queue (connection_id, resource_id, due_at, topics) select $1, id, now() + ($3 || ' milliseconds')::interval, array['retry'] from unnest($2::text[]) as id
         on conflict (connection_id, resource_id) do nothing`, [connectionId, ids, String(rescanConfig.retryMs)])).catch(() => undefined)
      out.push({ connectionId, ids: ids.length, status: 'failed', reason })
    }
  }
  return out
}
