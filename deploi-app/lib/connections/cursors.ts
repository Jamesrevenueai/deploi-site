/** Where each change poll or delta query of a connection stopped (connection_sync_cursors). Server code only. */
import type { Db } from '../db'

export type Cursor = { sync_position: string | null; last_polled_at: string | null; last_changes: number; last_error_code: string | null }

export async function readCursor(db: Db, connectionId: string, stream: string): Promise<Cursor | null> {
  return db.one<Cursor>('select sync_position, last_polled_at, last_changes, last_error_code from connection_sync_cursors where connection_id = $1 and stream = $2', [connectionId, stream])
}

export async function saveCursor(db: Db, c: { orgId: string; connectionId: string; stream: string; position: string | null; changes: number; errorCode?: string | null; at?: Date }) {
  await db.query(`insert into connection_sync_cursors (org_id, connection_id, stream, sync_position, last_polled_at, last_changes, last_error_code, updated_at) values ($1,$2,$3,$4,$5,$6,$7, now())
    on conflict (connection_id, stream) do update set sync_position = coalesce(excluded.sync_position, connection_sync_cursors.sync_position), last_polled_at = excluded.last_polled_at,
    last_changes = excluded.last_changes, last_error_code = excluded.last_error_code, updated_at = now()`,
    [c.orgId, c.connectionId, c.stream, c.position, (c.at ?? new Date()).toISOString(), c.changes, c.errorCode ?? null])
}

export async function deleteCursors(db: Db, connectionId: string) {
  await db.query('delete from connection_sync_cursors where connection_id = $1', [connectionId])
}
