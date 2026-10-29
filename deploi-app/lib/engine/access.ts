/**
 * Store access (eligibility). Replaces the development-only LIVE_WRITE_STORES allowlist.
 *
 * Any shop can install the app and see its scan. Whether Deploi may write to the store, or send real
 * email for its organization, depends on the store's access, derived in code on every check:
 *   1. a staff decision (denied wins over everything; approved makes the store eligible)
 *   2. a redeemed beta invite
 *   3. Shopify reporting a development store (shop.plan.partnerDevelopment, read with the store's
 *      own token, so a merchant cannot claim it). Partners test on these; Shopify does not say whether its
 *      reviewers do, so the App Store submission runs in open mode.
 *   4. STORE_ACCESS_MODE=open (the public listing): every installed store
 * Anything else is "pending". LIVE_WRITES=off pauses writes to every real store (incident switch).
 * Synthetic stores are always eligible; they never reach Shopify.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db'
import { audit } from './audit'
import { EngineError } from './errors'
import type { ConnectionRow } from './types'

const e = (k: string) => (process.env[k] ?? '').trim()

export const accessConfig = {
  /** "beta" (default) until the public listing; then "open" */
  get mode(): 'beta' | 'open' { return e('STORE_ACCESS_MODE') === 'open' ? 'open' : 'beta' },
  /** emergency stop for writes to every real store */
  get writesPaused() { return e('LIVE_WRITES') === 'off' },
  /** how often Shopify is asked again whether a store is still a development store */
  factsMaxAgeMs: 24 * 3600e3,
  maxFailedCodesPerHour: 10,
}

export type AccessBasis = 'open_access' | 'development_store' | 'beta_invite' | 'staff_approved'
export type AccessStatus = 'eligible' | 'pending' | 'denied'

export type AccessRow = {
  id: string; platform: string; external_id: string; org_id: string | null
  status: AccessStatus; basis: AccessBasis | null
  is_development_store: boolean | null; plan_name: string | null; facts_checked_at: string | null
  invite_id: string | null; requested_at: string | null; request_note: string | null
  staff_decision: 'approved' | 'denied' | null; decided_by: string | null; decided_at: string | null; reason: string | null
  created_at: string; updated_at: string
}

export type AccessState = {
  eligible: boolean
  status: AccessStatus
  basis: AccessBasis | 'synthetic' | null
  mode: 'beta' | 'open'
  /** a plain sentence for the merchant */
  reason: string
  isDevelopmentStore: boolean | null
  requestedAt: string | null
  writesPaused: boolean
}

export const BASIS_LABEL: Record<AccessBasis | 'synthetic', string> = {
  open_access: 'Open to all stores',
  development_store: 'Shopify development store',
  beta_invite: 'Beta invite',
  staff_approved: 'Approved by Deploi',
  synthetic: 'Synthetic test store',
}

type Facts = Pick<AccessRow, 'staff_decision' | 'invite_id' | 'is_development_store'>

/** The rules, as a pure function of the stored facts and the mode. */
export function decide(row: Facts | null, mode: 'beta' | 'open'): { status: AccessStatus; basis: AccessBasis | null } {
  if (row?.staff_decision === 'denied') return { status: 'denied', basis: null }
  if (row?.staff_decision === 'approved') return { status: 'eligible', basis: 'staff_approved' }
  if (row?.invite_id) return { status: 'eligible', basis: 'beta_invite' }
  if (row?.is_development_store) return { status: 'eligible', basis: 'development_store' }
  if (mode === 'open') return { status: 'eligible', basis: 'open_access' }
  return { status: 'pending', basis: null }
}

function reasonFor(status: AccessStatus, basis: AccessBasis | null): string {
  if (status === 'denied') return 'Deploi has not enabled changes for this store. Contact support if you think this is a mistake.'
  if (status === 'pending') return 'Deploi is in beta. Your store is scanned and you can review what Deploi finds, but it will not change anything or send email until your store is enabled. Enter an invite code or request access.'
  return `Enabled: ${BASIS_LABEL[basis ?? 'open_access'].toLowerCase()}.`
}

