/**
 * The team: one switch per library agent. The merchant's plan tier (agencies.plan_tier) decides which
 * agents can be switched on; the tier's agent list is config (agent-library.json). A locked agent is
 * still listed, with the tier that unlocks it. Switching on an engine-backed agent (Inventory Watcher,
 * Supplier Chaser, Store Health Checker) creates and grants its correction-engine agent at drafts only,
 * so its runs use the verified engine; switching it off pauses that agent.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { createAgent, grantPolicy, pauseAgent, resumeAgent } from '../agents/lifecycle'
import { templatePolicy, type TemplateKey } from '../agents/templates'
import { LIBRARY, agentByKey, isPermissionLevel, isTierKey, isUpgrade, lowestTierFor, tierByKey, tierIncludes, type LibraryAgent, type PermissionLevel, type TierKey } from './config'
import { LibraryError } from './errors'
import { APPROVAL_ONLY, type SwitchRow } from './actions'
import { usageSummary, type UsageSummary } from './usage'

export type GrantView = { actionType: string; label: string; maxPerDay: number; grantedAt: string; grantedBy: string }
export type TeamAgent = LibraryAgent & {
  locked: boolean; upgradeTo: TierKey | null; enabled: boolean; permission: PermissionLevel; instructions: string; settings: Record<string, unknown>
  grants: GrantView[]; waiting: number; actionsThisWeek: number; doneThisWeek: number; lastRunAt: string | null; lastRunStatus: string | null; engineAgentId: string | null
  /** what the merchant must supply before this agent can be switched on */
  needs: { key: string; label: string }[]
  approvalOnly: string[]
}
export type CustomAgentView = { id: string; name: string; job: string; permission: PermissionLevel; enabled: boolean; capabilities: string[]; createdAt: string }
export type TeamView = {
  tier: TierKey; tiers: typeof LIBRARY.tiers; permissionLevels: typeof LIBRARY.permissionLevels; pricingStatus: typeof LIBRARY.pricingStatus
  agents: TeamAgent[]; usage: UsageSummary; buildYourOwn: { allowed: boolean; agents: CustomAgentView[] }
  onboarding: Record<string, unknown>; store: { connected: boolean; synthetic: boolean; name: string | null }
}

export const NEEDS: Record<string, { key: string; label: string }[]> = {
  supplier_chaser: [{ key: 'supplierAddress', label: "your supplier's email address" }],
}

export async function orgTier(db: Db, orgId: string): Promise<TierKey> {
  const r = await db.one<{ plan_tier: string }>('select plan_tier from agencies where id = $1', [orgId])
  return isTierKey(r?.plan_tier) ? r!.plan_tier : 'starter'
}

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'the team belongs to a merchant organization')
  return actor.orgId
}

