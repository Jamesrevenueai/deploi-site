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

const aad = (connectionId: string, kind: 'access' | 'refresh') => `office-connection:${connectionId}:${kind}`

export class OfficeAuthError extends Error { constructor(message: string) { super(message); this.name = 'OfficeAuthError' } }

/** tests only: replace the provider refresh call */
type Refresher = (provider: OfficeProvider, refreshToken: string, scopes: string[]) => Promise<OAuthTokens>
const defaultRefresher: Refresher = (p, t, s) => (p === 'hubspot' ? hubspotRefresh(t, s) : p === 'quickbooks' ? quickbooksRefresh(t) : googleRefresh(t, s))
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

/** A usable access token for a connection, refreshed (under a row lock) when it expires within the skew. */
export async function officeAccessToken(connectionId: string, now = new Date()): Promise<string> {
  const r = await admin(async (db): Promise<{ token: string } | { reauth: string; conn: { id: string; org_id: string; provider: string } }> => {
    const conn = await db.one<{ id: string; org_id: string; provider: OfficeProvider; status: string }>('select id, org_id, provider, status from office_connections where id = $1', [connectionId])
    if (!conn || conn.status === 'disconnected') throw new OfficeAuthError('the connection is disconnected')
    if (conn.status === 'needs_reauth') throw new OfficeAuthError('the connection needs to be reconnected')
    const c = await db.one<{ key_id: string; ciphertext: string; refresh_ciphertext: string | null; scopes: string[]; expires_at: string | null }>('select * from office_credentials where connection_id = $1 for update', [connectionId])
    if (!c) throw new OfficeAuthError('the connection has no stored authorization; reconnect it')
    const access = decryptSecret(c.key_id, c.ciphertext, aad(connectionId, 'access'))
    if (!c.expires_at || new Date(c.expires_at).getTime() - now.getTime() > officeConfig.refreshSkewMs) return { token: access }
    if (!c.refresh_ciphertext) return { reauth: 'the provider did not issue a refresh token', conn }
    const rt = decryptSecret(c.key_id, c.refresh_ciphertext, aad(connectionId, 'refresh'))
    try {
      const t = await refresher(conn.provider, rt, c.scopes)
      await saveOfficeTokens(db, connectionId, conn.org_id, { ...t, scopes: t.scopes.length ? t.scopes : c.scopes })
      await officeAudit(db, { orgId: conn.org_id, entityType: 'office_credential', entityId: connectionId, event: 'credential.refreshed', actor: 'system:office', detail: { provider: conn.provider } })
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
