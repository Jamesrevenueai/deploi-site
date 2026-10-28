import { createHash } from 'node:crypto'
import type { Correction } from './types'

/** JSON with object keys sorted at every level, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
}

/**
 * The approval binds to this hash: the connection, the exact action, target, change, parameters,
 * preconditions and the rule version it was derived under. Any difference is a different change.
 */
export function changeHash(connectionId: string, correction: Correction, ruleVersion: number | null): string {
  const body = canonicalJson({
    v: 1,
    connectionId,
    actionKey: correction.actionKey,
    targetType: correction.targetType,
    targetId: correction.targetId,
    change: correction.change,
    params: correction.params ?? {},
    preconditions: correction.preconditions.map(p => ({ path: p.path, equals: p.equals })),
    ruleVersion,
  })
  return createHash('sha256').update(body).digest('hex')
}

/** Read a dotted path from a record ("inventoryPolicy", "product.status"). */
export function getPath(record: unknown, path: string): unknown {
  let cur: unknown = record
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}
