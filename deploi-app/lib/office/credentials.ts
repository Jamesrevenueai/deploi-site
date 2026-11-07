/**
 * Office provider tokens at rest: AES-256-GCM (lib/connectors/credentials.ts) with the connection id in the
 * additional authenticated data, so a ciphertext copied onto another connection fails to decrypt. The table
 * is unreadable by user sessions. Access tokens are refreshed under a row lock shortly before they expire.
 */
import { admin, type Db } from '../db'
import { decryptSecret, encryptSecret } from '../connectors/credentials'
import { officeAudit } from './audit'
import { officeConfig, type OfficeProvider } from './config'
import { hubspotRefresh, type OAuthTokens } from './hubspot'
import { googleRefresh } from './calendar'
import { quickbooksRefresh } from './quickbooks'
import { salesforceRefresh } from './salesforce'
import { pipedriveRefresh } from './pipedrive'
import { zohoRefresh } from './zoho'
import type { TokenSource } from './token'

const aad = (connectionId: string, kind: 'access' | 'refresh') => `office-connection:${connectionId}:${kind}`

export class OfficeAuthError extends Error { constructor(message: string) { super(message); this.name = 'OfficeAuthError' } }

/** a refresh may move the connection to another provider host (Salesforce instance_url, Pipedrive api_domain) */
export type RefreshedTokens = OAuthTokens & { apiBase?: string | null }
/** tests only: replace the provider refresh call */
type Refresher = (provider: OfficeProvider, refreshToken: string, scopes: string[], ctx?: { apiBase: string | null }) => Promise<RefreshedTokens>
const defaultRefresher: Refresher = (p, t, s, ctx) => {
  switch (p) {
    case 'hubspot': return hubspotRefresh(t, s)
    case 'quickbooks': return quickbooksRefresh(t)
    case 'google_calendar': return googleRefresh(t, s)
    case 'salesforce': return salesforceRefresh(t, s)
    case 'pipedrive': return pipedriveRefresh(t, s)
    case 'zoho_crm': return zohoRefresh(t, s, ctx?.apiBase ?? null)
    case 'buildium': throw Object.assign(new Error('Buildium API keys do not expire and cannot be refreshed'), { auth: true })
  }
}
let refresher: Refresher = defaultRefresher
export function setOfficeRefresher(r: Refresher | null) { refresher = r ?? defaultRefresher }

export async function saveOfficeTokens(db: Db, connectionId: string, orgId: string, t: OAuthTokens) {
  const main = encryptSecret(t.accessToken, aad(connectionId, 'access'))
  const ref = t.refreshToken ? encryptSecret(t.refreshToken, aad(connectionId, 'refresh')) : null
  await db.query(`insert into office_credentials (connection_id, org_id, key_id, ciphertext, refresh_ciphertext, scopes, expires_at, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7, now()) on conflict (connection_id) do update set key_id = excluded.key_id, ciphertext = excluded.ciphertext,
    refresh_ciphertext = coalesce(excluded.refresh_ciphertext, office_credentials.refresh_ciphertext), scopes = excluded.scopes, expires_at = excluded.expires_at, updated_at = now()`,
    [connectionId, orgId, main.keyId, main.ciphertext, ref?.ciphertext ?? null, t.scopes, t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000).toISOString() : null])
}

export async function deleteOfficeCredential(db: Db, connectionId: string) {
  return (await db.query('delete from office_credentials where connection_id = $1 returning connection_id', [connectionId])).length > 0
}

/** Decrypted tokens (service role). Never returned to a browser and never logged. */
export async function loadOfficeTokens(db: Db, connectionId: string): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string[] } | null> {
  const c = await db.one<{ key_id: string; ciphertext: string; refresh_ciphertext: string | null; expires_at: string | null; scopes: string[] }>('select * from office_credentials where connection_id = $1', [connectionId])
  if (!c) return null
  return { accessToken: decryptSecret(c.key_id, c.ciphertext, aad(connectionId, 'access')), refreshToken: c.refresh_ciphertext ? decryptSecret(c.key_id, c.refresh_ciphertext, aad(connectionId, 'refresh')) : null, expiresAt: c.expires_at, scopes: c.scopes }
}

