/**
 * "How your agents act": read and change the owner's mode per action type (org_action_modes).
 * Anyone in the organization can see the settings; only owners and admins change them (assertCan 'settings').
 * Staff can read for support and never change them. Every change is audited with the before and after mode.
 */
import { admin } from '../db'
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'
import { assertCan, actorRole } from '../platform/rbac'
import { ACTION_TYPE, DEFAULT_MODE, isActionMode, isMoneyAction, knownActionTypes, type ActionMode } from './index'

export type ModeRow = { key: string; label: string; money: boolean; mode: ActionMode; custom: boolean; updatedBy: string | null; updatedAt: string | null }
export type ModesView = { actions: ModeRow[]; money: ModeRow[]; canChange: boolean; defaultMode: ActionMode }

function orgOf(actor: Actor, orgId?: string) {
  if (actor.kind === 'staff') { if (!orgId) throw new EngineError('invalid_input', 'staff must name the organization'); return orgId }
  return actor.orgId
}

export async function listModes(actor: Actor, opts: { orgId?: string } = {}): Promise<ModesView> {
  const orgId = orgOf(actor, opts.orgId)
  const rows = await withActor(actor, db => db.query<{ action_type: string; mode: string; updated_by: string; updated_at: string }>(
    'select action_type, mode, updated_by, updated_at from org_action_modes where org_id = $1', [orgId]))
  const byKey = new Map(rows.map(r => [r.action_type, r]))
  const types = await knownActionTypes()
  // a stored setting for an action type no pack names any more is still shown, so it can be changed back
  for (const r of rows) if (!types.some(t => t.key === r.action_type)) types.push({ key: r.action_type, label: r.action_type.replace(/[_.]/g, ' '), money: false })
  const all = types.map(t => {
    const r = byKey.get(t.key)
    // the money guard: a money action always waits for the owner, whatever is stored
    return { key: t.key, label: t.label, money: t.money, mode: t.money ? 'ask_first' as const : isActionMode(r?.mode) ? r!.mode : DEFAULT_MODE, custom: Boolean(r), updatedBy: r?.updated_by ?? null, updatedAt: r ? new Date(r.updated_at).toISOString() : null }
  })
  const role = actor.kind === 'staff' ? null : await actorRole(actor, orgId)
  return { actions: all.filter(a => !a.money), money: all.filter(a => a.money), canChange: role === 'owner' || role === 'admin', defaultMode: DEFAULT_MODE }
}

/** Set one action type's mode. Owners and admins only; audited. Returns the stored mode. */
export async function setMode(actor: Actor, actionType: unknown, mode: unknown, opts: { ip?: string | null } = {}): Promise<{ actionType: string; mode: ActionMode; changed: boolean }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not change how a customer\'s agents act')
  if (typeof actionType !== 'string' || !ACTION_TYPE.test(actionType)) throw new EngineError('invalid_input', 'unknown action type')
  if (!isActionMode(mode)) throw new EngineError('invalid_input', 'mode must be act_and_tell or ask_first')
  if (isMoneyAction(actionType) && mode !== 'ask_first') throw new EngineError('invalid_input', 'an action that moves money always waits for your approval; it cannot be set to act on its own')
  await assertCan(actor, actor.orgId, 'settings')
  const types = await knownActionTypes()
  const stored = await admin(db => db.one('select 1 from org_action_modes where org_id = $1 and action_type = $2', [actor.orgId, actionType]))
  if (!types.some(t => t.key === actionType) && !stored) throw new EngineError('invalid_input', 'unknown action type')
  return admin(async db => {
    const before = await db.one<{ mode: ActionMode }>('select mode from org_action_modes where org_id = $1 and action_type = $2 for update', [actor.orgId, actionType])
    const prev = before?.mode ?? DEFAULT_MODE
    await db.query(`insert into org_action_modes (org_id, action_type, mode, updated_by) values ($1,$2,$3,$4)
      on conflict (org_id, action_type) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now()`, [actor.orgId, actionType, mode, actor.label.slice(0, 160)])
    await audit(db, { orgId: actor.orgId, entityType: 'org', entityId: actor.orgId, event: 'autonomy.mode_changed', actor: actor.label, detail: { action_type: actionType, from: prev, to: mode, ip: opts.ip ?? null } })
    return { actionType, mode, changed: prev !== mode }
  })
}
