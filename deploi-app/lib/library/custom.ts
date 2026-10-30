/**
 * "Build your own agent" (Pro): the merchant describes a job and picks a permission level, defaulting
 * to the most restrictive. The job is matched to the library's capabilities (the twelve runners), and
 * the agent runs those capabilities under its own permission, logging to its own key. A job that
 * matches nothing is accepted but reported honestly as "no capability matches this yet".
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { isPermissionLevel, tierByKey, type PermissionLevel } from './config'
import { LibraryError } from './errors'
import { runLibraryAgent, type LibraryRunResult } from './actions'
import { matchCapabilities } from './runners'
import { orgTier } from './switches'

export type CustomAgentRow = { id: string; org_id: string; name: string; job: string; permission: PermissionLevel; enabled: boolean; created_by: string; created_at: string }

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new LibraryError('forbidden', 'custom agents belong to a merchant')
  return actor.orgId
}

export async function createCustomAgent(actor: Actor, input: { name: string; job: string; permission?: unknown }) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const name = String(input.name ?? '').trim(), job = String(input.job ?? '').trim()
  if (!name || name.length > 80) throw new LibraryError('invalid_input', 'name must be 1 to 80 characters')
  if (!job || job.length > 2000) throw new LibraryError('invalid_input', 'describe the job in up to 2000 characters')
  // the default is the most restrictive level; anything else must be chosen on purpose
  const permission: PermissionLevel = input.permission === undefined || input.permission === null || input.permission === '' ? 'read' : isPermissionLevel(input.permission) ? input.permission : (() => { throw new LibraryError('invalid_input', 'permission must be read, draft or act') })()
  return admin(async db => {
    const tier = await orgTier(db, orgId)
    if (!tierByKey(tier)?.buildYourOwn) throw new LibraryError('upgrade_required', 'Build your own agent is included in the Pro tier', { tier, upgradeTo: 'pro' })
    const row = await db.one<{ id: string }>('insert into custom_agents (org_id, name, job, permission, created_by) values ($1,$2,$3,$4,$5) returning id', [orgId, name, job, permission, actor.label])
    await audit(db, { orgId, entityType: 'library', entityId: `custom:${row!.id}`, event: 'library.custom.created', actor: actor.label, detail: { name, permission, capabilities: matchCapabilities(job) } })
    return { id: row!.id, name, job, permission, capabilities: matchCapabilities(job) }
  })
}

export async function updateCustomAgent(actor: Actor, id: string, patch: { enabled?: boolean; permission?: unknown; job?: string; name?: string }) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const row = await withActor(actor, db => db.one<CustomAgentRow>('select * from custom_agents where id = $1', [id]))
  if (!row) throw new LibraryError('not_found', 'custom agent not found')
  if (patch.permission !== undefined && !isPermissionLevel(patch.permission)) throw new LibraryError('invalid_input', 'permission must be read, draft or act')
  return admin(async db => {
    const tier = await orgTier(db, orgId)
    if (patch.enabled && !tierByKey(tier)?.buildYourOwn) throw new LibraryError('upgrade_required', 'Build your own agent is included in the Pro tier', { tier, upgradeTo: 'pro' })
    await db.query('update custom_agents set enabled = coalesce($2, enabled), permission = coalesce($3, permission), job = coalesce($4, job), name = coalesce($5, name) where id = $1',
      [id, patch.enabled ?? null, (patch.permission as string | undefined) ?? null, patch.job?.trim().slice(0, 2000) || null, patch.name?.trim().slice(0, 80) || null])
    if (patch.permission !== undefined && patch.permission !== 'act') await db.query('update library_auto_run_grants set revoked_at = now(), revoked_by = $3 where org_id = $1 and agent_key = $2 and revoked_at is null', [orgId, `custom:${id}`, actor.label])
    await audit(db, { orgId, entityType: 'library', entityId: `custom:${id}`, event: 'library.custom.updated', actor: actor.label, detail: { ...patch } })
    return (await db.one<CustomAgentRow>('select * from custom_agents where id = $1', [id]))!
  })
}

export async function deleteCustomAgent(actor: Actor, id: string) {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const row = await withActor(actor, db => db.one<CustomAgentRow>('select * from custom_agents where id = $1', [id]))
  if (!row) throw new LibraryError('not_found', 'custom agent not found')
  await admin(async db => {
    await db.query('delete from custom_agents where id = $1', [id])
    await audit(db, { orgId, entityType: 'library', entityId: `custom:${id}`, event: 'library.custom.deleted', actor: actor.label, detail: { name: row.name } })
  })
}

/** Runs each matched capability under the custom agent's own permission. Capabilities outside the merchant's tier are skipped and named. */
export async function runCustomAgent(actor: Actor, id: string, now = new Date()): Promise<{ capabilities: string[]; skippedLocked: string[]; results: LibraryRunResult[] }> {
  const orgId = orgOf(actor)
  assertMerchant(actor, orgId)
  const row = await withActor(actor, db => db.one<CustomAgentRow>('select * from custom_agents where id = $1', [id]))
  if (!row) throw new LibraryError('not_found', 'custom agent not found')
  const tier = await admin(db => orgTier(db, orgId))
  if (!tierByKey(tier)?.buildYourOwn) throw new LibraryError('upgrade_required', 'Build your own agent is included in the Pro tier', { tier, upgradeTo: 'pro' })
  if (!row.enabled) throw new LibraryError('conflict', 'this agent is switched off')
  const caps = matchCapabilities(row.job)
  const allowed = tierByKey(tier)?.agents ?? []
  const skippedLocked = caps.filter(c => !allowed.includes(c))
  const results: LibraryRunResult[] = []
  for (const cap of caps.filter(c => allowed.includes(c))) results.push(await runLibraryAgent({ orgId, agentKey: cap, trigger: 'manual', actor: actor.label, now, permission: row.permission, instructions: row.job, settings: {}, customAgentId: id }))
  if (!caps.length) await admin(db => audit(db, { orgId, entityType: 'library', entityId: `custom:${id}`, event: 'library.run.blocked', actor: actor.label, detail: { agent_key: `custom:${id}`, reason: 'no library capability matches this job yet', counts: { noted: 0, drafted: 0, done: 0, failed: 0, skipped: 0, approvedUnsent: 0 } } }))
  return { capabilities: caps, skippedLocked, results }
}