export async function teamView(actor: Actor, now = new Date()): Promise<TeamView> {
  const orgId = orgOf(actor)
  const { matchCapabilities } = await import('./runners')
  return withActor(actor, async db => {
    const tier = await orgTier(db, orgId)
    const org = await db.one<{ onboarding: Record<string, unknown> }>('select onboarding from agencies where id = $1', [orgId])
    const conn = await db.one<{ is_synthetic: boolean; name: string | null }>(`select is_synthetic, coalesce(display_name, external_id) as name from store_connections where org_id = $1 and status = 'active' order by created_at limit 1`, [orgId])
    const switches = await db.query<SwitchRow & { switched_at: string | null }>('select * from library_switches where org_id = $1', [orgId])
    const grants = await db.query<{ agent_key: string; action_type: string; max_per_day: number; granted_at: string; granted_by: string }>('select agent_key, action_type, max_per_day, granted_at, granted_by from library_auto_run_grants where org_id = $1 and revoked_at is null', [orgId])
    const weekAgo = new Date(now.getTime() - 7 * 864e5).toISOString()
    const counts = await db.query<{ agent_key: string; waiting: string; week: string; done: string }>(
      `select agent_key, count(*) filter (where status = 'draft')::text as waiting, count(*) filter (where created_at >= $2)::text as week, count(*) filter (where status = 'done' and created_at >= $2)::text as done from library_actions where org_id = $1 group by agent_key`, [orgId, weekAgo])
    const custom = tierByKey(tier)?.buildYourOwn ? await db.query<{ id: string; name: string; job: string; permission: PermissionLevel; enabled: boolean; created_at: string }>('select id, name, job, permission, enabled, created_at from custom_agents where org_id = $1 order by created_at', [orgId]) : []
    const agents: TeamAgent[] = LIBRARY.agents.map(a => {
      const sw = switches.find(s => s.agent_key === a.key)
      const c = counts.find(x => x.agent_key === a.key)
      const locked = !tierIncludes(tier, a.key)
      return {
        ...a, locked, upgradeTo: locked ? lowestTierFor(a.key)?.key ?? null : null,
        enabled: Boolean(sw?.enabled) && !locked, permission: sw?.permission ?? 'draft', instructions: sw?.standing_instructions ?? '', settings: sw?.settings ?? {},
        grants: grants.filter(g => g.agent_key === a.key).map(g => ({ actionType: g.action_type, label: a.actionTypes.find(t => t.key === g.action_type)?.label ?? g.action_type, maxPerDay: g.max_per_day, grantedAt: g.granted_at, grantedBy: g.granted_by })),
        waiting: Number(c?.waiting ?? 0), actionsThisWeek: Number(c?.week ?? 0), doneThisWeek: Number(c?.done ?? 0),
        lastRunAt: sw?.last_run_at ?? null, lastRunStatus: sw?.last_run_status ?? null, engineAgentId: sw?.engine_agent_id ?? null,
        needs: (NEEDS[a.key] ?? []).filter(n => !sw?.settings?.[n.key]), approvalOnly: a.actionTypes.filter(t => APPROVAL_ONLY.has(t.key)).map(t => t.key),
      }
    })
    return {
      tier, tiers: LIBRARY.tiers, permissionLevels: LIBRARY.permissionLevels, pricingStatus: LIBRARY.pricingStatus, agents,
      usage: await usageSummary(actor, orgId, now),
      buildYourOwn: { allowed: Boolean(tierByKey(tier)?.buildYourOwn), agents: custom.map(c => ({ id: c.id, name: c.name, job: c.job, permission: c.permission, enabled: c.enabled, capabilities: matchCapabilities(c.job), createdAt: c.created_at })) },
      onboarding: org?.onboarding ?? {}, store: { connected: Boolean(conn), synthetic: Boolean(conn?.is_synthetic), name: conn?.name ?? null },
    }
  })
}

/** Refuses when the merchant's tier does not include the agent. The error names the tier that does. */
export async function assertUnlocked(db: Db, orgId: string, agentKey: string) {
  const tier = await orgTier(db, orgId)
  if (!tierIncludes(tier, agentKey)) {
    const up = lowestTierFor(agentKey)
    throw new LibraryError('upgrade_required', `${agentByKey(agentKey)?.name ?? agentKey} is not included in the ${tierByKey(tier)?.name ?? tier} tier${up ? `; it is included from ${up.name}` : ''}`, { tier, upgradeTo: up?.key ?? null, agentKey })
  }
}

async function ensureSwitch(db: Db, orgId: string, agentKey: string): Promise<SwitchRow> {
  await db.query('insert into library_switches (org_id, agent_key) values ($1,$2) on conflict (org_id, agent_key) do nothing', [orgId, agentKey])
  return (await db.one<SwitchRow>('select * from library_switches where org_id = $1 and agent_key = $2 for update', [orgId, agentKey]))!
}

/** Switch an agent on or off. On: tier check, setup check, create the engine agent for engine-backed templates; off: pause everything. */
export async function setSwitch(actor: Actor, agentKey: string, enabled: boolean, opts: { settings?: Record<string, unknown> } = {}) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const cfg = agentByKey(agentKey)
  if (!cfg) throw new LibraryError('not_found', 'unknown agent')
  const notify = actor.kind === 'profile' ? actor.session.email : null
  return admin(async db => {
    if (enabled) await assertUnlocked(db, orgId, agentKey)
    const sw = await ensureSwitch(db, orgId, agentKey)
    const settings = { ...sw.settings, ...(opts.settings ?? {}) }
    if (enabled) {
      const missing = (NEEDS[agentKey] ?? []).filter(n => !settings[n.key])
      if (missing.length) throw new LibraryError('needs_setup', `before switching on ${cfg.name}, add ${missing.map(m => m.label).join(' and ')}`, { needs: missing })
    }
    let engineAgentId = sw.engine_agent_id
    if (enabled && cfg.templateKey && !engineAgentId) engineAgentId = await createEngineAgent(db, actor, orgId, cfg, settings, notify)
    else if (cfg.templateKey && engineAgentId) {
      const a = await db.one<{ status: string }>('select status from agents where id = $1', [engineAgentId])
      if (enabled && a?.status === 'paused') await resumeAgent(actor, engineAgentId)
      if (!enabled && a?.status === 'active') await pauseAgent(actor, engineAgentId)
    }
    await db.query('update library_switches set enabled = $3, settings = $4, engine_agent_id = $5, switched_by = $6, switched_at = now() where org_id = $1 and agent_key = $2', [orgId, agentKey, enabled, JSON.stringify(settings), engineAgentId, actor.label])
    if (!enabled) await db.query(`update library_actions set status = 'expired', status_reason = 'the agent was switched off' where org_id = $1 and agent_key = $2 and status = 'draft'`, [orgId, agentKey])
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: enabled ? 'library.switch.on' : 'library.switch.off', actor: actor.label, detail: { agent_key: agentKey, engine_agent_id: engineAgentId, permission: sw.permission } })
    return { enabled, engineAgentId, permission: sw.permission }
  })
}