type ConnRef = Pick<ConnectionRow, 'id' | 'org_id' | 'platform' | 'external_id' | 'is_synthetic'>

export async function loadAccessRow(db: Db, platform: string, externalId: string): Promise<AccessRow | null> {
  return db.one<AccessRow>('select * from store_access where platform = $1 and external_id = $2', [platform, externalId.toLowerCase()])
}

/** Current access for a connection. Derived live, so a change of mode takes effect at once. */
export async function getAccess(db: Db, conn: ConnRef): Promise<AccessState> {
  const paused = accessConfig.writesPaused && !conn.is_synthetic
  if (conn.is_synthetic) return { eligible: true, status: 'eligible', basis: 'synthetic', mode: accessConfig.mode, reason: 'Synthetic test store: nothing reaches Shopify.', isDevelopmentStore: null, requestedAt: null, writesPaused: false }
  const row = await loadAccessRow(db, conn.platform, conn.external_id)
  const d = decide(row, accessConfig.mode)
  return { eligible: d.status === 'eligible', status: d.status, basis: d.basis, mode: accessConfig.mode, reason: reasonFor(d.status, d.basis), isDevelopmentStore: row?.is_development_store ?? null, requestedAt: row?.requested_at ?? null, writesPaused: paused }
}

/** Why a write to this store must not happen, or null. */
export async function writeBlockReason(db: Db, conn: ConnRef): Promise<string | null> {
  if (conn.is_synthetic) return null
  if (accessConfig.writesPaused) return 'writes to live stores are paused by Deploi (LIVE_WRITES=off)'
  const a = await getAccess(db, conn)
  return a.eligible ? null : a.status === 'denied' ? 'Deploi has not enabled changes for this store' : 'this store is not enabled for changes yet (beta access)'
}

/** Real email for an organization needs at least one enabled store connection. */
export async function emailBlockReason(db: Db, orgId: string): Promise<string | null> {
  const conns = await db.query<ConnRef & { status: string }>(`select id, org_id, platform, external_id, is_synthetic, status from store_connections where org_id = $1 and status = 'active'`, [orgId])
  for (const c of conns) if (c.is_synthetic || (await getAccess(db, c)).eligible) return null
  return conns.length ? 'this store is not enabled for real email yet (beta access)' : 'no connected store is enabled for real email'
}

/** Persist the derived status (for staff lists and the merchant's own read) and audit transitions. */
async function settle(db: Db, row: AccessRow, actor: string, why: string): Promise<AccessRow> {
  const d = decide(row, accessConfig.mode)
  if (d.status === row.status && d.basis === row.basis) return row
  const next = (await db.one<AccessRow>('update store_access set status = $2, basis = $3 where id = $1 returning *', [row.id, d.status, d.basis]))!
  if (row.org_id) {
    const conn = await db.one<{ id: string }>('select id from store_connections where platform = $1 and external_id = $2', [row.platform, row.external_id])
    await audit(db, { orgId: row.org_id, connectionId: conn?.id ?? null, entityType: 'access', entityId: row.id, event: `access.${d.status}`, actor, detail: { from: row.status, basis: d.basis, mode: accessConfig.mode, why } })
  }
  return next
}

export type ShopFacts = { isDevelopmentStore: boolean | null; planName: string | null }

/** At install, reinstall or a periodic re-check: record what Shopify says about the shop. */
export async function recordShopFacts(db: Db, conn: ConnRef, facts: ShopFacts, actor: string): Promise<AccessRow> {
  const row = (await db.one<AccessRow>(
    `insert into store_access (platform, external_id, org_id, is_development_store, plan_name, facts_checked_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (platform, external_id) do update set org_id = excluded.org_id,
       is_development_store = coalesce(excluded.is_development_store, store_access.is_development_store),
       plan_name = coalesce(excluded.plan_name, store_access.plan_name), facts_checked_at = now()
     returning *`,
    [conn.platform, conn.external_id.toLowerCase(), conn.org_id, facts.isDevelopmentStore, facts.planName]))!
  return settle(db, row, actor, 'shop facts from Shopify')
}

