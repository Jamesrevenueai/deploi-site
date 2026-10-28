/**
 * Email accounts: connect through the provider's OAuth consent (authorization code + PKCE, one-time
 * state bound to the organization and the user who started it), store tokens encrypted, refresh
 * them under a row lock, check health, and disconnect. Mailbox passwords are never requested.
 * Connecting an account authorizes no agent; each agent's policy must name it.
 */
import { createHash, randomBytes } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { decryptSecret, encryptSecret } from '../connectors/credentials'
import { emailAdapter } from './adapters'
import { emailConfig } from './config'
import type { AccountRef, EmailProvider } from './types'

export type EmailAccountRow = {
  id: string; org_id: string; provider: EmailProvider; address: string; display_name: string | null
  status: 'active' | 'needs_reauth' | 'error' | 'disconnected'; status_reason: string | null; granted_scopes: string[]
  can_send: boolean; can_read: boolean; is_synthetic: boolean; last_checked_at: string | null; last_success_at: string | null
  last_error_code: string | null; connected_by: string; connected_at: string; disconnected_at: string | null
}

const b64url = (b: Buffer) => b.toString('base64url')
const aad = (accountId: string, kind: 'access' | 'refresh') => `email-account:${accountId}:${kind}`

export class EmailAuthError extends Error { constructor(message: string) { super(message); this.name = 'EmailAuthError' } }

export function providerStatus(p: EmailProvider): { configured: boolean; label: string } {
  const a = emailAdapter(p)
  return { configured: p === 'synthetic' ? emailConfig.syntheticAllowed : a.configured(), label: a.label }
}

/** Start connecting (or reconnecting) an account. Returns the provider consent URL. */
export async function startConnect(actor: Actor, input: { provider: EmailProvider; read?: boolean; accountId?: string | null; returnTo?: string | null }) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot connect a merchant mailbox')
  assertMerchant(actor, actor.orgId)
  const adapter = emailAdapter(input.provider)
  if (!providerStatus(input.provider).configured) throw new EngineError('not_operational', `${adapter.label} is not available in this environment yet`)
  const state = b64url(randomBytes(32))
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  let loginHint: string | null = null
  await admin(async db => {
    if (input.accountId) {
      const acc = await db.one<EmailAccountRow>('select * from email_accounts where id = $1 and org_id = $2', [input.accountId, actor.orgId])
      if (!acc || acc.provider !== input.provider) throw new EngineError('not_found', 'email account not found')
      loginHint = acc.address
    }
    const enc = encryptSecret(verifier, `email-oauth-state:${state}`)
    await db.query(`insert into email_oauth_states (state, org_id, provider, account_id, want_read, key_id, verifier_ciphertext, created_by, return_to, expires_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + interval '10 minutes')`,
      [state, actor.orgId, input.provider, input.accountId ?? null, Boolean(input.read), enc.keyId, enc.ciphertext, actor.label, safeReturn(input.returnTo)])
    await db.query(`delete from email_oauth_states where expires_at < now() - interval '1 day'`)
  })
  return { url: adapter.authorizeUrl({ state, codeChallenge: challenge, scopes: adapter.scopesFor({ read: Boolean(input.read) }), loginHint }) }
}

const safeReturn = (r: string | null | undefined) => (r && /^\/(store|shopify)(\/[\w\-/]*)?$/.test(r) ? r : null)