/** The engine agent behind a template-backed library agent: created at drafts only and granted in the same merchant action (the switch). */
async function createEngineAgent(db: Db, actor: Actor, orgId: string, cfg: LibraryAgent, settings: Record<string, unknown>, notify: string | null): Promise<string> {
  const conn = await db.one<{ id: string; timezone: string | null }>(`select id, timezone from store_connections where org_id = $1 and status = 'active' order by created_at limit 1`, [orgId])
  if (!conn) throw new LibraryError('needs_setup', 'connect a store first', { step: 'connect' })
  const key = cfg.templateKey as TemplateKey
  const to = typeof settings.notify === 'string' ? settings.notify : notify
  if (key !== 'supplier_chaser' && !to) throw new LibraryError('needs_setup', `add the email address that should receive ${cfg.name}'s alerts`, { needs: [{ key: 'notify', label: 'who receives the alerts (an email address)' }] })
  const policy = templatePolicy(key, { connectionId: conn.id, timezone: conn.timezone || 'UTC', notify: to, supplierAddress: typeof settings.supplierAddress === 'string' ? settings.supplierAddress : null })
  // without an agent mail domain the engine agent runs its store checks only; the library drafts the emails instead
  const mailboxReady = Boolean((process.env.AGENT_MAIL_DOMAIN ?? '').trim())
  if (!mailboxReady) delete policy.email
  const created = await createAgent(actor, { name: cfg.name, taskText: cfg.description, policy, mailbox: mailboxReady && Boolean(policy.email), templateKey: key })
  await grantPolicy(actor, created.agentId, created.policyId, created.policyHash)
  return created.agentId
}

export async function setPermission(actor: Actor, agentKey: string, level: unknown) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  if (!isPermissionLevel(level)) throw new LibraryError('invalid_input', 'permission must be read, draft or act')
  if (!agentByKey(agentKey)) throw new LibraryError('not_found', 'unknown agent')
  return admin(async db => {
    await assertUnlocked(db, orgId, agentKey)
    const sw = await ensureSwitch(db, orgId, agentKey)
    await db.query('update library_switches set permission = $3 where org_id = $1 and agent_key = $2', [orgId, agentKey, level])
    // lowering below "act" ends every auto-run grant at once
    if (level !== 'act') await db.query('update library_auto_run_grants set revoked_at = now(), revoked_by = $3 where org_id = $1 and agent_key = $2 and revoked_at is null', [orgId, agentKey, actor.label])
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: 'library.permission', actor: actor.label, detail: { agent_key: agentKey, from: sw.permission, to: level } })
    return { permission: level }
  })
}

export async function setInstructions(actor: Actor, agentKey: string, text: string) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  if (!agentByKey(agentKey)) throw new LibraryError('not_found', 'unknown agent')
  const t = text.trim().slice(0, 4000)
  return admin(async db => {
    await ensureSwitch(db, orgId, agentKey)
    await db.query('update library_switches set standing_instructions = $3 where org_id = $1 and agent_key = $2', [orgId, agentKey, t])
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: 'library.instructions', actor: actor.label, detail: { agent_key: agentKey, length: t.length } })
    return { instructions: t }
  })
}

export async function setSettings(actor: Actor, agentKey: string, patch: Record<string, unknown>) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  if (!agentByKey(agentKey)) throw new LibraryError('not_found', 'unknown agent')
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (/^[a-zA-Z]\w{0,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) clean[k] = typeof v === 'string' ? v.trim().slice(0, 300) : v
  return admin(async db => {
    const sw = await ensureSwitch(db, orgId, agentKey)
    const settings = { ...sw.settings, ...clean }
    await db.query('update library_switches set settings = $3 where org_id = $1 and agent_key = $2', [orgId, agentKey, JSON.stringify(settings)])
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: 'library.settings', actor: actor.label, detail: { agent_key: agentKey, keys: Object.keys(clean) } })
    return { settings }
  })
}