export function factsStale(row: AccessRow | null, now = Date.now()): boolean {
  return !row?.facts_checked_at || now - new Date(row.facts_checked_at).getTime() > accessConfig.factsMaxAgeMs
}

// ------------------------------------------------------------------ invites

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function normalizeCode(code: string): string { return code.toUpperCase().replace(/[^A-Z0-9]/g, '') }
export function hashCode(code: string): string { return createHash('sha256').update(`deploi-invite:${normalizeCode(code)}`).digest('hex') }

function newCode(): string {
  const bytes = randomBytes(15)
  const chars = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `DPL-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}`
}

export type InviteRow = { id: string; label: string; shop_domain: string | null; max_uses: number; uses: number; expires_at: string; created_by: string; revoked_at: string | null; created_at: string }

/** Staff: create an invite. The plain code is returned once and never stored. */
export async function createInvite(db: Db, input: { label: string; shopDomain?: string | null; days?: number; maxUses?: number }, createdBy: string): Promise<{ invite: InviteRow; code: string }> {
  const label = input.label.trim().slice(0, 120)
  if (!label) throw new EngineError('invalid_input', 'an invite needs a label (who it is for)')
  const shop = input.shopDomain?.trim().toLowerCase() || null
  if (shop && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new EngineError('invalid_input', 'shop must be a *.myshopify.com domain')
  const days = Math.min(Math.max(Math.floor(input.days ?? 30), 1), 180)
  const maxUses = Math.min(Math.max(Math.floor(input.maxUses ?? 1), 1), 100)
  const code = newCode()
  const invite = (await db.one<InviteRow>(
    `insert into beta_invites (code_hash, label, shop_domain, max_uses, expires_at, created_by) values ($1,$2,$3,$4, now() + make_interval(days => $5), $6)
     returning id, label, shop_domain, max_uses, uses, expires_at, created_by, revoked_at, created_at`,
    [hashCode(code), label, shop, maxUses, days, createdBy]))!
  await audit(db, { orgId: null, entityType: 'access', entityId: invite.id, event: 'access.invite_created', actor: createdBy, detail: { label, bound_to_shop: shop, max_uses: maxUses, days } })
  return { invite, code }
}

export async function revokeInvite(db: Db, id: string, by: string): Promise<void> {
  const r = await db.one<{ id: string }>('update beta_invites set revoked_at = now() where id = $1 and revoked_at is null returning id', [id])
  if (r) await audit(db, { orgId: null, entityType: 'access', entityId: id, event: 'access.invite_revoked', actor: by })
}

async function ensureRow(db: Db, conn: ConnRef): Promise<AccessRow> {
  return (await db.one<AccessRow>(
    `insert into store_access (platform, external_id, org_id) values ($1,$2,$3)
     on conflict (platform, external_id) do update set org_id = excluded.org_id returning *`,
    [conn.platform, conn.external_id.toLowerCase(), conn.org_id]))!
}

export type RedeemResult = { ok: true; access: AccessState } | { ok: false; error: string }
const INVALID = 'that invite code is not valid for this store'

/**
 * Merchant: redeem a beta invite for their own store. Failed attempts are limited per store. A bad
 * code is returned, not thrown, so the audited failure commits with the caller's transaction.
 */
export async function redeemInvite(db: Db, conn: ConnRef, code: string, actor: string): Promise<RedeemResult> {
  if (conn.is_synthetic) return { ok: true, access: await getAccess(db, conn) }
  const row = await ensureRow(db, conn)
  // counted per access record (the audit trail is append-only; erasing the shop's record resets it)
  const failures = await db.one<{ n: string }>(`select count(*)::text as n from engine_audit where entity_type = 'access' and entity_id = $1 and event = 'access.invite_failed' and at > now() - interval '1 hour'`, [row.id])
  if (Number(failures?.n ?? 0) >= accessConfig.maxFailedCodesPerHour) throw new EngineError('too_many_attempts', 'too many invite codes tried; wait an hour and try again')
  const fail = async (why: string): Promise<RedeemResult> => {
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'access', entityId: row.id, event: 'access.invite_failed', actor, detail: { why } })
    return { ok: false, error: INVALID }
  }
  const normalized = normalizeCode(code)
  if (normalized.length < 10 || normalized.length > 40) return fail('malformed')
  const inv = await db.one<InviteRow>('select * from beta_invites where code_hash = $1', [hashCode(normalized)])
  if (!inv) return fail('unknown')
  if (inv.shop_domain && inv.shop_domain !== conn.external_id.toLowerCase()) return fail('bound to another shop')
  if (row.invite_id === inv.id) return { ok: true, access: await getAccess(db, conn) }
  const used = await db.one<{ id: string }>(`update beta_invites set uses = uses + 1 where id = $1 and uses < max_uses and revoked_at is null and expires_at > now() returning id`, [inv.id])
  if (!used) return fail(inv.revoked_at ? 'revoked' : new Date(inv.expires_at).getTime() <= Date.now() ? 'expired' : 'used up')
  const updated = (await db.one<AccessRow>('update store_access set invite_id = $2 where id = $1 returning *', [row.id, inv.id]))!
  await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'access', entityId: row.id, event: 'access.invite_redeemed', actor, detail: { invite_id: inv.id, label: inv.label } })
  await settle(db, updated, actor, 'beta invite redeemed')
  return { ok: true, access: await getAccess(db, conn) }
}

