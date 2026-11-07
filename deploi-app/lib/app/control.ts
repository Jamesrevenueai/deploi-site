/**
 * What the owner changes from the redesigned app: the workspace (store | office), an agent's autonomy level,
 * pausing and resuming an agent, and its standing instructions. Every change is bound to the actor's own
 * organization, checked against their role (lib/platform/rbac) and audited.
 *
 * Autonomy governs the agent through the mechanism its kind already has (never a second permission system):
 *   loop agents (store:<library key>, pack:<key>)  agent_profiles.autonomy, read by lib/events/loop.ts effectiveMode:
 *                                                  ask_first asks, act_then_tell / autonomous act (autonomous tells in
 *                                                  the daily summary only)
 *   store library agents (store:<library key>)     also the library permission: ask_first -> draft (auto-run grants end);
 *                                                  act_then_tell / autonomous -> act with an auto-run grant for each
 *                                                  writing action that is not approval-only
 *   Office agents (office:<uuid>)                  a new policy version with every tool at send_approved (ask_first)
 *                                                  or send_autonomous for a year (the others), granted by the owner
 *                                                  through the existing grant path (grantOfficePolicy)
 *   engine store agents (store:<uuid>)             approvalMode review (ask_first) or autonomous for a year, granted by
 *                                                  the owner (grantPolicy)
 * Money actions always wait for the owner whatever the level (lib/autonomy MONEY_ACTIONS; enforced in the loop).
 */
import { admin, type Db } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'
import { assertCan } from '../platform/rbac'
import { agentByKey } from '../library/config'
import { APPROVAL_ONLY } from '../library/actions'
import { isLibraryError } from '../library/errors'
import { setPermission, grantAutoRun, setSwitch } from '../library/switches'
import { editOfficeAgent, grantOfficePolicy, pauseOfficeAgent, resumeOfficeAgent } from '../office/agents'
import { parseOfficePolicy } from '../office/policy'
import { editAgent, grantPolicy, pauseAgent as pauseEngineAgent, resumeAgent as resumeEngineAgent } from '../agents/lifecycle'
import { parsePolicy } from '../agents/policy'
import { AGENT_REF, INSTRUCTION_MAX, MAX_INSTRUCTIONS, isAutonomy, profileFor, ensureProfiles, type AgentAutonomy } from './profiles'
import { findAgent, merchantOrg, isWorkspace } from './feeds'
import type { AutonomyResult, Instruction, Workspace } from './contract'

// ---------------------------------------------------------------- workspace

/** The person a preference belongs to: their profile, or the Shopify admin user. */
export function actorKey(actor: Actor): string {
  if (actor.kind === 'profile') return actor.session.uid
  if (actor.kind === 'shopify_user') return `shopify:${actor.shop}:${actor.userId}`.slice(0, 200)
  throw new EngineError('forbidden', 'Deploi staff view an organization from the staff console')
}

/**
 * Store when the organization has an active store connection; otherwise office when it turned Deploi Office on;
 * otherwise store when it has the commerce product (every new organization starts with it); otherwise office.
 */
export async function defaultWorkspace(db: Db, orgId: string): Promise<Workspace> {
  const r = await db.one<{ conn: boolean; office: boolean; commerce: boolean }>(`select exists (select 1 from store_connections where org_id = $1 and status = 'active') as conn,
      exists (select 1 from org_products where org_id = $1 and product = 'office' and status = 'active') as office,
      exists (select 1 from org_products where org_id = $1 and product = 'commerce' and status = 'active') as commerce`, [orgId])
  if (r?.conn) return 'store'
  if (r?.office) return 'office'
  return r?.commerce ? 'store' : 'office'
}

export async function getWorkspace(actor: Actor): Promise<{ workspace: Workspace; default: Workspace; chosen: boolean }> {
  const orgId = merchantOrg(actor)
  const key = actorKey(actor)
  return admin(async db => {
    const d = await defaultWorkspace(db, orgId)
    const r = await db.one<{ workspace: Workspace }>('select workspace from app_workspace_prefs where org_id = $1 and actor_key = $2', [orgId, key])
    return { workspace: r?.workspace ?? d, default: d, chosen: Boolean(r) }
  })
}

