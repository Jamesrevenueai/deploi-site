/** The launch migration runner refuses production unless the operator names the exact project (owner approval). */
import { describe, it, expect } from 'vitest'
import { assertTargetAllowed, productionRef, LAUNCH } from '../../scripts/launch-migrations'

const POOLER = 'postgres://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
const DIRECT = 'postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'

describe('launch migrations: production guard', () => {
  it('covers exactly the launch migrations 28 to 34 (with store access and the agent library), in order', () => {
    expect(LAUNCH.map(f => f.slice(0, 14))).toEqual(['20261028000028', '20261028000029', '20261028000030', '20261028000031', '20261028000032', '20261029000032', '20261029000033', '20261029000034', '20261030000035'])
  })
  it('recognises Supabase pooler and direct hosts', () => {
    expect(productionRef(POOLER)).toBe('abcdefghijklmnopqrst')
    expect(productionRef(DIRECT)).toBe('abcdefghijklmnopqrst')
    expect(productionRef('postgres://postgres:postgres@127.0.0.1:5432/launch_copy')).toBeNull()
  })
  it('refuses production without, or with the wrong, --confirm-production', () => {
    expect(() => assertTargetAllowed(POOLER, [])).toThrow(/owner approval required/)
    expect(() => assertTargetAllowed(DIRECT, ['--confirm-production=someotherprojectref0'])).toThrow(/owner approval required/)
    expect(() => assertTargetAllowed('postgres://u:p@10.0.0.5:5432/db', [], { DEPLOI_ENV: 'production' })).toThrow(/production database/)
    expect(() => assertTargetAllowed(POOLER, ['--confirm-production=abcdefghijklmnopqrst'])).not.toThrow()
    expect(() => assertTargetAllowed('postgres://postgres:postgres@127.0.0.1:5432/launch_copy', [], {})).not.toThrow()
  })
})

describe('2026-11-04 release migration set', () => {
  it('lists exactly the 2026-11-04 migrations on disk, in order, each with a rollback, and needs the first launch applied', async () => {
    const { readdirSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { RELEASE_2026_11_04, SETS, setFrom, LAUNCH: FIRST } = await import('../../scripts/launch-migrations')
    const dir = join(__dirname, '..', '..', 'supabase')
    const onDisk = readdirSync(join(dir, 'migrations')).filter(f => f.startsWith('20261104')).sort()
    expect(RELEASE_2026_11_04).toEqual(onDisk)
    for (const f of RELEASE_2026_11_04) expect(existsSync(join(dir, 'rollback', f.replace(/\.sql$/, '.down.sql'))), f).toBe(true)
    expect(SETS['2026-11-04'].prereq).toBe(FIRST[FIRST.length - 1])
    expect(setFrom(['--set=2026-11-04']).files).toBe(RELEASE_2026_11_04)
    expect(setFrom([]).files).toBe(FIRST)
    expect(() => setFrom(['--set=nope'])).toThrow(/unknown migration set/)
  })
})

describe('2026-11-05 release migration set', () => {
  it('lists exactly the 2026-11-05 migrations on disk, in order, each with a rollback, and needs the 2026-11-04 release applied', async () => {
    const { readdirSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { RELEASE_2026_11_05, RELEASE_2026_11_04, SETS, setFrom } = await import('../../scripts/launch-migrations')
    const dir = join(__dirname, '..', '..', 'supabase')
    expect(RELEASE_2026_11_05).toEqual(readdirSync(join(dir, 'migrations')).filter(f => f.startsWith('20261105')).sort())
    for (const f of RELEASE_2026_11_05) expect(existsSync(join(dir, 'rollback', f.replace(/\.sql$/, '.down.sql'))), f).toBe(true)
    expect(SETS['2026-11-05'].prereq).toBe(RELEASE_2026_11_04[RELEASE_2026_11_04.length - 1])
    expect(setFrom(['--set=2026-11-05']).files).toBe(RELEASE_2026_11_05)
  })
})

describe('2026-11-06 release migration set', () => {
  it('lists exactly the 2026-11-06 migrations on disk, in order, each with a rollback, and needs the 2026-11-05 release applied', async () => {
    const { readdirSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { RELEASE_2026_11_06, RELEASE_2026_11_05, SETS, setFrom, laterApplied } = await import('../../scripts/launch-migrations')
    const dir = join(__dirname, '..', '..', 'supabase')
    expect(RELEASE_2026_11_06).toEqual(readdirSync(join(dir, 'migrations')).filter(f => f.startsWith('20261106')).sort())
    for (const f of RELEASE_2026_11_06) expect(existsSync(join(dir, 'rollback', f.replace(/\.sql$/, '.down.sql'))), f).toBe(true)
    expect(SETS['2026-11-06'].prereq).toBe(RELEASE_2026_11_05[RELEASE_2026_11_05.length - 1])
    expect(setFrom(['--set=2026-11-06']).files).toBe(RELEASE_2026_11_06)
    // 2026-11-05 cannot come off while 2026-11-06 is applied
    expect(laterApplied([...RELEASE_2026_11_05, RELEASE_2026_11_06[0]], SETS['2026-11-05'])).toEqual([RELEASE_2026_11_06[0]])
    // every migration on disk belongs to a release set (or is the separately applied F-02 hotfix / earlier history)
    const inSets = new Set(Object.values(SETS).flatMap(s => s.files))
    expect(readdirSync(join(dir, 'migrations')).filter(f => f > '20261031000001_signup_trust_hotfix.sql' && !inSets.has(f))).toEqual([])
  })
})

describe('2026-11-07 release migration set', () => {
  it('lists exactly the 2026-11-07 migrations on disk, in order, each with a rollback, and needs the 2026-11-06 release applied', async () => {
    const { readdirSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { RELEASE_2026_11_07, RELEASE_2026_11_06, SETS, setFrom, laterApplied } = await import('../../scripts/launch-migrations')
    const dir = join(__dirname, '..', '..', 'supabase')
    expect(RELEASE_2026_11_07).toEqual(readdirSync(join(dir, 'migrations')).filter(f => f.startsWith('20261107')).sort())
    for (const f of RELEASE_2026_11_07) expect(existsSync(join(dir, 'rollback', f.replace(/\.sql$/, '.down.sql'))), f).toBe(true)
    expect(SETS['2026-11-07'].prereq).toBe(RELEASE_2026_11_06[RELEASE_2026_11_06.length - 1])
    expect(setFrom(['--set=2026-11-07']).files).toBe(RELEASE_2026_11_07)
    expect(laterApplied([...RELEASE_2026_11_06, RELEASE_2026_11_07[0]], SETS['2026-11-06'])).toEqual([RELEASE_2026_11_07[0]])
  })
})

describe('release rollback order', () => {
  it('a release cannot be rolled back while a later one is applied', async () => {
    const { laterApplied, SETS } = await import('../../scripts/launch-migrations')
    const applied = ['20261030000035_role_switch_grants.sql', '20261031000001_signup_trust_hotfix.sql', ...SETS['2026-11-04'].files, '20261105000045_resolution_engine.sql']
    expect(laterApplied(applied, SETS['2026-11-04'])).toEqual(['20261105000045_resolution_engine.sql'])
    expect(laterApplied(applied, SETS['2026-11-05'])).toEqual([])
    // the hotfix sits before the 2026-11-04 set, so it never blocks that set's rollback
    expect(laterApplied(['20261031000001_signup_trust_hotfix.sql', ...SETS['2026-11-04'].files], SETS['2026-11-04'])).toEqual([])
  })
})