/**
 * A usable access token for a connection, refreshed (under a row lock) when it expires within the skew.
 * `force`: the provider just answered 401 to this token, so it is refreshed whatever its stored expiry says
 * (unless another request refreshed it meanwhile: then the newer token is used as it is).
 */
export async function officeAccessToken(connectionId: string, now = new Date(), opts: { force?: boolean; rejected?: string } = {}): Promise<string> {
  const r = await admin(async (db): Promise<{ token: string } | { reauth: string; conn: { id: string; org_id: string; provider: string } }> => {
    const conn = await db.one<{ id: string; org_id: string; provider: OfficeProvider; status: string; api_base: string | null }>('select id, org_id, provider, status, api_base from office_connections where id = $1', [connectionId])
    if (!conn || conn.status === 'disconnected') throw new OfficeAuthError('the connection is disconnected')
    if (conn.status === 'needs_reauth') throw new OfficeAuthError('the connection needs to be reconnected')
    const c = await db.one<{ key_id: string; ciphertext: string; refresh_ciphertext: string | null; scopes: string[]; expires_at: string | null }>('select * from office_credentials where connection_id = $1 for update', [connectionId])
    if (!c) throw new OfficeAuthError('the connection has no stored authorization; reconnect it')
    const access = decryptSecret(c.key_id, c.ciphertext, aad(connectionId, 'access'))
    const fresh = !c.expires_at || new Date(c.expires_at).getTime() - now.getTime() > officeConfig.refreshSkewMs
    // forced: refresh only when the stored token is still the one the provider refused
    if (fresh && !(opts.force && (opts.rejected === undefined || opts.rejected === access))) return { token: access }
    if (!c.refresh_ciphertext) return { reauth: opts.force ? 'the provider refused the stored authorization' : 'the provider did not issue a refresh token', conn }
    const rt = decryptSecret(c.key_id, c.refresh_ciphertext, aad(connectionId, 'refresh'))
    try {
      const t = await refresher(conn.provider, rt, c.scopes, { apiBase: conn.api_base })
      await saveOfficeTokens(db, connectionId, conn.org_id, { ...t, scopes: t.scopes.length ? t.scopes : c.scopes })
      if (t.apiBase && t.apiBase !== conn.api_base) await db.query('update office_connections set api_base = $2 where id = $1', [connectionId, t.apiBase])
      await officeAudit(db, { orgId: conn.org_id, entityType: 'office_credential', entityId: connectionId, event: 'credential.refreshed', actor: 'system:office', detail: { provider: conn.provider, forced: Boolean(opts.force) } })
      return { token: t.accessToken }
    } catch (e) {
      if ((e as { auth?: boolean }).auth) return { reauth: 'the provider no longer accepts this connection (revoked or expired)', conn }
      throw e
    }
  })
  if ('token' in r) return r.token
  // recorded in its own transaction, so the status survives the error below
  await admin(db => markReauth(db, r.conn, r.reauth))
  throw new OfficeAuthError('reconnect the connection')
}

async function markReauth(db: Db, conn: { id: string; org_id: string; provider: string }, reason: string) {
  await db.query(`update office_connections set status = 'needs_reauth', status_reason = $2 where id = $1`, [conn.id, reason])
  await officeAudit(db, { orgId: conn.org_id, entityType: 'office_connection', entityId: conn.id, event: 'connection.needs_reauth', actor: 'system:office', detail: { provider: conn.provider, reason } })
}

export function officeTokenSource(connectionId: string, onCall?: () => void): TokenSource {
  return {
    get: () => { onCall?.(); return officeAccessToken(connectionId) },
    refresh: rejected => { onCall?.(); return officeAccessToken(connectionId, new Date(), { force: true, rejected }) },
  }
}
