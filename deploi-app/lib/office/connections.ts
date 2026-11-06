/**
 * Office connections: HubSpot (OAuth 2.0, one-time state) and Google Calendar (OAuth 2.0 + PKCE). The
 * state is single-use, expires after 10 minutes and is bound to the organization and the user who
 * started it. Tokens are stored encrypted; disconnect deletes them and cancels queued work that needs
 * the connection. Synthetic connections (tests and demos) go through the same records.
 */
import { createHash, randomBytes } from 'node:crypto'
import { admin, type Db } from '../db'
import { assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { decryptSecret, encryptSecret } from '../connectors/credentials'
import { officeAudit } from './audit'
import { officeConfig, providerConfigured, PROVIDER_LABEL, type OfficeProvider } from './config'
import { deleteOfficeCredential, loadOfficeTokens, saveOfficeTokens } from './credentials'
import { hubspotAuthorizeUrl, hubspotExchange, hubspotIdentity, HUBSPOT_SCOPES, type OAuthTokens } from './hubspot'
import { calendarScopesOk, googleAuthorizeUrl, googleExchange, googleIdentity } from './calendar'
import { demoContacts, mutateOfficeSynth, syntheticToken } from './synthetic'
import { isRealmId, quickbooksAuthorizeUrl, quickbooksClient, quickbooksExchange, quickbooksRevoke, QBO_SCOPES } from './quickbooks'
import { demoInvoices, mutateQboSynth } from './quickbooks-synthetic'
import { assertOfficeConnectionSlot } from '../plans/entitlements'
import { assertCan } from '../platform/rbac'
import { restoredIfBroken } from '../integrations/events'

export type OfficeConnectionRow = {
  id: string; org_id: string; provider: OfficeProvider; status: 'active' | 'needs_reauth' | 'disconnected'; status_reason: string | null; is_synthetic: boolean
  external_account_id: string; display_name: string | null; scopes: string[]; calendar_id: string | null; timezone: string | null; connected_by: string; connected_at: string
}

/** Raised when a provider's OAuth client is not configured here: the API answers 503 and the button says "needs setup". */
export class OfficeNotConfigured extends Error { constructor(public provider: OfficeProvider) { super(`${PROVIDER_LABEL[provider]} needs setup: its OAuth client is not configured in this environment`); this.name = 'OfficeNotConfigured' } }

const b64url = (b: Buffer) => b.toString('base64url')
const STATE_TTL_MIN = 10

function merchantOnly(actor: Actor): asserts actor is Exclude<Actor, { kind: 'staff' }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot connect accounts for a customer')
  assertMerchant(actor, actor.orgId)
}

