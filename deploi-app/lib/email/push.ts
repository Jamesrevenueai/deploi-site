/**
 * Optional push for inbox reading (behind configuration; polling by the Email Operations run is the default).
 * A push only says "something changed": it triggers a normal sync of that account, which reads through the
 * official API with the account's own token. Nothing in a notification is stored or trusted beyond that.
 *
 * Gmail (users.watch -> Cloud Pub/Sub push subscription with authentication):
 *  - the push request carries `Authorization: Bearer <Google-signed OIDC ID token>`; it is verified here:
 *    RS256 signature against Google's published keys, iss accounts.google.com, aud = GMAIL_PUSH_AUDIENCE,
 *    email = GMAIL_PUSH_SERVICE_ACCOUNT with email_verified, not expired;
 *  - the body is { message: { data: base64(JSON { emailAddress, historyId }), messageId }, subscription }.
 *  Sources: cloud.google.com/pubsub/docs/authenticate-push-subscriptions, developers.google.com/workspace/gmail/api/guides/push.
 *
 * Microsoft Graph change notifications:
 *  - subscription validation: POST ?validationToken=... must be answered 200 text/plain with the token;
 *  - each notification's clientState must equal the secret set on the subscription (only its SHA-256 is
 *    stored; compared in constant time); the subscriptionId must be one Deploi created.
 *  Sources: learn.microsoft.com/graph/change-notifications-delivery-webhooks.
 */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { admin } from '../db'
import { emailFetch } from './adapters/http'
import { emailConfig } from './config'

export const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string }
let jwksCache: { at: number; keys: Jwk[] } | null = null
/** tests only */
export function resetPushKeys() { jwksCache = null }

async function googleKeys(now: number): Promise<Jwk[]> {
  if (jwksCache && now - jwksCache.at < 3600e3) return jwksCache.keys
  const res = await emailFetch(GOOGLE_CERTS, { method: 'GET' })
  if (!res.ok) throw new Error(`could not load Google's signing keys (${res.status})`)
  const j = (await res.json()) as { keys?: Jwk[] }
  jwksCache = { at: now, keys: Array.isArray(j.keys) ? j.keys : [] }
  return jwksCache.keys
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>

/** Verify a Pub/Sub push OIDC token. Returns null when valid, else the reason (never throws). */
export async function verifyGooglePushToken(authorization: string | null, now = Date.now()): Promise<string | null> {
  if (!emailConfig.gmailPushEnabled) return 'push is not configured'
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '')
  if (!m) return 'missing bearer token'
  let header: Record<string, unknown>, claims: Record<string, unknown>
  try { header = b64json(m[1]); claims = b64json(m[2]) } catch { return 'malformed token' }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return 'unexpected token algorithm'
  let keys: Jwk[]
  try { keys = await googleKeys(now) } catch { return 'signing keys unavailable' }
  let jwk = keys.find(k => k.kid === header.kid)
  if (!jwk) { jwksCache = null; try { jwk = (await googleKeys(now)).find(k => k.kid === header.kid) } catch { /* below */ } }
  if (!jwk || jwk.kty !== 'RSA') return 'unknown signing key'
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n!, e: jwk.e! }, format: 'jwk' })
    if (!verify('RSA-SHA256', Buffer.from(`${m[1]}.${m[2]}`), key, Buffer.from(m[3], 'base64url'))) return 'bad signature'
  } catch { return 'bad signature' }
  if (!GOOGLE_ISSUERS.includes(String(claims.iss))) return 'wrong issuer'
  if (claims.aud !== emailConfig.gmailPushAudience) return 'wrong audience'
  if (String(claims.email ?? '').toLowerCase() !== emailConfig.gmailPushServiceAccount || claims.email_verified !== true) return 'wrong service account'
  const exp = Number(claims.exp), iat = Number(claims.iat)
  if (!Number.isFinite(exp) || exp * 1000 < now - 60e3) return 'token expired'
  if (Number.isFinite(iat) && iat * 1000 > now + 300e3) return 'token issued in the future'
  return null
}

/** The Gmail accounts a verified push names (by address, among accounts whose inbox Deploi reads). */
export async function gmailPushAccounts(body: unknown): Promise<string[]> {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data
  if (typeof data !== 'string' || data.length > 4000) return []
  let email = ''
  try { email = String((JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as { emailAddress?: unknown }).emailAddress ?? '').toLowerCase() } catch { return [] }
  if (!email.includes('@') || email.length > 254) return []
  const rows = await admin(db => db.query<{ id: string }>(`select a.id from email_accounts a join email_sync_state s on s.account_id = a.id
    where a.provider = 'gmail' and a.status = 'active' and lower(a.address) = $1 and s.push_kind = 'gmail_watch'`, [email]))
  return rows.map(r => r.id)
}

const sha = (s: string) => createHash('sha256').update(s).digest()

/** The accounts named by valid Graph notifications (known subscription and matching clientState). */
export async function graphNotificationAccounts(body: unknown): Promise<{ accounts: string[]; rejected: number }> {
  const value = (body as { value?: unknown } | null)?.value
  const list = Array.isArray(value) ? value.slice(0, 100) : []
  const accounts = new Set<string>()
  let rejected = 0
  for (const n of list as { subscriptionId?: unknown; clientState?: unknown }[]) {
    const sub = typeof n?.subscriptionId === 'string' ? n.subscriptionId.slice(0, 200) : ''
    const cs = typeof n?.clientState === 'string' ? n.clientState.slice(0, 500) : ''
    const st = sub ? await admin(db => db.one<{ account_id: string; push_secret_hash: string | null }>(`select account_id, push_secret_hash from email_sync_state where push_kind = 'graph_subscription' and push_id = $1`, [sub])) : null
    if (!st?.push_secret_hash || !cs || !timingSafeEqual(sha(cs), Buffer.from(st.push_secret_hash, 'hex'))) { rejected++; continue }
    accounts.add(st.account_id)
  }
  return { accounts: [...accounts], rejected }
}
