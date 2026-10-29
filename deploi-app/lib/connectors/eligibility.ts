/**
 * Which real stores Deploi may write to (and which may not install at all). See migration 34.
 * Reads are never gated here: any installed store can be scanned and every finding shown. Only the
 * write path asks, right before writing, and a missing, expired or blocked row means "no".
 */
import type { Db } from '../db'
import { engineConfig } from '../engine/config'

export type Eligibility = { tier: 'beta' | 'review' | 'internal' | 'blocked' | 'none'; liveWrites: boolean; expiresAt: string | null; reason: string }

export async function storeEligibility(db: Db, shop: string, isSynthetic: boolean, now = new Date()): Promise<Eligibility> {
  if (isSynthetic) return { tier: 'internal', liveWrites: true, expiresAt: null, reason: 'synthetic test store' }
  const row = await db.one<{ tier: Eligibility['tier']; live_writes: boolean; expires_at: string | null }>('select tier, live_writes, expires_at from store_eligibility where shop = $1', [shop.toLowerCase()])
  if (row?.tier === 'blocked') return { tier: 'blocked', liveWrites: false, expiresAt: null, reason: 'this store is blocked from using Deploi' }
  // environment overrides for local and development use
  if (engineConfig.liveWritesAll || engineConfig.liveWriteStores.includes(shop.toLowerCase())) return { tier: row?.tier ?? 'internal', liveWrites: true, expiresAt: null, reason: 'enabled for this environment' }
  if (!row) return { tier: 'none', liveWrites: false, expiresAt: null, reason: 'changes to this store are not enabled yet: Deploi is in beta and enables writes per approved store' }
  const expired = row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime()
  if (expired) return { tier: row.tier, liveWrites: false, expiresAt: row.expires_at, reason: `this store's ${row.tier} access ended on ${new Date(row.expires_at!).toISOString().slice(0, 10)}` }
  if (!row.live_writes) return { tier: row.tier, liveWrites: false, expiresAt: row.expires_at, reason: 'changes to this store are not enabled for its access tier' }
  return { tier: row.tier, liveWrites: true, expiresAt: row.expires_at, reason: `${row.tier} store` }
}