/** Start connecting: returns the provider consent URL. PKCE (S256) for Google; HubSpot's flow has no PKCE parameters. */
export async function startOfficeConnect(actor: Actor, provider: OfficeProvider, opts: { now?: Date } = {}) {
  merchantOnly(actor)
  await assertCan(actor, actor.orgId, 'connect') // owners and admins only (F-08)
  if (!providerConfigured(provider)) throw new OfficeNotConfigured(provider)
  const state = b64url(randomBytes(32))
  const verifier = provider === 'google_calendar' ? b64url(randomBytes(48)) : null
  const now = opts.now ?? new Date()
  await admin(async db => {
    const enc = verifier ? encryptSecret(verifier, `office-oauth-state:${state}`) : null
    await db.query(`insert into office_oauth_states (state, org_id, provider, created_by, key_id, verifier_ciphertext, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [state, actor.orgId, provider, actor.label, enc?.keyId ?? null, enc?.ciphertext ?? null, new Date(now.getTime() + STATE_TTL_MIN * 60e3).toISOString()])
    await db.query(`delete from office_oauth_states where expires_at < now() - interval '1 day'`)
    await officeAudit(db, { orgId: actor.orgId, entityType: 'office_connection', event: 'connection.started', actor: actor.label, detail: { provider } })
  })
  const url = provider === 'hubspot' ? hubspotAuthorizeUrl(state) : provider === 'quickbooks' ? quickbooksAuthorizeUrl(state) : googleAuthorizeUrl(state, b64url(createHash('sha256').update(verifier!).digest()))
  return { url, state }
}

/** tests only: replace the code exchange + identity read */
type Exchanger = (provider: OfficeProvider, code: string, verifier: string | null, extra?: { realmId?: string | null }) => Promise<{ tokens: OAuthTokens; externalId: string; displayName: string | null }>
const realExchange: Exchanger = async (provider, code, verifier, extra) => {
  if (provider === 'quickbooks') {
    // the company Intuit returned on the callback; reading its name with the new token proves token and company belong together
    const realmId = extra?.realmId
    if (!isRealmId(realmId)) throw new EngineError('invalid_input', 'QuickBooks did not return a company id')
    const tokens = await quickbooksExchange(code)
    const company = await quickbooksClient(async () => tokens.accessToken, realmId).companyInfo()
    return { tokens, externalId: realmId, displayName: company.name ?? `QuickBooks company ${realmId}` }
  }
  if (provider === 'hubspot') {
    const tokens = await hubspotExchange(code)
    const who = await hubspotIdentity(tokens.accessToken)
    return { tokens: { ...tokens, scopes: who.scopes.length ? who.scopes : tokens.scopes }, externalId: who.hubId, displayName: who.hubDomain ?? `HubSpot portal ${who.hubId}` }
  }
  if (!verifier) throw new Error('missing PKCE verifier')
  const tokens = await googleExchange(code, verifier)
  const who = await googleIdentity(tokens.accessToken)
  return { tokens, externalId: who.email, displayName: who.email }
}
let exchanger: Exchanger = realExchange
export function setOfficeExchanger(x: Exchanger | null) { exchanger = x ?? realExchange }

/** OAuth callback: single-use, unexpired state of the same organization and user; then exchange, identity, encrypted storage. */
export async function completeOfficeConnect(actor: Actor, input: { provider: OfficeProvider; state: string; code: string | null; error: string | null; realmId?: string | null }) {
  merchantOnly(actor)
  const st = await admin(db => db.one<{ state: string; org_id: string; provider: OfficeProvider; created_by: string; key_id: string | null; verifier_ciphertext: string | null }>(
    `update office_oauth_states set used_at = now() where state = $1 and used_at is null and expires_at > now() returning *`, [input.state]))
  if (!st) throw new EngineError('expired', 'this connection attempt expired or was already used; start again')
  if (st.org_id !== actor.orgId || st.created_by !== actor.label) throw new EngineError('forbidden', 'this connection attempt was started by someone else')
  if (st.provider !== input.provider) throw new EngineError('invalid_input', 'this connection attempt was for a different provider')
  if (input.error || !input.code) throw new EngineError('invalid_input', input.error === 'access_denied' ? 'you did not grant access, so nothing was connected' : 'the provider did not return an authorization code')
  if (!providerConfigured(st.provider)) throw new OfficeNotConfigured(st.provider)
  const verifier = st.verifier_ciphertext && st.key_id ? decryptSecret(st.key_id, st.verifier_ciphertext, `office-oauth-state:${st.state}`) : null
  if (st.provider === 'quickbooks' && !isRealmId(input.realmId)) throw new EngineError('invalid_input', 'QuickBooks did not return a company id (realmId); start again')
  const got = await exchanger(st.provider, input.code, verifier, { realmId: input.realmId ?? null })
  if (st.provider === 'quickbooks' && (got.externalId !== input.realmId || !QBO_SCOPES.every(s => got.tokens.scopes.includes(s)))) throw new EngineError('invalid_input', 'QuickBooks did not grant access to the company that was chosen; connect again')
  if (st.provider === 'hubspot' && !HUBSPOT_SCOPES.every(s => got.tokens.scopes.includes(s))) throw new EngineError('invalid_input', 'HubSpot did not grant every permission Deploi Office needs (contacts and deals, read and write); connect again and approve all of them')
  if (st.provider === 'google_calendar' && !calendarScopesOk(got.tokens.scopes)) throw new EngineError('invalid_input', 'Google did not grant calendar access (events and availability); connect again and tick both boxes')
  return admin(db => saveConnection(db, { orgId: st.org_id, provider: st.provider, actor: actor.label, synthetic: false, externalId: got.externalId, displayName: got.displayName, tokens: got.tokens }))
}

async function saveConnection(db: Db, i: { orgId: string; provider: OfficeProvider; actor: string; synthetic: boolean; externalId: string; displayName: string | null; tokens: OAuthTokens; timezone?: string }) {
  const live = await db.one<OfficeConnectionRow>(`select * from office_connections where org_id = $1 and provider = $2 and status <> 'disconnected' for update`, [i.orgId, i.provider])
  if (live && (live.is_synthetic !== i.synthetic || live.external_account_id !== i.externalId)) throw new EngineError('invalid_input', `another ${PROVIDER_LABEL[i.provider]} account is connected; disconnect it first`)
  // the plan's Office connections (only while billing is on); reconnecting the same account needs no new one
  if (!live) await assertOfficeConnectionSlot(db, i.orgId)
  const row = live
    ? (await db.one<OfficeConnectionRow>(`update office_connections set status = 'active', status_reason = null, scopes = $2, display_name = $3 where id = $1 returning *`, [live.id, i.tokens.scopes, i.displayName]))!
    : (await db.one<OfficeConnectionRow>(`insert into office_connections (org_id, provider, is_synthetic, external_account_id, display_name, scopes, calendar_id, timezone, connected_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [i.orgId, i.provider, i.synthetic, i.externalId, i.displayName, i.tokens.scopes, i.provider === 'google_calendar' ? 'primary' : null, i.timezone ?? null, i.actor]))!
  await saveOfficeTokens(db, row.id, i.orgId, i.tokens)
  await officeAudit(db, { orgId: i.orgId, entityType: 'office_connection', entityId: row.id, event: live ? 'connection.reconnected' : 'connection.connected', actor: i.actor, detail: { provider: i.provider, synthetic: i.synthetic, scopes: i.tokens.scopes } })
  // integration hub: a reconnection of a broken connection clears its health and resumes the agents that use it (same id)
  if (live) await restoredIfBroken(db, { orgId: i.orgId, integration: i.provider, connectionId: row.id, actor: i.actor, rowBroken: live.status !== 'active' })
  return row
}

/** Synthetic HubSpot or Calendar for tests and demos (never on a production deployment). */
export async function connectSyntheticOffice(actor: Actor, provider: OfficeProvider, opts: { demoData?: boolean; timezone?: string } = {}) {
  merchantOnly(actor)
  await assertCan(actor, actor.orgId, 'connect')
  if (!officeConfig.syntheticAllowed) throw new EngineError('forbidden', 'synthetic connections are not available on this deployment')
  const row = await admin(db => saveConnection(db, { orgId: actor.orgId, provider, actor: actor.label, synthetic: true, externalId: provider === 'hubspot' ? 'synthetic-portal' : provider === 'quickbooks' ? 'synthetic-realm' : 'calendar@synthetic.example',
    displayName: provider === 'hubspot' ? 'Synthetic HubSpot (test only)' : provider === 'quickbooks' ? 'Synthetic QuickBooks (test only)' : 'Synthetic calendar (test only)', tokens: syntheticToken(provider), timezone: opts.timezone ?? 'America/New_York' }))
  if (provider === 'quickbooks') await mutateQboSynth(row.id, s => { if (opts.demoData !== false && !s.invoices.length) s.invoices.push(...demoInvoices()) })
  else await mutateOfficeSynth(row.id, s => { if (opts.demoData !== false && provider === 'hubspot' && !s.contacts.length) s.contacts.push(...demoContacts()) })
  return row
}

/**
 * Disconnect: delete the stored tokens (HubSpot and Google revoke on their side when the user removes the
 * app; the credential is gone here either way) and cancel queued actions that need this connection.
 */
export async function disconnectOffice(actor: Actor, connectionId: string) {
  merchantOnly(actor)
  await assertCan(actor, actor.orgId, 'connect')
  // QuickBooks: revoke the grant at Intuit first (best effort; the credential is deleted here either way)
  const qb = await admin(db => db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2 and provider = 'quickbooks' and not is_synthetic`, [connectionId, actor.orgId]))
  let revoked: boolean | null = null
  if (qb) {
    const t = await admin(db => loadOfficeTokens(db, qb.id)).catch(() => null)
    if (t) revoked = await quickbooksRevoke(t.refreshToken ?? t.accessToken)
  }
  return admin(async db => {
    const c = await db.one<OfficeConnectionRow>('select * from office_connections where id = $1 for update', [connectionId])
    if (!c || c.org_id !== actor.orgId) throw new EngineError('not_found', 'connection not found')
    const removed = await deleteOfficeCredential(db, c.id)
    await db.query(`update office_connections set status = 'disconnected', status_reason = 'disconnected by you', disconnected_at = now() where id = $1`, [c.id])
    const kinds = c.provider === 'hubspot' ? ['crm_note', 'crm_task', 'crm_update_contact', 'crm_deal_stage'] : c.provider === 'quickbooks' ? [] : ['create_event', 'patch_event', 'delete_event']
    const cancelled = await db.query(`update office_actions set status = 'cancelled', status_reason = $3, next_attempt_at = null where org_id = $1 and kind = any($2::text[]) and status in ('draft','awaiting_approval','queued') returning id`,
      [c.org_id, kinds, `${PROVIDER_LABEL[c.provider]} was disconnected`])
    // QuickBooks: invoice reminders not yet sent are cancelled (they could no longer be checked against QuickBooks)
    if (c.provider === 'quickbooks') cancelled.push(...await db.query(`update office_actions set status = 'cancelled', status_reason = $2, next_attempt_at = null where org_id = $1 and kind = 'send_email'
      and payload->'recipientSource'->>'kind' = 'invoice' and status in ('draft','awaiting_approval','queued') returning id`, [c.org_id, `${PROVIDER_LABEL[c.provider]} was disconnected`]))
    await officeAudit(db, { orgId: c.org_id, entityType: 'office_connection', entityId: c.id, event: 'connection.disconnected', actor: actor.label, detail: { provider: c.provider, credential_deleted: removed, actions_cancelled: cancelled.length, ...(revoked !== null ? { revoked_at_provider: revoked } : {}) } })
    return { credentialDeleted: removed, actionsCancelled: cancelled.length, ...(revoked !== null ? { revokedAtProvider: revoked } : {}) }
  })
}

export async function activeConnection(db: Db, orgId: string, provider: OfficeProvider) {
  return db.one<OfficeConnectionRow>(`select * from office_connections where org_id = $1 and provider = $2 and status = 'active'`, [orgId, provider])
}
