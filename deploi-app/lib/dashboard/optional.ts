/**
 * Guards for tables and columns that other build streams create in parallel (engagements, pilots,
 * website_engagements, website_labor, imports, proposed_actions.simulated). Every query against them
 * checks first and degrades to "not available yet" instead of failing the page.
 */
import type { Db } from '../db'

const SAFE = /^[a-z_][a-z0-9_]*$/

/** Test hook: pretend a table or `table.column` is absent (true) so the degrade path can be exercised on a full schema. */
export const PRETEND_MISSING = new Set<string>()

export async function tableExists(db: Db, table: string): Promise<boolean> {
  if (!SAFE.test(table) || PRETEND_MISSING.has(table)) return false
  const r = await db.one<{ ok: boolean }>('select to_regclass($1) is not null as ok', [`public.${table}`])
  return Boolean(r?.ok)
}

export async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  if (!SAFE.test(table) || !SAFE.test(column) || PRETEND_MISSING.has(table) || PRETEND_MISSING.has(`${table}.${column}`)) return false
  const r = await db.one<{ ok: boolean }>(
    "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2) as ok", [table, column])
  return Boolean(r?.ok)
}

/** Columns of a table (empty when it does not exist). Used to read parallel-stream rows defensively. */
export async function tableColumns(db: Db, table: string): Promise<Set<string>> {
  if (!SAFE.test(table) || PRETEND_MISSING.has(table)) return new Set()
  const rows = await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])
  return new Set(rows.map(r => r.column_name))
}

export const NOT_AVAILABLE = 'not available yet'

export const str = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key]
  return v === null || v === undefined ? null : String(v)
}
export const numOrNull = (row: Record<string, unknown>, key: string): number | null => {
  const v = row[key]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
