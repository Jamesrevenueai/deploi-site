/**
 * Demo control for SYNTHETIC Office connections only (never a real account): make the synthetic provider
 * refuse Deploi's authorization, as a revoked grant would, so the Test -> Reconnect flow can be shown and
 * tested end to end. Reconnecting restores it (registry.ts#restoreSynthetic). Off in production unless
 * DEMO_CONTROLS=true (the route checks).
 */
import { admin } from '../db'
import { EngineError } from '../engine/errors'
import { assertMerchant, type Actor } from '../engine/actor'
import { injectOfficeFault } from '../office/synthetic'
import { injectQboFault } from '../office/quickbooks-synthetic'
import type { IntegrationKey } from './types'

export async function breakSyntheticConnection(actor: Actor, key: IntegrationKey, connectionId: string): Promise<{ message: string }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'staff cannot use demo controls for a customer')
  assertMerchant(actor, actor.orgId)
  if (key !== 'hubspot' && key !== 'google_calendar' && key !== 'quickbooks') throw new EngineError('invalid_input', 'demo controls exist for the synthetic Office connections only')
  const c = await admin(db => db.one<{ id: string; is_synthetic: boolean }>(`select id, is_synthetic from office_connections where id = $1 and org_id = $2 and provider = $3 and status <> 'disconnected'`, [connectionId, actor.orgId, key]))
  if (!c) throw new EngineError('not_found', 'connection not found')
  if (!c.is_synthetic) throw new EngineError('forbidden', 'demo controls only work on synthetic connections')
  const fault = { op: '*', mode: 'auth' as const, remaining: 1000 }
  if (key === 'quickbooks') await injectQboFault(c.id, fault)
  else await injectOfficeFault(c.id, fault)
  return { message: 'The synthetic provider now refuses Deploi\'s authorization, as a revoked grant would. Run Test to see it.' }
}