/** OAuth callback: single-use state, same organization and user, then code exchange, identity and encrypted storage. */
export async function completeConnect(actor: Actor, input: { state: string; code: string | null; error: string | null }) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot connect a merchant mailbox')
  const st = await admin(db => db.one<{ state: string; org_id: string; provider: EmailProvider; account_id: string | null; want_read: boolean; key_id: string; verifier_ciphertext: string; created_by: string; return_to: string | null }>(
    `update email_oauth_states set used_at = now() where state = $1 and used_at is null and expires_at > now() returning *`, [input.state]))
  if (!st) throw new EngineError('expired', 'this connection attempt expired or was already used; start again')
  if (st.org_id !== actor.orgId || st.created_by !== actor.label) throw new EngineError('forbidden', 'this connection attempt was started by someone else')
  if (input.error || !input.code) throw new EngineError('invalid_input', input.error === 'access_denied' ? 'you did not grant access, so nothing was connected' : 'the provider did not return an authorization code')
  const adapter = emailAdapter(st.provider)
  const verifier = decryptSecret(st.key_id, st.verifier_ciphertext, `email-oauth-state:${st.state}`)
  const requested = adapter.scopesFor({ read: st.want_read })
  const tokens = await adapter.exchangeCode(input.code, verifier, requested)
  const who = await adapter.identity(tokens.accessToken)
  const canSend = adapter.canSend(tokens.scopes), canRead = adapter.canRead(tokens.scopes)
  const result = await admin(async db => {
    let acc: EmailAccountRow | null = null
    if (st.account_id) {
      acc = await db.one<EmailAccountRow>('select * from email_accounts where id = $1 and org_id = $2 for update', [st.account_id, st.org_id])
      if (!acc) throw new EngineError('not_found', 'email account not found')
      if (acc.address.toLowerCase() !== who.address.toLowerCase()) throw new EngineError('invalid_input', `you signed in as ${who.address}, not ${acc.address}; reconnect with the same account or connect it as a new one`)
    } else {
      acc = await db.one<EmailAccountRow>(`select * from email_accounts where org_id = $1 and provider = $2 and lower(address) = lower($3) and status <> 'disconnected' for update`, [st.org_id, st.provider, who.address])
    }
    const status = canSend ? 'active' : 'error'
    const reason = canSend ? null : 'permission to send was not granted; reconnect and allow sending'
    if (acc) {
      acc = (await db.one<EmailAccountRow>(`update email_accounts set display_name = $2, status = $3, status_reason = $4, granted_scopes = $5, can_send = $6, can_read = $7,
        last_checked_at = now(), last_success_at = now(), last_error_code = null, disconnected_at = null where id = $1 returning *`,
        [acc.id, who.displayName, status, reason, tokens.scopes, canSend, canRead]))!
    } else {
      acc = (await db.one<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, display_name, status, status_reason, granted_scopes, can_send, can_read, is_synthetic, connected_by, last_checked_at, last_success_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now()) returning *`,
        [st.org_id, st.provider, who.address, who.displayName, status, reason, tokens.scopes, canSend, canRead, st.provider === 'synthetic', actor.label]))!
    }
    await saveTokens(db, acc.id, acc.org_id, tokens)
    await audit(db, { orgId: acc.org_id, entityType: 'credential', entityId: acc.id, event: st.account_id ? 'email_account.reconnected' : 'email_account.connected', actor: actor.label,
      detail: { provider: acc.provider, address: acc.address, scopes: tokens.scopes, can_send: canSend, can_read: canRead } })
    return acc
  })
  return { account: result, returnTo: st.return_to }
}

async function saveTokens(db: Db, accountId: string, orgId: string, t: { accessToken: string; refreshToken: string | null; expiresIn: number | null; scopes: string[] }) {
  const main = encryptSecret(t.accessToken, aad(accountId, 'access'))
  const ref = t.refreshToken ? encryptSecret(t.refreshToken, aad(accountId, 'refresh')) : null
  await db.query(`insert into email_credentials (account_id, org_id, key_id, ciphertext, refresh_ciphertext, scopes, expires_at, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7, now()) on conflict (account_id) do update set key_id = excluded.key_id, ciphertext = excluded.ciphertext,
    refresh_ciphertext = coalesce(excluded.refresh_ciphertext, email_credentials.refresh_ciphertext), scopes = excluded.scopes, expires_at = excluded.expires_at, updated_at = now()`,
    [accountId, orgId, main.keyId, main.ciphertext, ref?.ciphertext ?? null, t.scopes, t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000) : null])
}

export const accountRef = (a: EmailAccountRow): AccountRef => ({ id: a.id, orgId: a.org_id, provider: a.provider, address: a.address, scopes: a.granted_scopes })

/** A usable access token, refreshed under a row lock when close to expiry. Auth failures mark the account for reconnection. */
export async function accessToken(accountId: string): Promise<string> {
  return admin(async db => {
    const acc = await db.one<EmailAccountRow>('select * from email_accounts where id = $1', [accountId])
    if (!acc || acc.status === 'disconnected') throw new EmailAuthError('the email account is disconnected')
    const c = await db.one<{ key_id: string; ciphertext: string; refresh_ciphertext: string | null; scopes: string[]; expires_at: string | null }>('select * from email_credentials where account_id = $1 for update', [accountId])
    if (!c) throw new EmailAuthError('the email account has no stored authorization; reconnect it')
    const access = decryptSecret(c.key_id, c.ciphertext, aad(accountId, 'access'))
    if (!c.expires_at || new Date(c.expires_at).getTime() - Date.now() > 120_000) return access
    if (!c.refresh_ciphertext) { await markAuth(db, acc, 'the provider did not issue a refresh token; reconnect the account'); throw new EmailAuthError('reconnect the account') }
    const refreshToken = decryptSecret(c.key_id, c.refresh_ciphertext, aad(accountId, 'refresh'))
    try {
      const t = await emailAdapter(acc.provider).refresh(refreshToken, c.scopes)
      await saveTokens(db, accountId, acc.org_id, { ...t, scopes: t.scopes.length ? t.scopes : c.scopes })
      return t.accessToken
    } catch (e) {
      if ((e as { auth?: boolean }).auth) { await markAuth(db, acc, 'the provider no longer accepts this connection (revoked or expired); reconnect the account'); throw new EmailAuthError('reconnect the account') }
      throw e
    }
  })
}

async function markAuth(db: Db, acc: EmailAccountRow, reason: string) {
  await db.query(`update email_accounts set status = 'needs_reauth', status_reason = $2, last_error_code = 'auth', last_checked_at = now() where id = $1`, [acc.id, reason])
  await audit(db, { orgId: acc.org_id, entityType: 'credential', entityId: acc.id, event: 'email_account.needs_reauth', actor: 'system:email', detail: { reason } })
}
export async function markAccountAuthFailure(accountId: string, reason: string) {
  await admin(async db => { const acc = await db.one<EmailAccountRow>('select * from email_accounts where id = $1', [accountId]); if (acc) await markAuth(db, acc, reason) })
}

/** Health check: a token refresh if due plus an identity read. Never sends anything. */
export async function checkAccount(actor: Actor, accountId: string) {
  const acc = await visibleAccount(actor, accountId)
  let ok = true, reason: string | null = null, code: string | null = null
  try {
    const token = await accessToken(acc.id)
    const who = await emailAdapter(acc.provider).identity(token)
    if (who.address.toLowerCase() !== acc.address.toLowerCase()) { ok = false; code = 'identity_changed'; reason = `the connection now signs in as ${who.address}; reconnect the right account` }
  } catch (e) {
    ok = false
    code = e instanceof EmailAuthError ? 'auth' : 'unreachable'
    reason = e instanceof EmailAuthError ? 'reconnect the account' : 'could not reach the provider; try again later'
  }
  return admin(async db => {
    const row = await db.one<EmailAccountRow>(
      `update email_accounts set last_checked_at = now(), last_success_at = case when $2 then now() else last_success_at end, last_error_code = $3,
         status = case when $2 then (case when can_send then 'active' else status end) when $3 = 'auth' then 'needs_reauth' else status end,
         status_reason = case when $2 then (case when can_send then null else status_reason end) else $4 end where id = $1 returning *`, [acc.id, ok, code, reason])
    return row!
  })
}

export async function visibleAccount(actor: Actor, accountId: string): Promise<EmailAccountRow> {
  const { withActor } = await import('../engine/actor')
  const acc = await withActor(actor, db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [accountId]))
  if (!acc) throw new EngineError('not_found', 'email account not found')
  return acc
}

/** Disconnect: revoke at the provider where it allows it, delete tokens, cancel every unsent message from this account. */
export async function disconnectAccount(actor: Actor, accountId: string) {
  const acc = await visibleAccount(actor, accountId)
  assertMerchant(actor, acc.org_id)
  let revoked: 'revoked' | 'not_supported' | 'failed' = 'not_supported'
  try {
    const creds = await admin(db => db.one<{ key_id: string; ciphertext: string; refresh_ciphertext: string | null }>('select * from email_credentials where account_id = $1', [acc.id]))
    if (creds) revoked = await emailAdapter(acc.provider).revoke({
      accessToken: decryptSecret(creds.key_id, creds.ciphertext, aad(acc.id, 'access')),
      refreshToken: creds.refresh_ciphertext ? decryptSecret(creds.key_id, creds.refresh_ciphertext, aad(acc.id, 'refresh')) : null,
    })
  } catch { revoked = 'failed' }
  return admin(async db => {
    await db.query('delete from email_credentials where account_id = $1', [acc.id])
    await db.query(`update email_accounts set status = 'disconnected', status_reason = 'disconnected by the merchant', disconnected_at = now(), can_send = false, can_read = false where id = $1`, [acc.id])
    const cancelled = await db.query<{ id: string }>(`update email_messages set status = 'cancelled', status_reason = 'the email account was disconnected', next_attempt_at = null
      where account_id = $1 and status in ('draft','awaiting_approval','queued') returning id`, [acc.id])
    await audit(db, { orgId: acc.org_id, entityType: 'credential', entityId: acc.id, event: 'email_account.disconnected', actor: actor.label, detail: { provider: acc.provider, revoked_at_provider: revoked, messages_cancelled: cancelled.length } })
    return { revokedAtProvider: revoked, messagesCancelled: cancelled.length }
  })
}
