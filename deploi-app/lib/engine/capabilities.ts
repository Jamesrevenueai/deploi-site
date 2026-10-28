/**
 * What each connector can correct, in platform-neutral terms. Agents, permissions and the audit trail
 * speak only of correction types ("oversell_policy", "price", ...) and fields; a connector declares,
 * for its platform, which check finds each type and which action keys write which field. Adding a
 * platform (WooCommerce, Amazon) means registering its connector, checks and capabilities here; no
 * agent, policy or audit code changes.
 */
import type { Platform } from './types'

export const CORRECTION_TYPES = ['oversell_policy', 'publication', 'price', 'sku'] as const
export type CorrectionType = typeof CORRECTION_TYPES[number]

export type CorrectionCapability = {
  type: CorrectionType
  /** the check that detects this kind of problem on this platform */
  checkKey: string
  /** action key -> the single platform field it writes */
  actions: Record<string, string>
}

/** Read-only checks an agent may run to report problems a person must handle (never writes). */
export type WatchCapability = { checkKey: string; label: string }

const corrections = new Map<Platform, Map<CorrectionType, CorrectionCapability>>()
const watches = new Map<Platform, Map<string, WatchCapability>>()
const actionIndex = new Map<string, { platform: Platform; type: CorrectionType; field: string }>()

export function registerCapabilities(platform: Platform, caps: { corrections?: CorrectionCapability[]; watch?: WatchCapability[] }) {
  const c = corrections.get(platform) ?? new Map<CorrectionType, CorrectionCapability>()
  for (const cap of caps.corrections ?? []) {
    for (const [actionKey, field] of Object.entries(cap.actions)) {
      const prev = actionIndex.get(actionKey)
      if (prev && (prev.platform !== platform || prev.type !== cap.type)) throw new Error(`action ${actionKey} is already registered for ${prev.platform}/${prev.type}`)
      actionIndex.set(actionKey, { platform, type: cap.type, field })
    }
    c.set(cap.type, cap)
  }
  corrections.set(platform, c)
  const w = watches.get(platform) ?? new Map<string, WatchCapability>()
  for (const cap of caps.watch ?? []) w.set(cap.checkKey, cap)
  watches.set(platform, w)
}

export const correctionCapability = (platform: Platform, type: CorrectionType) => corrections.get(platform)?.get(type) ?? null
export const supportedCorrections = (platform: Platform): CorrectionType[] => [...(corrections.get(platform)?.keys() ?? [])]
export const watchCapabilities = (platform: Platform): WatchCapability[] => [...(watches.get(platform)?.values() ?? [])]
export const isWatchCheck = (platform: Platform, checkKey: string) => Boolean(watches.get(platform)?.has(checkKey))

/** The correction type an action key belongs to, on any platform; undefined for unknown actions (always refused). */
export const correctionTypeForAction = (actionKey: string): CorrectionType | undefined => actionIndex.get(actionKey)?.type
/** The one field an action key writes; undefined for unknown actions (always refused). */
export const fieldForAction = (actionKey: string): string | undefined => actionIndex.get(actionKey)?.field

/** Every check key any agent correction or watch can use (the engine treats these as agent-owned). */
export function allAgentCheckKeys(): string[] {
  const out = new Set<string>()
  for (const m of corrections.values()) for (const c of m.values()) out.add(c.checkKey)
  for (const m of watches.values()) for (const w of m.values()) out.add(w.checkKey)
  return [...out]
}
