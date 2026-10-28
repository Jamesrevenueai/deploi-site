/**
 * Platform credentials (e.g. Shopify offline access tokens) encrypted at rest with AES-256-GCM.
 * The key lives outside the database (CREDENTIALS_ENCRYPTION_KEY, base64 of 32 bytes). The
 * connection id is the additional authenticated data, so a ciphertext copied onto another
 * connection row fails to decrypt. Older keys stay usable for decryption during rotation
 * (CREDENTIALS_PREVIOUS_KEYS="<id>:<base64>,..."). Plaintext never leaves the server process,
 * is never logged and is never returned to a browser; the table is unreadable by user sessions.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Db } from '../db'
import { audit } from '../engine/audit'

const e = (k: string) => (process.env[k] ?? '').trim()

export class CredentialKeyMissing extends Error { constructor() { super('CREDENTIALS_ENCRYPTION_KEY is not configured'); this.name = 'CredentialKeyMissing' } }

type Key = { id: string; bytes: Buffer }

function parseKey(id: string, b64: string): Key {
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length !== 32) throw new Error(`credential key ${id} must be 32 bytes (base64)`)
  return { id, bytes }
}

export function currentKey(): Key {
  const raw = e('CREDENTIALS_ENCRYPTION_KEY')
  if (!raw) throw new CredentialKeyMissing()
  return parseKey(e('CREDENTIALS_KEY_ID') || 'k1', raw)
}

function keyById(id: string): Key {
  const cur = currentKey()
  if (cur.id === id) return cur
  for (const pair of e('CREDENTIALS_PREVIOUS_KEYS').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':')
    if (pair.slice(0, i) === id) return parseKey(id, pair.slice(i + 1))
  }
  throw new Error(`credential key ${id} is not available`)
}

export function encryptSecret(plaintext: string, aad: string): { keyId: string; ciphertext: string } {
  const key = currentKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { keyId: key.id, ciphertext: ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.') }
}

export function decryptSecret(keyId: string, ciphertext: string, aad: string): string {
  const [v, iv, tag, ct] = ciphertext.split('.')
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unrecognised credential format')
  const key = keyById(keyId)
  const d = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(iv, 'base64'))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8')
}

/** Store (or replace) the credential for a connection. Must run with the service role. */
export async function storeCredential(db: Db, input: { connectionId: string; orgId: string; secret: string; tokenKind?: 'offline' | 'online' | 'api_key_pair' | 'lwa_refresh'; scopes?: string[]; expiresAt?: Date | null; refreshSecret?: string | null; refreshExpiresAt?: Date | null; actor: string }) {
  const main = encryptSecret(input.secret, input.connectionId)
  const refresh = input.refreshSecret ? encryptSecret(input.refreshSecret, input.connectionId + ':refresh') : null
  await db.query(
    `insert into store_credentials (connection_id, org_id, token_kind, key_id, ciphertext, refresh_ciphertext, scopes, expires_at, refresh_expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (connection_id) do update set token_kind = excluded.token_kind, key_id = excluded.key_id, ciphertext = excluded.ciphertext,
       refresh_ciphertext = excluded.refresh_ciphertext, scopes = excluded.scopes, expires_at = excluded.expires_at, refresh_expires_at = excluded.refresh_expires_at`,
    [input.connectionId, input.orgId, input.tokenKind ?? 'offline', main.keyId, main.ciphertext, refresh?.ciphertext ?? null, input.scopes ?? [],
      input.expiresAt?.toISOString() ?? null, input.refreshExpiresAt?.toISOString() ?? null])
  await audit(db, { orgId: input.orgId, connectionId: input.connectionId, entityType: 'credential', entityId: input.connectionId, event: 'credential.stored', actor: input.actor,
    detail: { token_kind: input.tokenKind ?? 'offline', key_id: main.keyId, scopes: input.scopes ?? [], expires: Boolean(input.expiresAt) } })
}

export type LoadedCredential = { secret: string; refreshSecret: string | null; expiresAt: string | null; refreshExpiresAt: string | null; scopes: string[] }

/** Decrypt the credential for a connection (service role only). Returns null when none is stored. */
export async function loadCredential(db: Db, connectionId: string): Promise<LoadedCredential | null> {
  const r = await db.one<{ key_id: string; ciphertext: string; refresh_ciphertext: string | null; expires_at: string | null; refresh_expires_at: string | null; scopes: string[] }>(
    'select key_id, ciphertext, refresh_ciphertext, expires_at, refresh_expires_at, scopes from store_credentials where connection_id = $1', [connectionId])
  if (!r) return null
  return {
    secret: decryptSecret(r.key_id, r.ciphertext, connectionId),
    refreshSecret: r.refresh_ciphertext ? decryptSecret(r.key_id, r.refresh_ciphertext, connectionId + ':refresh') : null,
    expiresAt: r.expires_at, refreshExpiresAt: r.refresh_expires_at, scopes: r.scopes,
  }
}

export async function deleteCredential(db: Db, connectionId: string, orgId: string, actor: string, reason: string) {
  const r = await db.query('delete from store_credentials where connection_id = $1 returning id', [connectionId])
  if (r.length) await audit(db, { orgId, connectionId, entityType: 'credential', entityId: connectionId, event: 'credential.deleted', actor, detail: { reason } })
}