/** Any member may switch their own view (a preference, not a setting). */
export async function setWorkspace(actor: Actor, workspace: unknown): Promise<{ workspace: Workspace }> {
  const orgId = merchantOrg(actor)
  if (!isWorkspace(workspace)) throw new EngineError('invalid_input', 'workspace must be store or office')
  const key = actorKey(actor)
  await admin(db => db.query(`insert into app_workspace_prefs (org_id, actor_key, workspace) values ($1,$2,$3)
    on conflict (org_id, actor_key) do update set workspace = excluded.workspace, updated_at = now()`, [orgId, key, workspace]))
  return { workspace }
}

// ---------------------------------------------------------------- autonomy

const yearFrom = (now: Date) => new Date(now.getTime() + 365 * 864e5 - 3600e3).toISOString()

/**
 * Set an agent's autonomy level. Owners and admins only (it widens or narrows what the agent may do). The level
 * is applied to the agent's own mechanism first; only when that worked is it stored (and read by the loop).
 */
export async function setAgentAutonomy(actor: Actor, id: string, level: unknown, opts: { now?: Date } = {}): Promise<AutonomyResult> {
  const orgId = merchantOrg(actor)
  if (!isAutonomy(level)) throw new EngineError('invalid_input', 'autonomy must be ask_first, act_then_tell or autonomous')
  await assertCan(actor, orgId, 'agent.grant')
  const now = opts.now ?? new Date()
  const { src } = await admin(db => findAgent(db, orgId, id))
  const applied: string[] = []
  const ask = level === 'ask_first'
  if (src.kind === 'store' && src.loopKey) {
    const cfg = agentByKey(src.key)
    // a commerce agent that runs without a switch row (on by default) keeps running: its switch is created switched on
    if (src.on) await admin(db => db.query('insert into library_switches (org_id, agent_key, enabled, switched_by, switched_at) values ($1,$2,true,$3,now()) on conflict (org_id, agent_key) do nothing', [orgId, src.key, actor.label.slice(0, 160)]))
    try {
      await setPermission(actor, src.key, ask ? 'draft' : 'act')
      applied.push(`library permission: ${ask ? 'draft (every change waits for you)' : 'act'}`)
      if (!ask) for (const t of cfg?.actionTypes ?? []) {
        if (!t.writes || APPROVAL_ONLY.has(t.key)) continue
        await grantAutoRun(actor, src.key, t.key)
        applied.push(`auto-run: ${t.label}`)
      }
    } catch (e) {
      // a library agent outside the plan's tier keeps its library permission; the commerce loop below still follows the level
      if (!(isLibraryError(e) && e.code === 'upgrade_required')) throw e
      applied.push(`library permission unchanged: ${e.message}`)
    }
    applied.push(`loop: ${ask ? 'asks you first' : 'acts, then tells you'}${level === 'autonomous' ? ' (daily summary only)' : ''}; money actions always ask`)
  } else if (src.kind === 'store' && src.engineAgentId) {
    const cur = await admin(db => db.one<{ status: string; policy: unknown }>('select a.status, p.policy from agents a join agent_policies p on p.id = a.active_policy_id where a.id = $1 and a.org_id = $2', [src.engineAgentId, orgId]))
    if (!cur || cur.status !== 'active') throw new EngineError('not_pending', 'turn this agent on (grant it) before changing how much it may do on its own')
    const p = parsePolicy(cur.policy)
    const next = { ...p, approvalMode: ask ? 'review' : 'autonomous', validUntil: ask ? p.validUntil : yearFrom(now) }
    if (p.approvalMode !== next.approvalMode || next.validUntil !== p.validUntil) {
      const ed = await editAgent(actor, src.engineAgentId, { policy: next })
      if (ed.requiresGrant) await grantPolicy(actor, src.engineAgentId, ed.policyId, ed.policyHash)
      applied.push(`store authorization: ${ask ? 'review (you approve each change)' : 'autonomous within its limits for a year'} (version ${ed.version})`)
    }
  } else if (src.kind === 'office') {
    const cur = await admin(db => db.one<{ status: string; policy: unknown }>('select a.status, p.policy from office_agents a join office_agent_policies p on p.id = a.active_policy_id where a.id = $1 and a.org_id = $2', [src.officeAgentId, orgId]))
    if (!cur || cur.status !== 'active') throw new EngineError('not_pending', 'turn this agent on (grant it) before changing how much it may do on its own')
    const p = parseOfficePolicy(cur.policy) as Record<string, unknown> & ReturnType<typeof parseOfficePolicy>
    const tier = ask ? 'send_approved' : 'send_autonomous'
    const next: Record<string, unknown> = { ...p }
    let changed = false
    for (const t of ['email', 'calendar', 'crm'] as const) {
      const tool = p[t] as { tier: string; validUntil: string | null } | undefined
      if (!tool) continue
      const validUntil = ask ? null : yearFrom(now)
      if (tool.tier !== tier || (!ask && !tool.validUntil)) changed = true
      next[t] = { ...tool, tier, validUntil: tool.tier === tier && tool.validUntil && !ask ? tool.validUntil : validUntil }
    }
    if (changed) {
      const ed = await editOfficeAgent(actor, src.officeAgentId!, { policy: next })
      if (ed.requiresGrant) await grantOfficePolicy(actor, src.officeAgentId!, ed.policyId, ed.policyHash, { now })
      applied.push(`Office tools: ${tier === 'send_approved' ? 'each item waits for your approval' : 'acts within its limits for a year'} (version ${ed.version})`)
    }
  } else {
    applied.push(`loop: ${ask ? 'asks you first' : 'acts, then tells you'}${level === 'autonomous' ? ' (daily summary only)' : ''}; money actions always ask`)
  }
  return admin(async db => {
    await ensureProfiles(db, orgId, [id])
    const before = await db.one<{ autonomy: AgentAutonomy; autonomy_set_at: string | null }>('select autonomy, autonomy_set_at from agent_profiles where org_id = $1 and agent_ref = $2 for update', [orgId, id])
    await db.query(`update agent_profiles set autonomy = $3, autonomy_set_by = $4, autonomy_set_at = $5, updated_at = now() where org_id = $1 and agent_ref = $2`, [orgId, id, level, actor.label.slice(0, 160), now.toISOString()])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'app.agent_autonomy', actor: actor.label, detail: { agent: id, from: before?.autonomy_set_at ? before.autonomy : null, to: level, applied } })
    return { agentId: id, autonomy: level, changed: !before?.autonomy_set_at || before.autonomy !== level, applied }
  })
}

