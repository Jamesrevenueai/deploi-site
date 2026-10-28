/**
 * Scans: read platform records through the connector, run the enabled checks, then reconcile
 * issues and proposals in one serialised transaction per connection.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { getConnector } from './registry'
import { legacyPlan, buildStoreContext, detectWithPlan, lookupKeysFor, type ScanPlan } from './plan'
import { changeHash } from './hash'
import { audit } from './audit'
import { engineConfig } from './config'
import { EngineError } from './errors'
import { expireProposals, invalidateProposal, LIVE_PROPOSAL, type ProposalRow } from './proposals'
import type { ConnectionRow, Correction, Finding, ResourceRecord, StoreContext } from './types'

export type ScanTrigger = 'manual' | 'install' | 'webhook' | 'schedule' | 'demo' | 'test'
export type ScanCounts = { resourcesScanned: number; issuesOpened: number; issuesUpdated: number; issuesResolved: number; proposalsCreated: number; proposalsInvalidated: number }
export type ScanResult = ScanCounts & { scanId: string; scope: 'full' | 'targeted' }

export type IssueRow = {
  id: string; org_id: string; connection_id: string; platform: string; check_key: string; kind: 'correctable' | 'needs_person'
  resource_type: string; resource_id: string; resource_label: string | null; fingerprint: string; severity: string
  status: 'open' | 'needs_review' | 'resolved' | 'dismissed'; status_reason: string | null; evidence: Record<string, unknown>
  rule_version: number | null; first_detected_at: string; last_seen_at: string; resolved_at: string | null; resolution: string | null
  guard_cleared_at: string | null
}

export async function loadConnection(db: Db, id: string): Promise<ConnectionRow | null> {
  return db.one<ConnectionRow>('select id, org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, currency from store_connections where id = $1', [id])
}

export type ScanOptions = { trigger: ScanTrigger; resourceIds?: string[]; actor?: string; now?: Date; plan?: ScanPlan }

/** Read the records, run the plan's checks (legacy merchant rules, or an agent's policy), reconcile. */
export async function runScan(connectionId: string, opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? new Date()
  const actor = opts.actor ?? `system:scan:${opts.trigger}`
  const conn = await admin(db => loadConnection(db, connectionId))
  if (!conn) throw new EngineError('not_found', 'connection not found')
  if (conn.status !== 'active') throw new EngineError('connection_inactive', `connection is ${conn.status}`)
  const connector = getConnector(conn.platform)
  if (!connector.operational) throw new EngineError('not_operational', `${conn.platform} is planned, not operational`)
  const scope: 'full' | 'targeted' = opts.resourceIds ? 'targeted' : 'full'

  const { scanId, plan } = await admin(async db => {
    const plan = opts.plan ?? await legacyPlan(db, conn)
    const s = await db.one<{ id: string }>('insert into scans (org_id, connection_id, trigger, scope, agent_id) values ($1,$2,$3,$4,$5) returning id', [conn.org_id, conn.id, opts.trigger, scope, plan.agentId])
    return { scanId: s!.id, plan }
  })

  let records: ResourceRecord[] = []
  let store: StoreContext
  try {
    if (opts.resourceIds) {
      records = [...(await connector.readResources(conn, opts.resourceIds)).values()]
      store = buildStoreContext(records, plan.currency, false)
      const keys = lookupKeysFor(records, plan, store)
      if (connector.findResources && (keys.skus.length || keys.barcodes.length || keys.handles.length)) {
        const extra = await connector.findResources(conn, keys)
        const ids = new Set(records.map(r => r.resourceId))
        store = buildStoreContext([...records, ...extra.filter(r => !ids.has(r.resourceId))], plan.currency, false)
      }
    } else {
      for await (const page of connector.listResources(conn)) records.push(...page)
      store = buildStoreContext(records, plan.currency, true)
    }
  } catch (e) {
    const message = (e as Error).message.slice(0, 300)
    await admin(async db => {
      await db.query(`update scans set status = 'failed', error = $2, finished_at = now(), resources_scanned = $3 where id = $1`, [scanId, message, records.length])
      await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'scan', entityId: scanId, event: 'scan.failed', actor, detail: { error: message, agent_id: plan.agentId } })
    })
    throw e
  }

  const seen = new Set<string>()
  const byFp = new Map<string, Finding>()
  for (const r of records) {
    seen.add(r.resourceId)
    if (typeof r.productId === 'string') seen.add(r.productId)
    for (const f of detectWithPlan(r, plan, store)) if (!byFp.has(f.fingerprint)) byFp.set(f.fingerprint, f)
  }
  if (opts.resourceIds) for (const id of opts.resourceIds) seen.add(id)
  const findings = [...byFp.values()]

  const counts = await admin(db => reconcile(db, conn, { scanId, scope, seen, findings, plan, now, actor }))
  counts.resourcesScanned = records.length
  await admin(async db => {
    await db.query(
      `update scans set status = 'completed', finished_at = now(), resources_scanned = $2, issues_opened = $3, issues_updated = $4, issues_resolved = $5, proposals_created = $6, proposals_invalidated = $7 where id = $1`,
      [scanId, counts.resourcesScanned, counts.issuesOpened, counts.issuesUpdated, counts.issuesResolved, counts.proposalsCreated, counts.proposalsInvalidated])
    if (scope === 'full') await db.query('update store_connections set last_scan_at = now() where id = $1', [conn.id])
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'scan', entityId: scanId, event: 'scan.completed', actor, detail: { scope, agent_id: plan.agentId, ...counts } })
  })
  log.info('engine.scan', { connection_id: conn.id, agent_id: plan.agentId, scope, ...counts })
  return { scanId, scope, ...counts }
}

