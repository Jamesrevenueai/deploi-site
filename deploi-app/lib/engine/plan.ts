/**
 * A scan plan says which checks run, with which configuration, on which records, on whose behalf.
 * Two sources: the connection's legacy merchant rules (agentId null), or an agent's active policy.
 * Both run through the same engine.
 */
import type { Db } from '../db'
import { checksFor, getCheck } from './registry'
import { ensureRules } from './rules'
import type { CheckContext, CheckDef, ConnectionRow, Finding, LookupKeys, ResourceRecord, StoreContext } from './types'
import type { ReferenceIndex } from '../agents/references'

export type PlannedCheck = { check: CheckDef; config: Record<string, unknown>; version: number }

export type ScanPlan = {
  agentId: string | null
  policyId: string | null
  policyVersion: number | null
  checks: PlannedCheck[]
  /** records outside the scope are never examined (and are blocked at execution) */
  scope: ((r: ResourceRecord) => boolean) | null
  references: Record<string, ReferenceIndex>
  currency: string | null
  /** check keys owned by this plan (live issues for other keys are left alone) */
  ownedCheckKeys: string[]
}

export async function legacyPlan(db: Db, conn: ConnectionRow): Promise<ScanPlan> {
  const rules = await ensureRules(db, conn)
  const checks: PlannedCheck[] = []
  for (const c of checksFor(conn.platform)) {
    const r = rules.get(c.key)
    if (r?.enabled) checks.push({ check: c, config: r.config, version: r.version })
  }
  return { agentId: null, policyId: null, policyVersion: null, checks, scope: null, references: {}, currency: conn.currency ?? null, ownedCheckKeys: [...rules.keys()] }
}

const lower = (s: string) => s.trim().toLowerCase()

export function buildStoreContext(records: ResourceRecord[], currency: string | null, complete: boolean): StoreContext {
  const bySku = new Map<string, Set<string>>(), byBarcode = new Map<string, Set<string>>(), byHandleTitle = new Map<string, Set<string>>()
  const put = (m: Map<string, Set<string>>, k: string, id: string) => { const s = m.get(k) ?? new Set(); s.add(id); m.set(k, s) }
  for (const r of records) {
    const sku = typeof r.sku === 'string' && r.sku ? r.sku : null
    if (sku) put(bySku, lower(sku), r.resourceId)
    for (const b of Array.isArray(r.barcodes) ? (r.barcodes as string[]) : []) if (b) put(byBarcode, b.trim(), r.resourceId)
    if (typeof r.productHandle === 'string' && typeof r.variantTitle === 'string') put(byHandleTitle, `${lower(r.productHandle)}|${lower(r.variantTitle)}`, r.resourceId)
  }
  return {
    currency, complete,
    variantIdsBySku: s => [...(bySku.get(lower(s)) ?? [])],
    variantIdsByBarcode: b => [...(byBarcode.get(b.trim()) ?? [])],
    variantIdsByHandleTitle: (h, t) => [...(byHandleTitle.get(`${lower(h)}|${lower(t)}`) ?? [])],
  }
}

export function contextFor(plan: ScanPlan, pc: PlannedCheck, store: StoreContext): CheckContext {
  return { ruleVersion: pc.version, agentId: plan.agentId, references: plan.references, store }
}

/** Run the plan's checks on one record; in-scope records only. */
export function detectWithPlan(record: ResourceRecord, plan: ScanPlan, store: StoreContext): Finding[] {
  if (plan.scope && !plan.scope(record)) return []
  const out: Finding[] = []
  for (const pc of plan.checks) {
    if (pc.check.resourceType !== record.resourceType) continue
    const f = pc.check.detect(record, pc.config, contextFor(plan, pc, store))
    if (Array.isArray(f)) out.push(...f)
    else if (f) out.push(f)
  }
  return out
}

/** Store-wide values the plan's checks need for targeted reads. */
export function lookupKeysFor(records: ResourceRecord[], plan: ScanPlan, store: StoreContext): LookupKeys {
  const keys: LookupKeys = { skus: [], barcodes: [], handles: [] }
  for (const r of records) for (const pc of plan.checks) {
    if (!pc.check.lookupKeys || pc.check.resourceType !== r.resourceType) continue
    const k = pc.check.lookupKeys(r, pc.config, contextFor(plan, pc, store))
    keys.skus.push(...k.skus); keys.barcodes.push(...k.barcodes); keys.handles.push(...k.handles)
  }
  return { skus: [...new Set(keys.skus.filter(Boolean))], barcodes: [...new Set(keys.barcodes.filter(Boolean))], handles: [...new Set(keys.handles.filter(Boolean))] }
}

export function planCheck(plan: ScanPlan, checkKey: string): PlannedCheck | undefined {
  return plan.checks.find(p => p.check.key === checkKey) ?? (getCheck(checkKey) ? undefined : undefined)
}
