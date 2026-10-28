/** Merchant rules: one row per (connection, check). Missing rows are created with the check defaults. */
import type { Db } from '../db'
import { checksFor, getCheck } from './registry'
import type { ConnectionRow } from './types'
import { audit } from './audit'
import { EngineError } from './errors'

export type RuleRow = { id: string; org_id: string; connection_id: string; check_key: string; enabled: boolean; config: Record<string, unknown>; version: number; updated_by: string | null; updated_at: string }

export async function ensureRules(db: Db, conn: ConnectionRow): Promise<Map<string, RuleRow>> {
  for (const c of checksFor(conn.platform)) {
    await db.query(
      `insert into merchant_rules (org_id, connection_id, check_key, enabled, config, updated_by) values ($1,$2,$3,$4,$5,'system:defaults')
       on conflict (connection_id, check_key) do nothing`,
      [conn.org_id, conn.id, c.key, c.defaultEnabled, JSON.stringify(c.defaultConfig)])
  }
  const rows = await db.query<RuleRow>('select * from merchant_rules where connection_id = $1', [conn.id])
  return new Map(rows.map(r => [r.check_key, r]))
}

/** Change a rule (service role, after the caller authorised the actor). Bumps the version, which supersedes open proposals on the next scan. */
export async function updateRule(db: Db, input: { connectionId: string; checkKey: string; enabled?: boolean; config?: unknown; actor: string }): Promise<RuleRow> {
  const check = getCheck(input.checkKey)
  if (!check) throw new EngineError('invalid_input', 'unknown check')
  const cur = await db.one<RuleRow>('select * from merchant_rules where connection_id = $1 and check_key = $2 for update', [input.connectionId, input.checkKey])
  if (!cur) throw new EngineError('not_found', 'rule not found')
  let config = cur.config
  if (input.config !== undefined) {
    try { config = check.parseConfig(input.config) } catch (e) { throw new EngineError('invalid_input', (e as Error).message) }
  }
  const enabled = input.enabled ?? cur.enabled
  const row = await db.one<RuleRow>(
    `update merchant_rules set enabled = $3, config = $4, updated_by = $5 where connection_id = $1 and check_key = $2 returning *`,
    [input.connectionId, input.checkKey, enabled, JSON.stringify(config), input.actor])
  await audit(db, { orgId: cur.org_id, connectionId: input.connectionId, entityType: 'rule', entityId: cur.id, event: 'rule.updated', actor: input.actor,
    detail: { check_key: input.checkKey, enabled, config, from_version: cur.version, to_version: row!.version } })
  return row!
}