// ---------------------------------------------------------------- pause / resume

/** Pause an agent: the loop skips it, and its own switch (library, Office, engine) is turned off too. Owners and admins. */
export async function pauseAgent(actor: Actor, id: string): Promise<{ agentId: string; paused: true }> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'agent.grant')
  const { src } = await admin(db => findAgent(db, orgId, id))
  if (src.kind === 'store' && src.loopKey) {
    const sw = await admin(db => db.one<{ enabled: boolean }>('select enabled from library_switches where org_id = $1 and agent_key = $2', [orgId, src.key]))
    if (sw?.enabled) await setSwitch(actor, src.key, false)
  } else if (src.kind === 'office' && src.on) await pauseOfficeAgent(actor, src.officeAgentId!)
  else if (src.kind === 'store' && src.engineAgentId && src.on) await pauseEngineAgent(actor, src.engineAgentId)
  await admin(async db => {
    await ensureProfiles(db, orgId, [id])
    await db.query('update agent_profiles set paused_at = now(), paused_by = $3, updated_at = now() where org_id = $1 and agent_ref = $2', [orgId, id, actor.label.slice(0, 160)])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'app.agent_paused', actor: actor.label, detail: { agent: id } })
  })
  return { agentId: id, paused: true }
}

export async function resumeAgent(actor: Actor, id: string): Promise<{ agentId: string; paused: false }> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'agent.grant')
  const { src } = await admin(db => findAgent(db, orgId, id))
  const prof = await admin(db => profileFor(db, orgId, id))
  if (src.kind === 'store' && src.loopKey) {
    const sw = await admin(db => db.one<{ enabled: boolean }>('select enabled from library_switches where org_id = $1 and agent_key = $2', [orgId, src.key]))
    if (sw && !sw.enabled) await setSwitch(actor, src.key, true)
  } else if (src.kind === 'office' && !src.on) await resumeOfficeAgent(actor, src.officeAgentId!)
  else if (src.kind === 'store' && src.engineAgentId && !src.on) await resumeEngineAgent(actor, src.engineAgentId)
  if (prof?.paused_at) await admin(async db => {
    await db.query('update agent_profiles set paused_at = null, paused_by = null, updated_at = now() where org_id = $1 and agent_ref = $2', [orgId, id])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'app.agent_resumed', actor: actor.label, detail: { agent: id } })
  })
  return { agentId: id, paused: false }
}

