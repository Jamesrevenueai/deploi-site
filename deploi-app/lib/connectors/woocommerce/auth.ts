/**
 * WooCommerce's official key-approval flow (/wc-auth/v1/authorize).
 *
 * 1. startAuthorization: a signed-in merchant names their store. Deploi records a one-time state bound to
 *    the organization, the person and the normalised site URL, valid for 30 minutes, and sends the browser
 *    to https://<store>/wc-auth/v1/authorize with app_name, scope=read_write, user_id=<state token>,
 *    return_url and callback_url. The token is `<state id>.<HMAC-SHA256 over id|org|site|expiry>`.
 * 2. receiveCallback: after the merchant approves in wp-admin, WooCommerce POSTs JSON
 *    {key_id, user_id, consumer_key, consumer_secret, key_permissions} to callback_url and requires an
 *    exact HTTP 200 (any other answer makes it delete the key). The callback is not signed by
 *    WooCommerce, so the state token is the only proof: it must verify, be unused, unexpired, and the
 *    permission must be read_write. The key pair is encrypted at once and the state consumed; anything
 *    else answers 400, so WooCommerce deletes the key it just made.
 * 3. finalizeAuthorization: validates the key with a live read and creates the connection. It runs after
 *    the callback has answered (WooCommerce waits for our 200 before its own request ends, and a store
 *    with a single PHP worker could not answer our read in the meantime), and again from the return_url
 *    redirect; it is idempotent.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { admin } from '../../db'
import { env } from '../../env'
import { audit } from '../../engine/audit'
import { EngineError } from '../../engine/errors'
import { encryptSecret, decryptSecret } from '../credentials'
import { decodeCreds, encodeCreds, validCreds } from './client'
import { normalizeSiteUrl } from './url'
import { WC_APP_NAME, wooConfig } from './config'
import { connectStore, type ConnectDeps } from './connect'

type StateRow = { id: string; org_id: string; created_by: string; profile_id: string | null; site_url: string; expires_at: string; used_at: string | null; status: string; status_reason: string | null; key_id: string | null; keys_ciphertext: string | null; key_permissions: string | null; connection_id: string | null }

function stateKey(): Buffer {
  const s = env.appSecret
  if (!s || s.length < 16) throw new EngineError('not_operational', 'APP_SECRET is not configured; WooCommerce authorization cannot be signed')
  return createHmac('sha256', s).update('deploi:woocommerce:auth-state:v1').digest()
}
const mac = (id: string, orgId: string, siteUrl: string, expiresAt: string) => createHmac('sha256', stateKey()).update(`${id}|${orgId}|${siteUrl}|${new Date(expiresAt).toISOString()}`).digest('base64url')

export const appBase = () => env.appUrl.replace(/\/+$/, '')
export const callbackUrl = () => `${appBase()}/api/woocommerce/callback`
export const returnUrl = () => `${appBase()}/api/woocommerce/return`

export function parseStateToken(token: unknown): { id: string; sig: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(token)
  return m ? { id: m[1], sig: m[2] } : null
}

function signatureOk(row: StateRow, sig: string): boolean {
  const want = Buffer.from(mac(row.id, row.org_id, row.site_url, row.expires_at))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got)
}

export function authorizeUrl(siteUrl: string, token: string): string {
  const u = new URL(`${siteUrl}/wc-auth/v1/authorize`)
  u.searchParams.set('app_name', WC_APP_NAME)
  u.searchParams.set('scope', 'read_write')
  u.searchParams.set('user_id', token)
  u.searchParams.set('return_url', returnUrl())
  u.searchParams.set('callback_url', callbackUrl())
  return u.toString()
}

/** Step 1. Returns the URL to send the merchant's browser to. */
export async function startAuthorization(input: { orgId: string; actor: string; profileId: string | null; siteUrl: unknown }, now = new Date()): Promise<{ stateId: string; token: string; authorizeUrl: string; siteUrl: string }> {
  const n = normalizeSiteUrl(input.siteUrl)
  if (!n.ok) throw new EngineError('invalid_input', n.reason)
  if (!callbackUrl().startsWith('https://')) throw new EngineError('not_operational', 'WooCommerce only sends keys to an https callback; Deploi must be served over https for this flow. Use "paste API keys" instead.')
  const expiresAt = new Date(now.getTime() + wooConfig.stateTtlMs).toISOString()
  const owner = await admin(db => db.one<{ org_id: string }>(`select org_id from store_connections where platform = 'woocommerce' and external_id = $1`, [n.siteUrl]))
  if (owner && owner.org_id !== input.orgId) throw new EngineError('forbidden', 'This store is already connected to another Deploi account.')
  const row = await admin(async db => {
    // one open authorization per organization at a time
    await db.query(`update woo_auth_states set status = 'failed', status_reason = 'superseded by a newer authorization', used_at = coalesce(used_at, now()) where org_id = $1 and status = 'pending'`, [input.orgId])
    const r = (await db.one<StateRow>(`insert into woo_auth_states (org_id, created_by, profile_id, site_url, expires_at) values ($1,$2,$3,$4,$5) returning *`, [input.orgId, input.actor, input.profileId, n.siteUrl, expiresAt]))!
    await audit(db, { orgId: input.orgId, entityType: 'connection', entityId: null, event: 'woocommerce.authorization_started', actor: input.actor, detail: { site_url: n.siteUrl, state_id: r.id, expires_at: expiresAt } })
    return r
  })
  const token = `${row.id}.${mac(row.id, row.org_id, row.site_url, row.expires_at)}`
  return { stateId: row.id, token, authorizeUrl: authorizeUrl(n.siteUrl, token), siteUrl: n.siteUrl }
}

