/**
 * Production monitoring configuration: the alert, retention and health crons refuse callers without the cron
 * secret and do their work with it; the health snapshot holds counts only; the smoke check (read-only) passes
 * against a healthy deployment's documented responses and fails on each broken one; docs/MONITORING.md names
 * the exact uptime URLs, the log-drain steps and the alert thresholds the code uses.
 */
import '../merchant/env'
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { GET as alertsCron } from '../../app/api/cron/alerts/route'
import { GET as retentionCron } from '../../app/api/cron/retention/route'
import { GET as healthCron } from '../../app/api/cron/health/route'
import { smokeCheck, normalizeBase } from '../../scripts/smoke-check'
import { alertThresholds, ALERT_RULES } from '../../lib/ops/alerts'
import { setOpsNotifier, recordingNotifier } from '../../lib/ops/notify'

const ready = await prepareDb()
const ROOT = join(__dirname, '..', '..')
const req = (path: string, secret?: string) => new Request(`http://localhost${path}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} })
afterEach(() => { delete process.env.CRON_SECRET; setOpsNotifier(null) })

describe.skipIf(!ready)('operations crons', () => {
  it('refuse without the cron secret, and run with it', async () => {
    process.env.CRON_SECRET = 'test-cron-secret-0123456789'
    setOpsNotifier(recordingNotifier())
    for (const [path, fn] of [['/api/cron/alerts', alertsCron], ['/api/cron/retention', retentionCron], ['/api/cron/health', healthCron]] as const) {
      expect((await fn(req(path))).status, path).toBe(401)
      expect((await fn(req(path, 'wrong-secret-0000000000000'))).status, path).toBe(401)
    }
    const a = await alertsCron(req('/api/cron/alerts', process.env.CRON_SECRET))
    expect(a.status).toBe(200)
    const aj = await a.json() as { ok: boolean; ran: { status: string }[] }
    expect(aj.ok).toBe(true)
    expect(aj.ran.every(r => r.status === 'succeeded')).toBe(true)
    const h = await healthCron(req('/api/cron/health', process.env.CRON_SECRET))
    const hj = await h.json() as { ok: boolean; health: Record<string, unknown> }
    expect(hj).toMatchObject({ ok: true, health: { queue_due: expect.any(Number), ai_provider: expect.any(String) } })
    expect(JSON.stringify(hj)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@/)
    const beats = await admin(db => db.query<{ job_key: string }>(`select job_key from cron_heartbeats where job_key in ('cron.alerts','cron.health','ops.alerts') order by job_key`))
    expect(beats.map(b => b.job_key)).toEqual(['cron.alerts', 'cron.health', 'ops.alerts'])
    await admin(db => db.query(`delete from jobs where kind = 'platform.retention' and idempotency_key = $1`, [`retention@${new Date().toISOString().slice(0, 10)}`]))
    const r = await retentionCron(req('/api/cron/retention', process.env.CRON_SECRET))
    expect(r.status).toBe(200)
    // today's retention pass is queued once (idempotent per UTC day) and has run
    const today = await admin(db => db.one<{ status: string }>(`select status from jobs where kind = 'platform.retention' and idempotency_key = $1`, [`retention@${new Date().toISOString().slice(0, 10)}`]))
    expect(today?.status).toBe('succeeded')
  })
})

describe('smoke check (read-only)', () => {
  const CSP = "default-src 'self'; script-src 'self' 'nonce-abc123==' 'strict-dynamic'; object-src 'none'"
  type Over = Partial<Record<'health' | 'store' | 'login' | 'cron', () => Response>>
  const healthy = (over: Over = {}) => {
    const seen: { url: string; init: RequestInit }[] = []
    const f = async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      const p = new URL(url).pathname
      if (p === '/api/health') return over.health?.() ?? new Response(JSON.stringify({ ok: true, db: { reachable: true, latencyMs: 4 }, queue: { dead: 0, oldestDueAgeSec: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (p === '/store') return over.store?.() ?? new Response(null, { status: 307, headers: { location: '/login' } })
      if (p === '/login') return over.login?.() ?? new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } })
      if (p === '/api/cron/jobs') return over.cron?.() ?? new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 })
      throw new Error(`unexpected ${url}`)
    }
    return { f, seen }
  }

  it('passes against a healthy deployment, with GETs only, no credentials, no redirects followed', async () => {
    const { f, seen } = healthy()
    const r = await smokeCheck('https://app.example.com/some/path', f)
    expect(r.map(c => [c.name, c.ok])).toEqual([['health', true], ['auth redirect', true], ['public page', true], ['CSP header', true], ['cron refusal', true]])
    expect(seen.map(s => s.url)).toEqual(['https://app.example.com/api/health', 'https://app.example.com/store', 'https://app.example.com/login', 'https://app.example.com/api/cron/jobs'])
    for (const s of seen) {
      expect(s.init.method).toBe('GET')
      expect(s.init.redirect).toBe('manual')
      const h = new Headers(s.init.headers)
      expect(h.get('authorization')).toBeNull()
      expect(h.get('cookie')).toBeNull()
    }
  })

  it('fails each check on its own broken response', async () => {
    const cases: [Over, string][] = [
      [{ health: () => new Response(JSON.stringify({ ok: false }), { status: 503 }) }, 'health'],
      [{ store: () => new Response('<html>store</html>', { status: 200 }) }, 'auth redirect'],
      [{ store: () => new Response(null, { status: 307, headers: { location: 'https://evil.example/login' } }) }, 'auth redirect'],
      [{ login: () => new Response('down', { status: 500, headers: { 'content-security-policy': CSP } }) }, 'public page'],
      [{ login: () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, 'CSP header'],
      [{ cron: () => new Response('{"ok":true}', { status: 200 }) }, 'cron refusal'],
    ]
    for (const [over, failing] of cases) {
      const r = await smokeCheck('https://app.example.com', healthy(over).f)
      expect(r.filter(c => !c.ok).map(c => c.name), failing).toEqual([failing])
    }
    const down = await smokeCheck('https://app.example.com', async () => { throw new Error('ECONNREFUSED') })
    expect(down.every(c => !c.ok)).toBe(true)
  })

  it('refuses plain http except for localhost', () => {
    expect(() => normalizeBase('http://app.example.com')).toThrow(/https/)
    expect(normalizeBase('http://localhost:3516/x')).toBe('http://localhost:3516')
  })
})

describe('docs/MONITORING.md', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'MONITORING.md'), 'utf8')
  it('names the exact uptime URLs, the log drain steps, every alert rule and its default threshold', () => {
    expect(doc).toContain('https://app.getdeploi.com/api/health')
    expect(doc).toContain('https://app.getdeploi.com/login')
    expect(doc).toMatch(/Log Drains/)
    expect(doc).toContain('npx tsx scripts/smoke-check.ts')
    for (const r of ALERT_RULES) expect(doc, r).toContain(r)
    const t = alertThresholds()
    for (const v of [`OPS_QUEUE_AGE_SEC`, `${t.queueAgeSec}`, `OPS_ORG_CASE_FAILURES_24H`, `OPS_BOUNCE_RATE`, `OPS_UNKNOWN_24H`, `OPS_AI_SPEND_RATIO`]) expect(doc, v).toContain(v)
    const crons: { path: string }[] = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).crons
    for (const c of crons) expect(doc, c.path).toContain(c.path)
  })
})