/** Grant auto-run for one action type. Requires the agent at "act"; money and publishing actions can never be granted. */
export async function grantAutoRun(actor: Actor, agentKey: string, actionType: string, maxPerDay = 20) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const cfg = agentByKey(agentKey)
  if (!cfg) throw new LibraryError('not_found', 'unknown agent')
  const at = cfg.actionTypes.find(t => t.key === actionType)
  if (!at) throw new LibraryError('invalid_input', 'unknown action type for this agent')
  if (APPROVAL_ONLY.has(actionType)) throw new LibraryError('forbidden', `"${at.label}" moves money or publishes, so it is approval-only at every permission level`)
  if (!at.writes) throw new LibraryError('invalid_input', `"${at.label}" only reports; it needs no grant`)
  const cap = Math.min(500, Math.max(1, Math.floor(maxPerDay)))
  return admin(async db => {
    await assertUnlocked(db, orgId, agentKey)
    const sw = await ensureSwitch(db, orgId, agentKey)
    if (sw.permission !== 'act') throw new LibraryError('conflict', `set ${cfg.name} to "Act within limits" first`)
    await db.query('update library_auto_run_grants set revoked_at = now(), revoked_by = $4 where org_id = $1 and agent_key = $2 and action_type = $3 and revoked_at is null', [orgId, agentKey, actionType, actor.label])
    await db.query('insert into library_auto_run_grants (org_id, agent_key, action_type, granted_by, max_per_day) values ($1,$2,$3,$4,$5)', [orgId, agentKey, actionType, actor.label, cap])
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: 'library.autorun.granted', actor: actor.label, detail: { agent_key: agentKey, action_type: actionType, max_per_day: cap } })
    return { actionType, maxPerDay: cap }
  })
}

export async function revokeAutoRun(actor: Actor, agentKey: string, actionType: string) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  return admin(async db => {
    const r = await db.query('update library_auto_run_grants set revoked_at = now(), revoked_by = $4 where org_id = $1 and agent_key = $2 and action_type = $3 and revoked_at is null returning id', [orgId, agentKey, actionType, actor.label])
    await audit(db, { orgId, entityType: 'library', entityId: agentKey, event: 'library.autorun.revoked', actor: actor.label, detail: { agent_key: agentKey, action_type: actionType, revoked: r.length } })
    return { revoked: r.length }
  })
}

/** Change the plan tier. Private beta: the merchant picks the tier to trial; nothing is charged. A downgrade switches off agents the new tier does not include. */
export async function setTier(actor: Actor, tier: unknown) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  if (!isTierKey(tier)) throw new LibraryError('invalid_input', 'unknown tier')
  return admin(async db => {
    const from = await orgTier(db, orgId)
    await db.query(`update agencies set plan_tier = $2, plan_changed_at = now(), onboarding = onboarding || '{"tierChosen": true}'::jsonb where id = $1`, [orgId, tier])
    const switchedOff: string[] = []
    if (!isUpgrade(from, tier)) {
      const on = await db.query<SwitchRow>('select * from library_switches where org_id = $1 and enabled', [orgId])
      for (const sw of on) {
        if (tierIncludes(tier, sw.agent_key)) continue
        await db.query('update library_switches set enabled = false, switched_by = $3, switched_at = now() where org_id = $1 and agent_key = $2', [orgId, sw.agent_key, actor.label])
        await db.query(`update library_actions set status = 'expired', status_reason = 'the plan no longer includes this agent' where org_id = $1 and agent_key = $2 and status = 'draft'`, [orgId, sw.agent_key])
        if (sw.engine_agent_id) { const a = await db.one<{ status: string }>('select status from agents where id = $1', [sw.engine_agent_id]); if (a?.status === 'active') await pauseAgent(actor, sw.engine_agent_id) }
        switchedOff.push(sw.agent_key)
      }
      if (!tierByKey(tier)?.buildYourOwn) await db.query('update custom_agents set enabled = false where org_id = $1', [orgId])
    }
    await audit(db, { orgId, entityType: 'library', entityId: 'plan', event: 'library.tier', actor: actor.label, detail: { from, to: tier, switched_off: switchedOff } })
    return { from, to: tier, switchedOff }
  })
}
