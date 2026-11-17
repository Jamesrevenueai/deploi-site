/** Raw connection as the database owner for catalog introspection in the security tests (never in app code). */
import { Client } from 'pg'

export async function withOwner<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}

export type TablePolicy = { table: string; rls: boolean; policies: { name: string; cmd: string; roles: string[]; qual: string | null; check: string | null }[] }

export async function publicTables(c: Client): Promise<TablePolicy[]> {
  const t = await c.query<{ relname: string; relrowsecurity: boolean }>(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') order by 1`)
  const p = await c.query<{ relname: string; polname: string; polcmd: string; roles: string[]; qual: string | null; chk: string | null }>(
    `select c.relname, p.polname, p.polcmd::text, array(select case when r = 0 then 'public' else (select rolname from pg_roles where oid = r) end from unnest(p.polroles) r) as roles,
            pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as chk
     from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`)
  return t.rows.map(r => ({ table: r.relname, rls: r.relrowsecurity, policies: p.rows.filter(x => x.relname === r.relname).map(x => ({ name: x.polname, cmd: x.polcmd, roles: x.roles, qual: x.qual, check: x.chk })) }))
}

/** org-scoped: a read policy that limits rows to the caller's organization; returns that column. */
export function orgColumn(t: TablePolicy): string | null {
  for (const p of t.policies) {
    const q = p.qual ?? ''
    if (/\borg_id = current_org_id\(\)/.test(q)) return 'org_id'
    if (/\bagency_id = current_agency_id\(\)/.test(q)) return 'agency_id'
  }
  return null
}