// ---------------------------------------------------------------- standing instructions

type InstrRow = { id: string; agent_ref: string; text: string; position: number; created_by: string; created_at: string; updated_at: string }
const view = (r: InstrRow): Instruction => ({ id: r.id, agentId: r.agent_ref, text: r.text, position: r.position, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() })

export async function listInstructionsIn(db: Db, orgId: string, id: string): Promise<Instruction[]> {
  if (!AGENT_REF.test(id)) return []
  return (await db.query<InstrRow>('select * from agent_instructions where org_id = $1 and agent_ref = $2 order by position, created_at', [orgId, id])).map(view)
}

function cleanText(text: unknown): string {
  if (typeof text !== 'string') throw new EngineError('invalid_input', 'an instruction is text')
  const t = text.replace(/\u0000/g, '').trim()
  if (!t) throw new EngineError('invalid_input', 'an instruction cannot be empty')
  if (t.length > INSTRUCTION_MAX) throw new EngineError('invalid_input', `an instruction is at most ${INSTRUCTION_MAX} characters`)
  return t
}
const cleanPosition = (p: unknown): number | null => {
  if (p === undefined || p === null) return null
  const n = Number(p)
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new EngineError('invalid_input', 'position must be a whole number from 0')
  return n
}

/** Anyone in the organization can read an agent's instructions. */
export async function listInstructions(actor: Actor, id: string): Promise<Instruction[]> {
  const orgId = merchantOrg(actor)
  return admin(async db => { await findAgent(db, orgId, id); return listInstructionsIn(db, orgId, id) })
}

/** Add one instruction (owners and admins). */
export async function addInstruction(actor: Actor, id: string, input: { text: unknown; position?: unknown }): Promise<Instruction> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'settings')
  const text = cleanText(input.text)
  const pos = cleanPosition(input.position)
  return admin(async db => {
    await findAgent(db, orgId, id)
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 6465))`, [`agent-instructions:${orgId}:${id}`])
    const n = await db.one<{ n: number; max: number | null }>('select count(*)::int as n, max(position) as max from agent_instructions where org_id = $1 and agent_ref = $2', [orgId, id])
    if ((n?.n ?? 0) >= MAX_INSTRUCTIONS) throw new EngineError('invalid_input', `an agent has at most ${MAX_INSTRUCTIONS} standing instructions`)
    const r = (await db.one<InstrRow>(`insert into agent_instructions (org_id, agent_ref, text, position, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [orgId, id, text, pos ?? (n?.max ?? -1) + 1, actor.label.slice(0, 160)]))!
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'app.instruction_added', actor: actor.label, detail: { agent: id, instruction_id: r.id, length: text.length } })
    return view(r)
  })
}

export async function updateInstruction(actor: Actor, id: string, instructionId: string, input: { text?: unknown; position?: unknown }): Promise<Instruction> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'settings')
  if (!/^[0-9a-f-]{36}$/i.test(instructionId)) throw new EngineError('not_found', 'instruction not found')
  const text = input.text === undefined ? null : cleanText(input.text)
  const pos = cleanPosition(input.position)
  if (text === null && pos === null) throw new EngineError('invalid_input', 'nothing to change: send text or position')
  return admin(async db => {
    const r = await db.one<InstrRow>(`update agent_instructions set text = coalesce($4, text), position = coalesce($5, position), updated_by = $6, updated_at = now()
      where id = $1 and org_id = $2 and agent_ref = $3 returning *`, [instructionId, orgId, id, text, pos, actor.label.slice(0, 160)])
    if (!r) throw new EngineError('not_found', 'instruction not found')
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'app.instruction_changed', actor: actor.label, detail: { agent: id, instruction_id: r.id, text_changed: text !== null, position: pos } })
    return view(r)
  })
}

export async function deleteInstruction(actor: Actor, id: string, instructionId: string): Promise<{ deleted: true }> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'settings')
  if (!/^[0-9a-f-]{36}$/i.test(instructionId)) throw new EngineError('not_found', 'instruction not found')
  return admin(async db => {
    const r = await db.query('delete from agent_instructions where id = $1 and org_id = $2 and agent_ref = $3 returning id', [instructionId, orgId, id])
    if (!r.length) throw new EngineError('not_found', 'instruction not found')
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'app.instruction_deleted', actor: actor.label, detail: { agent: id, instruction_id: instructionId } })
    return { deleted: true as const }
  })
}
