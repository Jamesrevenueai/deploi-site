/**
 * Failure alerts: each rule fires on its condition, is deduplicated per rule + subject, resolves itself when the
 * condition clears, and is routed to staff (every alert) and to the organization's owner (organization alerts,
 * with customer-facing text). The evaluation is a durable job queued once per ten-minute window.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, HB } from '../merchant/helpers'
import { evaluateAlerts, listAlerts, type AlertRow } from '../../lib/ops/alerts'
import { recordingNotifier, setOpsNotifier } from '../../lib/ops/notify'
import { enqueueOpsWork } from '../../lib/ops/jobs'
import { enqueueDueWork, runDueJobs } from '../../lib/jobs'
import { openCase, transitionCase } from '../../lib/cases'
import { setBudgetOverride } from '../../lib/ai/budgets'
import { withOwner } from '../security/pg'

const ready = await prepareDb()
let rec = recordingNotifier()
const live = (rule: string) => admin(db => db.query<AlertRow>(`select * from alerts where rule = $1 and status <> 'resolved' order by subject`, [rule]))
const all = (rule: string) => admin(db => db.query<AlertRow>(`select * from alerts where rule = $1 order by created_at`, [rule]))
const NOW = () => new Date()
/** As the database owner, with foreign keys suspended (seed rows without their parents), committed. */
const asOwner = (fn: (q: (sql: string, p?: unknown[]) => Promise<unknown>) => Promise<void>) => withOwner(async c => {
  await c.query('begin'); await c.query('set local session_replication_role = replica')
  try { await fn((sql, p) => c.query(sql, p as unknown[])); await c.query('commit') } catch (e) { await c.query('rollback'); throw e }
})

async function clean() {
  await admin(async db => {
    await db.query(`delete from alerts`)
    await db.query(`delete from jobs where kind like 'test.%' or kind = 'ops.alerts' or status = 'dead'`)
    await db.query(`delete from cases where org_id = any($1) and kind like 'ops_test%'`, [[NW.org, HB.org]])
    await db.query(`delete from ai_usage where org_id = any($1)`, [[NW.org, HB.org]])
    await db.query(`delete from ai_budget_overrides where org_id = any($1)`, [[NW.org, HB.org]])
    await db.query(`delete from email_suppressions where org_id = any($1) and created_by = 'ops-test'`, [[NW.org, HB.org]])
    await db.query(`delete from email_messages where org_id = any($1) and dedupe_key like 'ops-test:%'`, [[NW.org, HB.org]])
  })
  await admin(db => db.query(`delete from connection_health where org_id = any($1)`, [[NW.org, HB.org]]))
}
async function deadJob(kind = 'test.ops_dead') {
  return (await admin(db => db.one<{ id: string }>(`insert into jobs (kind, status, attempts, max_attempts, last_error, finished_at) values ($1, 'dead', 3, 3, 'boom', now()) returning id`, [kind])))!.id
}
async function testCase(m: typeof NW, key: string, over: { deadline?: Date } = {}) {
  return (await admin(db => openCase(db, { orgId: m.org, suite: 'commerce', kind: 'ops_test', sourceApp: 'import', dedupeKey: `ops_test:${key}`, title: `Ops test ${key}`, problem: 'test',
    verification: { criteria: 'observed in a test' }, actor: 'test', deadlineAt: over.deadline ?? null }))).case
}

beforeEach(async () => { if (ready) await clean(); rec = recordingNotifier(); setOpsNotifier(rec); process.env.STAFF_EMAILS = 'hello@getdeploi.com,ops@getdeploi.com' })
afterEach(() => { setOpsNotifier(null); process.env.STAFF_EMAILS = 'hello@getdeploi.com'; for (const k of ['OPS_QUEUE_AGE_SEC', 'OPS_ORG_CASE_FAILURES_24H', 'OPS_UNKNOWN_24H', 'OPS_BOUNCE_MIN_SENT']) delete process.env[k] })
afterAll(async () => { if (ready) await clean() })