export type CallbackResult = { status: 200 | 400; stateId: string | null; reason: string }

/** Step 2. The JSON WooCommerce posts. Answers 200 only when the keys were accepted and stored encrypted. */
export async function receiveCallback(body: unknown, now = new Date()): Promise<CallbackResult> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const parsed = parseStateToken(b.user_id)
  if (!parsed) return { status: 400, stateId: null, reason: 'unknown authorization' }
  return admin(async db => {
    const row = await db.one<StateRow>('select * from woo_auth_states where id = $1 for update', [parsed.id])
    if (!row || !signatureOk(row, parsed.sig)) return { status: 400 as const, stateId: null, reason: 'unknown authorization' }
    const fail = async (reason: string) => {
      if (row.status === 'pending') await db.query(`update woo_auth_states set status = 'failed', status_reason = $2, used_at = coalesce(used_at, now()) where id = $1`, [row.id, reason])
      await audit(db, { orgId: row.org_id, entityType: 'connection', event: 'woocommerce.callback_refused', actor: 'woocommerce:callback', detail: { state_id: row.id, reason } })
      return { status: 400 as const, stateId: row.id, reason }
    }
    if (row.used_at || row.status !== 'pending') return fail('this authorization was already used')
    if (new Date(row.expires_at).getTime() <= now.getTime()) return fail('this authorization expired; start again from Deploi')
    if (b.key_permissions !== 'read_write') return fail('the key must have Read/Write permission')
    const creds = { consumerKey: String(b.consumer_key ?? ''), consumerSecret: String(b.consumer_secret ?? '') }
    if (!validCreds(creds)) return fail('the callback did not contain a valid key pair')
    const enc = encryptSecret(encodeCreds(creds), `woo-auth-state:${row.id}`)
    const remoteKeyId = typeof b.key_id === 'number' && Number.isInteger(b.key_id) ? b.key_id : null
    await db.query(`update woo_auth_states set status = 'received', used_at = now(), key_id = $2, keys_ciphertext = $3, key_permissions = $4, status_reason = $5 where id = $1`,
      [row.id, enc.keyId, enc.ciphertext, 'read_write', remoteKeyId === null ? null : `remote key ${remoteKeyId}`])
    await audit(db, { orgId: row.org_id, entityType: 'connection', event: 'woocommerce.keys_received', actor: 'woocommerce:callback', detail: { state_id: row.id, site_url: row.site_url, key_permissions: 'read_write', remote_key_id: remoteKeyId } })
    return { status: 200 as const, stateId: row.id, reason: 'keys received' }
  })
}

export type FinalizeResult = { status: 'connected' | 'failed' | 'pending' | 'unknown'; connectionId: string | null; orgId: string | null; reason: string | null }

/** Step 3. Validate the received key live and create the connection. Idempotent and safe to call concurrently. */
export async function finalizeAuthorization(stateId: string, deps: ConnectDeps = {}): Promise<FinalizeResult> {
  const claimed = await admin(db => db.one<StateRow>(`update woo_auth_states set status = 'connecting' where id = $1 and status = 'received' returning *`, [stateId]))
  if (!claimed) {
    const r = await admin(db => db.one<StateRow>('select * from woo_auth_states where id = $1', [stateId]))
    if (!r) return { status: 'unknown', connectionId: null, orgId: null, reason: 'unknown authorization' }
    return { status: r.status === 'connected' ? 'connected' : r.status === 'failed' ? 'failed' : 'pending', connectionId: r.connection_id, orgId: r.org_id, reason: r.status_reason }
  }
  let creds = null
  try { creds = claimed.key_id && claimed.keys_ciphertext ? decodeCreds(decryptSecret(claimed.key_id, claimed.keys_ciphertext, `woo-auth-state:${claimed.id}`)) : null } catch { creds = null }
  const remoteKeyId = /^remote key (\d+)$/.exec(claimed.status_reason ?? '')?.[1]
  const settle = (status: 'connected' | 'failed', reason: string | null, connectionId: string | null) => admin(db => db.query(
    `update woo_auth_states set status = $2, status_reason = $3, connection_id = $4, key_id = null, keys_ciphertext = null where id = $1`, [claimed.id, status, reason, connectionId]))
  if (!creds) { await settle('failed', 'the received key could not be read', null); return { status: 'failed', connectionId: null, orgId: claimed.org_id, reason: 'the received key could not be read' } }
  try {
    const r = await connectStore({ orgId: claimed.org_id, actor: claimed.created_by, siteUrl: claimed.site_url, creds, permissions: 'read_write', via: 'authorize', remoteKeyId: remoteKeyId ? Number(remoteKeyId) : null }, deps)
    await settle('connected', r.webhooksError, r.connectionId)
    return { status: 'connected', connectionId: r.connectionId, orgId: claimed.org_id, reason: r.webhooksError }
  } catch (e) {
    const reason = (e as Error).message.slice(0, 300)
    await settle('failed', reason, null)
    return { status: 'failed', connectionId: null, orgId: claimed.org_id, reason }
  }
}

/** Erase key material left on states that never finished (crash between callback and finalize). */
export async function purgeStaleStates(now = new Date()): Promise<number> {
  const r = await admin(db => db.query(`update woo_auth_states set status = 'failed', status_reason = coalesce(status_reason, 'did not finish'), key_id = null, keys_ciphertext = null
    where status in ('pending','received','connecting') and expires_at < $1 returning id`, [new Date(now.getTime() - wooConfig.stateTtlMs).toISOString()]))
  return r.length
}
