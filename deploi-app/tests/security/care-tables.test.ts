/**
 * The retired consulting service left 34 tables in the database. They are archived, not dropped
 * (scripts/archive-care-tables.ts), so no code may read or write them any more.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CARE_TABLES, KEEP_TABLES } from '../../scripts/archive-care-tables'

const ROOT = join(__dirname, '..', '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (['node_modules', '.next', 'proof', 'docs', 'supabase', 'test-results', 'playwright-report', '.storage'].includes(n)) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.(ts|tsx|mjs|js|sh|sql)$/.test(n)) out.push(p)
  }
  return out
}

describe('retired care tables', () => {
  it('the care list and the keep list never overlap', () => {
    for (const t of KEEP_TABLES) expect((CARE_TABLES as readonly string[]).includes(t), t).toBe(false)
  })

  it('together they are exactly the tables the consulting migrations (up to 20261021000027) created', () => {
    const created = new Set<string>()
    for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') && f.slice(0, 14) <= '20261021000027')) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '')
      for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_0-9]+)/gi)) created.add(m[1].toLowerCase())
    }
    expect([...created].sort()).toEqual([...CARE_TABLES, ...KEEP_TABLES].sort())
  })

  it('no application code, script or test reads or writes a care table', () => {
    const skip = /(archive-care-tables|archive-rehearsal-seed|test-archive-care-tables)\.|tests\/security\/care-tables\.test\.ts$/
    const offenders: string[] = []
    for (const f of files(ROOT)) {
      const rel = relative(ROOT, f)
      if (skip.test(rel)) continue
      const text = readFileSync(f, 'utf8')
      for (const t of CARE_TABLES) {
        if (new RegExp(`\\b(from|join|into|update|truncate|delete\\s+from)\\s+(public\\.)?${t}\\b`, 'i').test(text)) offenders.push(`${rel}: ${t}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