describe.skipIf(!ready)('alerts', () => {
  it('dead jobs: one alert however often it is seen, staff are told once, and it resolves itself when the dead jobs are gone', async () => {
    const id = await deadJob()
    const a = await evaluateAlerts({ rules: ['jobs.dead'] })
    expect(a.opened).toHaveLength(1)
    const b = await evaluateAlerts({ rules: ['jobs.dead'] })
    expect(b).toMatchObject({ opened: [], updated: [a.opened[0]] })
    const [row] = await live('jobs.dead')
    expect(row).toMatchObject({ subject: 'all', org_id: null, status: 'open', occurrences: 2, title: '1 dead job on the queue' })
    // platform alert: staff only, every staff address, never an organization owner
    expect(rec.sent).toEqual([expect.objectContaining({ audience: 'staff', event: 'opened', to: ['hello@getdeploi.com', 'ops@getdeploi.com'], alertId: row.id })])
    expect(row.notified).toEqual([expect.objectContaining({ audience: 'staff', ok: true, count: 2 })])
    await admin(db => db.query(`update jobs set status = 'cancelled' where id = $1`, [id]))
    const c = await evaluateAlerts({ rules: ['jobs.dead'] })
    expect(c.resolved).toEqual([row.id])
    expect(await live('jobs.dead')).toEqual([])
    expect(rec.sent.map(n => n.event)).toEqual(['opened', 'resolved'])
    // the same condition later opens a new alert (history kept)
    await deadJob()
    await evaluateAlerts({ rules: ['jobs.dead'] })
    expect((await all('jobs.dead')).map(x => x.status)).toEqual(['resolved', 'open'])
  })

  it('two evaluations at once open the alert once and notify once', async () => {
    await deadJob()
    const [x, y] = await Promise.all([evaluateAlerts({ rules: ['jobs.dead'] }), evaluateAlerts({ rules: ['jobs.dead'] })])
    expect(x.opened.length + y.opened.length).toBe(1)
    expect(await all('jobs.dead')).toHaveLength(1)
    expect(rec.sent).toHaveLength(1)
  })

  it('queue age: the oldest due job waiting past the threshold fires; once it runs the alert clears', async () => {
    process.env.OPS_QUEUE_AGE_SEC = '600'
    // evaluated as of yesterday, so only this test's job is due then (other suites' jobs are newer)
    const then = new Date(Date.now() - 864e5)
    const id = (await admin(db => db.one<{ id: string }>(`insert into jobs (kind, run_after, created_at) values ('test.ops_waiting', $1, $1) returning id`, [new Date(then.getTime() - 20 * 60e3).toISOString()])))!.id
    await evaluateAlerts({ rules: ['queue.age'], now: then })
    expect((await live('queue.age'))[0]).toMatchObject({ severity: 'warn', title: 'The oldest due job has waited 20 minutes' })
    await admin(db => db.query(`update jobs set status = 'succeeded', finished_at = now() where id = $1`, [id]))
    await evaluateAlerts({ rules: ['queue.age'], now: then })
    expect(await live('queue.age')).toEqual([])
  })

  it('cron heartbeat missing: stale, failed or never-recorded heartbeats fire per job key; a fresh one clears', async () => {
    const saved = await admin(db => db.query<{ job_key: string; last_run_at: string; last_status: string; detail: unknown }>(`select * from cron_heartbeats`))
    try {
      await admin(async db => {
        await db.query(`delete from cron_heartbeats`)
        await db.query(`insert into cron_heartbeats (job_key, last_run_at, last_status) values ('cron.jobs', now() - interval '3 hours', 'ok'), ('cron.agents', now(), 'failed'), ('cron.alerts', now(), 'ok'), ('cron.health', now(), 'ok'), ('platform.retention', now(), 'ok')`)
      })
      await evaluateAlerts({ rules: ['cron.missing'] })
      expect((await live('cron.missing')).map(a => [a.subject, a.severity])).toEqual([['cron.agents', 'page'], ['cron.jobs', 'warn']])
      await admin(db => db.query(`update cron_heartbeats set last_run_at = now(), last_status = 'ok'`))
      await admin(db => db.query(`delete from cron_heartbeats where job_key = 'cron.health'`))
      await evaluateAlerts({ rules: ['cron.missing'] })
      expect((await live('cron.missing')).map(a => [a.subject, a.title])).toEqual([['cron.health', 'Scheduled job cron.health has never run']])
    } finally {
      await admin(async db => {
        await db.query(`delete from cron_heartbeats`)
        for (const h of saved) await db.query(`insert into cron_heartbeats (job_key, last_run_at, last_status, detail) values ($1,$2,$3,$4)`, [h.job_key, h.last_run_at, h.last_status, JSON.stringify(h.detail ?? {})])
      })
    }
  })

  it('an organization with too many failed or escalated cases alerts staff and that owner only, in plain words', async () => {
    process.env.OPS_ORG_CASE_FAILURES_24H = '2'
    for (const k of ['a', 'b', 'c']) await admin(async db => transitionCase(db, (await testCase(NW, k)).id, { to: 'escalated', actor: 'test', reason: 'needs a person' }))
    await admin(async db => transitionCase(db, (await testCase(HB, 'x')).id, { to: 'failed', actor: 'test', reason: 'failed once' }))
    await evaluateAlerts({ rules: ['org.case_failures'] })
    const rows = await live('org.case_failures')
    expect(rows.map(r => [r.org_id, r.subject])).toEqual([[NW.org, NW.org]])
    const owner = rec.sent.find(n => n.audience === 'owner')!
    expect(owner.to).toEqual([NW.email])
    expect(owner.text).toMatch(/3 pieces of work your AI team was handling failed or need you/)
    expect(owner.text).not.toContain(NW.org)
    expect(rec.sent.find(n => n.audience === 'staff')!.text).toContain(NW.org)
    // the organization reads its own alert through RLS, and not another's; who was notified is not readable
    const { withUser } = await import('../../lib/db')
    const { SESSIONS } = await import('../db/helpers')
    expect(await withUser(SESSIONS.northwind, db => db.query(`select id, title from alerts where rule = 'org.case_failures'`))).toHaveLength(1)
    expect(await withUser(SESSIONS.harbor, db => db.query(`select id from alerts where rule = 'org.case_failures'`))).toHaveLength(0)
    await expect(withUser(SESSIONS.northwind, db => db.query(`select notified from alerts`))).rejects.toThrow(/permission denied/)
  })

  it('a case past its deadline alerts, and the alert resolves when the case closes', async () => {
    const c = await testCase(NW, 'late', { deadline: new Date(Date.now() - 3600e3) })
    await testCase(NW, 'ontime', { deadline: new Date(Date.now() + 3600e3) })
    await evaluateAlerts({ rules: ['case.deadline'] })
    const [a] = await live('case.deadline')
    expect(a).toMatchObject({ subject: c.id, org_id: NW.org, title: expect.stringContaining(c.ref) })
    await admin(db => transitionCase(db, c.id, { to: 'cancelled', actor: 'test', reason: 'done' }))
    const r = await evaluateAlerts({ rules: ['case.deadline'] })
    expect(r.resolved).toContain(a.id)
  })

  it('connection health: a flip to needs_reauth alerts the owner with the integration named; recovery clears it', async () => {
    expect(await evaluateAlerts({ rules: ['connection.health'] })).toMatchObject({ opened: [], errors: {} })
    const conn = randomUUID()
    const row = (prev: string | null, status: string, at: string) => admin(db => db.query(
      `insert into connection_health (org_id, integration, connection_id, ok, previous_status, status, message, checked_at) values ($1, 'hubspot', $2, $3, $4, $5, 'test', ${at})`, [NW.org, conn, status === 'connected', prev, status]))
    await row(null, 'connected', `now() - interval '1 hour'`)
    await row('connected', 'needs_reauth', 'now()')
    await evaluateAlerts({ rules: ['connection.health'] })
    const [a] = await live('connection.health')
    expect(a).toMatchObject({ org_id: NW.org, subject: `${NW.org}:${conn}`, title: 'A HubSpot connection is asking to be reconnected (was connected)' })
    expect(rec.sent.find(n => n.audience === 'owner')!.text).toMatch(/Your HubSpot connection needs to be reconnected/)
    await row('needs_reauth', 'connected', `now() + interval '1 minute'`)
    expect((await evaluateAlerts({ rules: ['connection.health'] })).resolved).toEqual([a.id])
  })

  it('AI spend at 80% of the organization budget alerts; at 100% it pages', async () => {
    await admin(db => setBudgetOverride(db, NW.org, '', 10, 'staff:test'))
    const spend = (usd: number) => admin(db => db.query(`insert into ai_usage (org_id, agent_ref, purpose, tier, model, cost_usd, outcome) values ($1, 'engine:x', 'test.spend', 'routine', 'm', $2, 'ok')`, [NW.org, usd]))
    await spend(7.5)
    await evaluateAlerts({ rules: ['ai.spend'] })
    expect(await live('ai.spend')).toEqual([])
    await spend(0.6)
    await evaluateAlerts({ rules: ['ai.spend'] })
    expect((await live('ai.spend'))[0]).toMatchObject({ severity: 'warn', title: 'AI spend at 81% of the monthly budget' })
    await spend(2)
    await evaluateAlerts({ rules: ['ai.spend'] })
    expect((await live('ai.spend'))[0]).toMatchObject({ severity: 'page', occurrences: 2 })
  })

  it('email bounce and complaint rate above the threshold alerts, with a minimum volume', async () => {
    process.env.OPS_BOUNCE_MIN_SENT = '10'
    const sends = (n: number, m = NW) => asOwner(async q => { // seed message rows without a mailbox
      for (let k = 0; k < n; k++) await q(`insert into email_messages (org_id, account_id, status, task_key, dedupe_key, from_address, to_addresses, key_id, content_ciphertext, content_hash, internet_message_id)
        values ($1, gen_random_uuid(), 'accepted', 'human_reply', $2, 'a@agents.deploi.test', '{x@y.example}', 'k', 'c', 'h', $3)`, [m.org, `ops-test:${randomUUID()}`, `<${randomUUID()}@ops-test>`])
    })
    await sends(9)
    await admin(async db => { for (let k = 0; k < 3; k++) await db.query(`insert into email_suppressions (org_id, address, reason, created_by) values ($1, $2, $3, 'ops-test')`, [NW.org, `b${k}@ops-test.example`, k ? 'bounced' : 'complained']) })
    await evaluateAlerts({ rules: ['email.bounce_rate'] })
    expect(await live('email.bounce_rate')).toEqual([]) // 9 sent: below the minimum volume
    await sends(6)
    await evaluateAlerts({ rules: ['email.bounce_rate'] })
    expect((await live('email.bounce_rate'))[0]).toMatchObject({ org_id: NW.org, title: 'Email bounce and complaint rate 20.0% over 7 days', detail: expect.objectContaining({ sent_7d: 15, bounced_or_complained_7d: 3 }) })
    expect(rec.sent.find(n => n.audience === 'owner')!.to).toEqual([NW.email])
  })

  it('repeated unknown outcomes in 24 hours alert the organization', async () => {
    process.env.OPS_UNKNOWN_24H = '2'
    await evaluateAlerts({ rules: ['execution.unknown'] })
    expect(await live('execution.unknown')).toEqual([])
    const keys = [`ops-test:${randomUUID()}`, `ops-test:${randomUUID()}`]
    await asOwner(async q => {
      for (const k of keys) await q(`insert into office_actions (org_id, agent_id, kind, purpose, idempotency_key, status, payload, payload_hash) values ($1, gen_random_uuid(), 'crm_note', 't', $2, 'unknown', '{}', 'h')`, [NW.org, k])
    })
    try {
      await evaluateAlerts({ rules: ['execution.unknown'] })
      expect((await live('execution.unknown'))[0]).toMatchObject({ org_id: NW.org, title: '2 outcomes in 24 hours could not be confirmed', detail: expect.objectContaining({ office_actions: 2 }) })
    } finally { await admin(db => db.query(`delete from office_actions where idempotency_key = any($1)`, [keys])) }
  })

  it('a rule that fails to evaluate leaves its alerts alone (an error never resolves anything)', async () => {
    const conn = randomUUID()
    await admin(db => db.query(`insert into connection_health (org_id, integration, connection_id, ok, previous_status, status, message) values ($1, 'hubspot', $2, false, 'connected', 'error', 'test')`, [NW.org, conn]))
    await evaluateAlerts({ rules: ['connection.health'] })
    const [a] = await live('connection.health')
    expect(a).toBeTruthy()
    // the source is unreadable at query time: the rule errors, and the alert stays open
    await withOwner(c => c.query('alter table connection_health rename to connection_health_unreadable'))
    let r
    try { r = await evaluateAlerts({ rules: ['connection.health'] }) } finally { await withOwner(c => c.query('alter table connection_health_unreadable rename to connection_health')) }
    expect(r.errors['connection.health']).toMatch(/connection_health/)
    expect(r.resolved).toEqual([])
    expect((await live('connection.health'))[0].id).toBe(a.id)
  })

  it('the evaluation is a durable job: queued once per ten-minute window by the sweep and the alerts cron, then run', async () => {
    await deadJob()
    const now = NOW()
    const [a] = await enqueueOpsWork(now)
    const [b] = await enqueueOpsWork(now)
    expect(a.created).toBe(true)
    expect(b).toMatchObject({ id: a.id, created: false })
    const sweep = await enqueueDueWork({ now })
    expect(sweep.maintenance.map(m => m.id)).toContain(a.id)
    const r = await runDueJobs({ kinds: ['ops.alerts'] })
    expect(r.ran).toEqual([expect.objectContaining({ kind: 'ops.alerts', status: 'succeeded' })])
    expect((await admin(db => listAlerts(db, { status: 'live' }))).map(x => x.rule)).toContain('jobs.dead')
  })
})