type ReconcileInput = { scanId: string; scope: 'full' | 'targeted'; seen: Set<string>; findings: Finding[]; plan: ScanPlan; now: Date; actor: string }

export async function reconcile(db: Db, conn: ConnectionRow, input: ReconcileInput): Promise<ScanCounts> {
  const counts: ScanCounts = { resourcesScanned: 0, issuesOpened: 0, issuesUpdated: 0, issuesResolved: 0, proposalsCreated: 0, proposalsInvalidated: 0 }
  // one reconcile at a time per connection; concurrent scans queue here instead of racing
  await db.query('select pg_advisory_xact_lock(hashtext($1))', ['scan:' + conn.id])
  counts.proposalsInvalidated += await expireProposals(db, conn.id, input.now)

  const owner = input.plan.agentId
  const owned = input.plan.ownedCheckKeys
  const live = await db.query<IssueRow>(`select * from issues where connection_id = $1 and status in ('open','needs_review') and agent_id is not distinct from $2 and check_key = any($3::text[])`, [conn.id, owner, owned])
  const liveByFp = new Map(live.map(i => [i.fingerprint, i]))
  // A dismissal holds only while the problem persists: once a read shows the problem gone, the
  // dismissal is spent (resolution flips to no_longer_detected) and a later recurrence opens a new issue.
  const dismissedRows = await db.query<{ fingerprint: string; resource_id: string }>(
    `select distinct fingerprint, resource_id from issues where connection_id = $1 and agent_id is not distinct from $2 and status = 'dismissed' and resolution = 'dismissed_by_merchant'`, [conn.id, owner])
  const dismissed = new Set(dismissedRows.map(r => r.fingerprint))
  const enabled = new Set(input.plan.checks.map(p => p.check.key))
  const versionOf = new Map(input.plan.checks.map(p => [p.check.key, p.version]))
  const found = new Set<string>()

  for (const f of input.findings) {
    found.add(f.fingerprint)
    if (dismissed.has(f.fingerprint)) continue
    const version = versionOf.get(f.checkKey) ?? null
    let issue = liveByFp.get(f.fingerprint)
    if (!issue) {
      issue = (await db.one<IssueRow>(
        `insert into issues (org_id, connection_id, platform, check_key, kind, resource_type, resource_id, resource_label, fingerprint, severity, evidence, rule_version, last_scan_id, agent_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
        [conn.org_id, conn.id, conn.platform, f.checkKey, f.kind, f.resourceType, f.resourceId, f.resourceLabel, f.fingerprint, f.severity,
          JSON.stringify({ summary: f.summary, humanAction: f.humanAction ?? null, ...f.evidence }), version, input.scanId, owner]))!
      liveByFp.set(f.fingerprint, issue)
      counts.issuesOpened++
      await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'issue', entityId: issue.id, event: 'issue.detected', actor: input.actor, detail: { check_key: f.checkKey, severity: f.severity, resource_id: f.resourceId } })
    } else {
      issue = (await db.one<IssueRow>(
        `update issues set evidence = $2, severity = $3, resource_label = $4, rule_version = $5, last_seen_at = now(), last_scan_id = $6, kind = $7 where id = $1 returning *`,
        [issue.id, JSON.stringify({ summary: f.summary, humanAction: f.humanAction ?? null, ...f.evidence }), f.severity, f.resourceLabel, version, input.scanId, f.kind]))!
      counts.issuesUpdated++
    }
    if (f.kind === 'correctable' && f.correction && issue.status === 'open') await upsertProposal(db, conn, issue, f, version, input, counts)
  }

  const spent = dismissedRows.filter(d => !found.has(d.fingerprint) && (input.scope === 'full' || input.seen.has(d.resource_id))).map(d => d.fingerprint)
  if (spent.length) await db.query(`update issues set resolution = 'no_longer_detected' where connection_id = $1 and status = 'dismissed' and resolution = 'dismissed_by_merchant' and fingerprint = any($2::text[])`, [conn.id, spent])

  for (const i of live) {
    if (found.has(i.fingerprint)) continue
    const covered = input.scope === 'full' || input.seen.has(i.resource_id)
    const ruleOff = !enabled.has(i.check_key)
    if (!covered && !ruleOff) continue
    // a running execution owns the outcome of its issue (verified_fix); do not race it
    const running = await db.one(`select 1 from proposals where issue_id = $1 and status in ('executing','applied')`, [i.id])
    if (running) continue
    await db.query(`update issues set status = 'resolved', resolved_at = now(), resolution = 'no_longer_detected', status_reason = $2 where id = $1`,
      [i.id, ruleOff ? 'rule turned off' : 'not detected on the latest read'])
    counts.issuesResolved++
    const props = await db.query<ProposalRow>(`select * from proposals where issue_id = $1 and status = any($2::text[])`, [i.id, ['pending_approval', 'approved']])
    for (const p of props) if (await invalidateProposal(db, p, 'stale', ruleOff ? 'rule turned off' : 'the problem is no longer present', input.actor)) counts.proposalsInvalidated++
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'issue', entityId: i.id, event: 'issue.resolved', actor: input.actor, detail: { resolution: 'no_longer_detected', rule_off: ruleOff } })
  }
  return counts
}

async function upsertProposal(db: Db, conn: ConnectionRow, issue: IssueRow, f: Finding, version: number | null, input: ReconcileInput, counts: ScanCounts) {
  const c = withOwner(f.correction!, input.plan.agentId)
  const hash = changeHash(conn.id, c, version)
  const live = await db.one<ProposalRow>(
    `select * from proposals where connection_id = $1 and action_key = $2 and target_id = $3 and status = any($4::text[]) for update`,
    [conn.id, c.actionKey, c.targetId, [...LIVE_PROPOSAL]])
  if (live) {
    if (live.change_hash === hash) return
    if ((live.agent_id ?? null) !== input.plan.agentId) {
      // another agent (or the store's own rules) already has a live change on this record: never race it
      if (issue.status !== 'needs_review' || issue.status_reason !== 'conflicting_agent') {
        await db.query(`update issues set status = 'needs_review', status_reason = 'conflicting_agent' where id = $1`, [issue.id])
        await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'issue', entityId: issue.id, event: 'issue.conflicting_agent', actor: input.actor, detail: { other_proposal: live.id, other_agent: live.agent_id } })
      }
      return
    }
    if (live.status === 'executing' || live.status === 'applied') return
    if (await invalidateProposal(db, live, 'superseded', 'records or rule changed since this proposal was made', input.actor)) counts.proposalsInvalidated++
  }
  // Loop guard: Deploi already made this change on this target recently and it has been changed back.
  // Re-proposing would fight whoever changed it (the merchant, staff or another app); ask a person instead.
  const since = new Date(input.now.getTime() - engineConfig.loopGuardHours * 3600e3)
  const recent = await db.one<{ id: string; finished_at: string }>(
    `select e.id, e.finished_at from executions e join proposals p on p.id = e.proposal_id
     where e.connection_id = $1 and p.target_id = $2 and p.action_key = $3 and e.status = 'verified'
       and e.finished_at > $4 and e.finished_at > coalesce($5::timestamptz, '-infinity'::timestamptz)
     order by e.finished_at desc limit 1`,
    [conn.id, c.targetId, c.actionKey, since.toISOString(), issue.guard_cleared_at])
  if (recent) {
    await db.query(`update issues set status = 'needs_review', status_reason = 'reverted_after_fix' where id = $1`, [issue.id])
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'issue', entityId: issue.id, event: 'issue.loop_guard', actor: input.actor,
      detail: { previous_execution: recent.id, fixed_at: recent.finished_at, reason: 'value changed back after a verified fix; not proposing again until a person confirms' } })
    return
  }
  const expires = new Date(input.now.getTime() + engineConfig.proposalTtlHours * 3600e3)
  const p = await db.one<{ id: string }>(
    `insert into proposals (org_id, connection_id, issue_id, platform, action_key, target_type, target_id, target_label, change, preconditions, rule_version, change_hash, expires_at, agent_id, policy_id, policy_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [conn.org_id, conn.id, issue.id, conn.platform, c.actionKey, c.targetType, c.targetId, c.targetLabel,
      JSON.stringify({ ...c.change, ...(c.params ? { params: c.params } : {}) }), JSON.stringify(c.preconditions), version, hash, expires.toISOString(),
      input.plan.agentId, input.plan.policyId, input.plan.policyVersion])
  counts.proposalsCreated++
  await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'proposal', entityId: p!.id, event: 'proposal.created', actor: input.actor,
    detail: { action_key: c.actionKey, target_id: c.targetId, change: c.change, change_hash: hash, rule_version: version, agent_id: input.plan.agentId, policy_version: input.plan.policyVersion } })
}

/** The owning agent is part of the approved change: the same edit proposed by two agents is two different changes. */
export function withOwner(c: Correction, agentId: string | null): Correction {
  return agentId ? { ...c, params: { ...(c.params ?? {}), agentId } } : c
}
