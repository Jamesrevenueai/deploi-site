/** Connector and check registry. Platform modules register themselves on import (see lib/connectors/index.ts). */
import type { CheckDef, Connector, Platform, ResourceRecord } from './types'

const connectors = new Map<Platform, Connector>()
const checks = new Map<string, CheckDef>()

export function registerConnector(c: Connector) { connectors.set(c.platform, c) }
export function registerCheck<R extends ResourceRecord>(c: CheckDef<R>) { checks.set(c.key, c as unknown as CheckDef) }

export function getConnector(p: Platform): Connector {
  const c = connectors.get(p)
  if (!c) throw new Error(`no connector registered for ${p}`)
  return c
}
export function getCheck(key: string): CheckDef | undefined { return checks.get(key) }
export function checksFor(p: Platform): CheckDef[] { return [...checks.values()].filter(c => c.platform === p) }
export function allChecks(): CheckDef[] { return [...checks.values()] }
export function allConnectors(): Connector[] { return [...connectors.values()] }