/** Merchant: ask Deploi to enable the store. */
export async function requestAccess(db: Db, conn: ConnRef, note: string, actor: string): Promise<AccessState> {
  const row = await ensureRow(db, conn)
  await db.query('update store_access set requested_at = now(), request_note = $2 where id = $1', [row.id, note.trim().slice(0, 500) || null])
  await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'access', entityId: row.id, event: 'access.requested', actor, detail: { has_note: Boolean(note.trim()) } })
  return getAccess(db, conn)
}

/** Staff: approve, deny or clear the decision for a store. */
export async function decideAccess(db: Db, id: string, decision: 'approved' | 'denied' | 'clear', reason: string, by: string): Promise<AccessRow> {
  const row = await db.one<AccessRow>(
    `update store_access set staff_decision = $2, decided_by = $3, decided_at = now(), reason = $4 where id = $1 returning *`,
    [id, decision === 'clear' ? null : decision, by, reason.trim().slice(0, 300) || null])
  if (!row) throw new EngineError('not_found', 'no such store')
  if (row.org_id) {
    const conn = await db.one<{ id: string }>('select id from store_connections where platform = $1 and external_id = $2', [row.platform, row.external_id])
    await audit(db, { orgId: row.org_id, connectionId: conn?.id ?? null, entityType: 'access', entityId: row.id, event: `access.staff_${decision}`, actor: by, detail: { reason: row.reason } })
  }
  return settle(db, row, by, `staff ${decision}`)
}

export type AccessListRow = AccessRow & { display_name: string | null; connection_status: string | null }

export async function listAccess(db: Db, filter: 'pending' | 'all' = 'pending'): Promise<AccessListRow[]> {
  return db.query<AccessListRow>(
    `select a.*, c.display_name, c.status as connection_status from store_access a
     left join store_connections c on c.platform = a.platform and c.external_id = a.external_id
     ${filter === 'pending' ? `where a.status = 'pending'` : ''}
     order by a.requested_at desc nulls last, a.created_at desc limit 200`)
}

export async function listInvites(db: Db): Promise<InviteRow[]> {
  return db.query<InviteRow>('select id, label, shop_domain, max_uses, uses, expires_at, created_by, revoked_at, created_at from beta_invites order by created_at desc limit 200')
}
