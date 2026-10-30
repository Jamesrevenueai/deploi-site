/**
 * Runs SQL on a Supabase project through the Management API (HTTPS only).
 * Used where raw Postgres ports are unreachable. Parameters are interpolated as
 * properly escaped literals so the seed's parameterized queries work unchanged.
 */
import { config } from 'dotenv'
config({ quiet: true }); config({ path: '.env.local', override: true, quiet: true })

// Without a token the request goes out unauthenticated, for a network proxy that adds the header itself.
const authHeader = (): Record<string, string> => process.env.SUPABASE_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` } : {}
export const projectRef = () => (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/^https?:\/\//, '').split('.')[0]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** One request per call; retries on 429/5xx with backoff (the API allows roughly one request per second). */
export async function managementQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return managementQueryFor<T>(projectRef(), sql)
}

export async function managementQueryFor<T = Record<string, unknown>>(ref: string, sql: string): Promise<T[]> {
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error(`not a Supabase project ref: ${ref}`)
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST', headers: { ...authHeader(), 'content-type': 'application/json' }, body: JSON.stringify({ query: sql }),
    })
    const text = await res.text()
    if (res.ok) { try { const j = JSON.parse(text); return Array.isArray(j) ? j : [] } catch { return [] } }
    if ((res.status === 429 || res.status >= 500) && attempt < 8) { await sleep(Math.min(30000, 2000 * 2 ** attempt)); continue }
    throw new Error(`management query failed ${res.status}: ${text.slice(0, 400)}`)
  }
}

export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(literal).join(',')}]::text[]` : `'{}'`
  const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")
  return `E'${s}'`
}

export function interpolate(text: string, params: unknown[] = []): string {
  return text.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]))
}

/** pg.Client-compatible subset: connect / query(text, params) / end. */
export class HttpSqlClient {
  private buffer: string[] = []
  constructor(private batchSize = 120) {}
  async connect() {}
  async end() { await this.flush() }
  /** Writes are buffered and sent in one transaction per batch; reads flush first. */
  async flush() {
    if (!this.buffer.length) return
    const stmts = this.buffer.splice(0)
    await managementQuery(`begin;\n${stmts.join(';\n')};\ncommit;`)
  }
  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const sql = interpolate(text, params)
    if (/^\s*(insert|update|delete)\b/i.test(sql) && !/\breturning\b/i.test(sql)) {
      this.buffer.push(sql)
      if (this.buffer.length >= this.batchSize) await this.flush()
      return { rows: [] as T[], rowCount: 0 }
    }
    await this.flush()
    const rows = await managementQuery<T>(sql)
    return { rows, rowCount: rows.length }
  }
}
