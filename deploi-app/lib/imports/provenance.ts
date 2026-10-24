/**
 * Import provenance: content hashes ("already imported"), the import log rows, and the last-successful-import
 * freshness flag shown on /staff/evv and the actions pages.
 */
import type { Db } from '../db'
import { staleAfterDays } from './config'
import type { ImportKind } from './specs'
import type { RowError } from './validate'

export const ALREADY_IMPORTED = 'already imported'

const tableFor = (kind: ImportKind) => (kind === 'evv_visits' ? 'evv_imports' : 'imports')
const kindClause = (kind: ImportKind, p: number) => (kind === 'evv_visits' ? '' : `and kind = $${p}`)

/** A committed import of the same content for this agency, if any. */
export async function findPriorImport(db: Db, kind: ImportKind, agencyId: string, sha: string): Promise<{ id: string; created_at: string; filename: string | null } | null> {
  const params: unknown[] = [agencyId, sha]
  if (kind !== 'evv_visits') params.push(kind)
  const r = await db.one<{ id: string; created_at: Date | string; filename: string | null }>(
    `select id, created_at, filename from ${tableFor(kind)} where agency_id = $1 and file_sha256 = $2 and status = 'committed' ${kindClause(kind, 3)} order by created_at desc limit 1`, params)
  return r ? { ...r, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) } : null
}

/** Record a rejected re-import of identical content so the history shows what happened. */
export async function recordAlreadyImported(db: Db, kind: ImportKind, agencyId: string, info: { filename: string | null; sha: string; rowCount: number; createdBy: string | null; priorId: string }): Promise<string> {
  const notice = `${ALREADY_IMPORTED} (identical to import ${info.priorId.slice(0, 8)})`
  if (kind === 'evv_visits') {
    const r = await db.one<{ id: string }>(
      `insert into evv_imports (agency_id, source, filename, status, row_count, file_sha256, notice, created_by, committed_at) values ($1,'generic',$2,'already_imported',$3,$4,$5,$6, now()) returning id`,
      [agencyId, info.filename, info.rowCount, info.sha, notice, info.createdBy])
    return r!.id
  }
  const r = await db.one<{ id: string }>(
    `insert into imports (agency_id, kind, filename, status, row_count, file_sha256, notice, created_by, committed_at) values ($1,$2,$3,'already_imported',$4,$5,$6,$7, now()) returning id`,
    [agencyId, kind, info.filename, info.rowCount, info.sha, notice, info.createdBy])
  return r!.id
}

export type ImportFreshness = { kind: ImportKind; at: string | null; days: number | null; stale: boolean; thresholdDays: number; filename: string | null }

/** Last committed import of a kind for an agency and whether it is older than the configured staleness. */
export async function lastSuccessfulImport(db: Db, kind: ImportKind, agencyId: string, now = new Date()): Promise<ImportFreshness> {
  const params: unknown[] = [agencyId]
  if (kind !== 'evv_visits') params.push(kind)
  const r = await db.one<{ at: Date | string; filename: string | null }>(
    `select coalesce(committed_at, created_at) as at, filename from ${tableFor(kind)} where agency_id = $1 and status = 'committed' ${kindClause(kind, 2)} order by coalesce(committed_at, created_at) desc limit 1`, params)
  const thresholdDays = staleAfterDays(kind)
  if (!r) return { kind, at: null, days: null, stale: true, thresholdDays, filename: null }
  const at = r.at instanceof Date ? r.at : new Date(r.at)
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000)
  return { kind, at: at.toISOString(), days, stale: days > thresholdDays, thresholdDays, filename: r.filename }
}

export const MAX_STORED_ERRORS = 500
export function trimErrors(errors: RowError[]): RowError[] { return errors.slice(0, MAX_STORED_ERRORS) }
