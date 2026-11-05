/**
 * Inbox reading for connected Gmail and Microsoft 365 accounts (Email Operations, with the owner's read
 * permission: gmail.readonly or Mail.Read). One sync:
 *  1. skips while a backoff is in force; gets a token (refreshed when due; a refused refresh marks the
 *     account needs_reauth);
 *  2. reads what is new since the stored cursor (Gmail historyId / Graph deltaLink), falling back to a
 *     bounded resync when the cursor expired;
 *  3. stores each message once (unique per account and provider message id, and per Message-ID) as an
 *     email_inbound row of that account: encrypted content, attachment metadata only, loop flags, the
 *     sender decision (lib/email/sender-policy.ts), threading to Deploi's own messages;
 *  4. marks earlier inbound mail as answered when the owner replied from the provider itself (Sent mail);
 *  5. moves the cursor only after everything was stored; on 401 marks the account needs_reauth; on
 *     429 / 5xx backs off (Retry-After, else exponential up to an hour).
 * Inbound mail is data: storing it never sends anything, never changes a permission and never starts a run.
 */
import { createHash, randomBytes } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { encryptSecret } from '../connectors/credentials'
import { log } from '../log'
import { emailAdapter } from './adapters'
import { accessToken, EmailAuthError, markAccountAuthFailure, type EmailAccountRow } from './accounts'
import { emailConfig } from './config'
import { autoReplyReason } from './loop'
import { decideSender } from './sender-policy'
import { gmailRead, gmailWatch, type ReadBatch } from './readers/gmail'
import { graphRead, graphSubscribe } from './readers/microsoft'
import { ReadError } from './readers/http'
import type { ProviderMessage } from './readers/parse'

export type SyncState = {
  account_id: string; org_id: string; provider: string; lease_until?: string | null; cursor: string | null; sent_cursor: string | null; status: string
  last_sync_at: string | null; last_full_sync_at: string | null; last_error_code: string | null; failures: number; backoff_until: string | null
  push_kind: string | null; push_id: string | null; push_expires_at: string | null; push_secret_hash: string | null
}
export type SyncResult =
  | { status: 'synced'; stored: number; duplicates: number; quarantined: number; answered: number; full: boolean; skipped: number }
  | { status: 'not_readable' | 'backoff' | 'needs_reauth' | 'error'; reason: string; retryAt?: string | null }

/** Reader per provider (tests may route provider HTTP through setEmailFetch; nothing here calls a host directly). */
async function read(acc: EmailAccountRow, token: string, st: SyncState): Promise<ReadBatch> {
  if (acc.provider === 'gmail') return gmailRead(token, st.cursor)
  if (acc.provider === 'microsoft') return graphRead(token, st.cursor, st.sent_cursor)
  throw new ReadError('bad', 0, `inbox reading is not available for ${acc.provider}`)
}

export const canReadInbox = (acc: Pick<EmailAccountRow, 'provider' | 'granted_scopes' | 'status'>) =>
  (acc.provider === 'gmail' || acc.provider === 'microsoft') && acc.status !== 'disconnected' && Boolean(emailAdapter(acc.provider).canReadInbox?.(acc.granted_scopes))

async function loadState(db: Db, acc: EmailAccountRow): Promise<SyncState> {
  await db.query(`insert into email_sync_state (account_id, org_id, provider) values ($1,$2,$3) on conflict (account_id) do nothing`, [acc.id, acc.org_id, acc.provider])
  return (await db.one<SyncState>('select * from email_sync_state where account_id = $1', [acc.id]))!
}

async function setState(accountId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch)
  await admin(db => db.query(`update email_sync_state set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where account_id = $1`, [accountId, ...keys.map(k => patch[k])]))
}

/** Read new mail on one connected account. Safe to call concurrently (an advisory lock lets one run at a time). */
export async function syncAccountInbox(accountId: string, opts: { now?: Date; actor?: string } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date()
  const acc = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [accountId]))
  if (!acc || !canReadInbox(acc)) return { status: 'not_readable', reason: 'this account was not connected with permission to read its inbox' }
  if (acc.status === 'needs_reauth') return { status: 'needs_reauth', reason: acc.status_reason ?? 'reconnect the account' }
  const st = await admin(db => loadState(db, acc))
  if (st.backoff_until && new Date(st.backoff_until).getTime() > now.getTime()) return { status: 'backoff', reason: `waiting after ${st.last_error_code ?? 'an error'}`, retryAt: st.backoff_until }
  // a lease (not a session lock: every query may use another pooled connection) lets one sync run at a time
  const lease = await admin(db => db.one<{ account_id: string }>(`update email_sync_state set lease_until = now() + interval '5 minutes'
    where account_id = $1 and (lease_until is null or lease_until < now()) returning account_id`, [acc.id]))
  if (!lease) return { status: 'backoff', reason: 'another sync of this inbox is running' }
  try { return await syncLocked(acc, st, now, opts.actor ?? 'system:inbox-sync') }
  finally { await admin(db => db.query(`update email_sync_state set lease_until = null where account_id = $1`, [acc.id])) }
}

async function syncLocked(acc: EmailAccountRow, st: SyncState, now: Date, actor: string): Promise<SyncResult> {
  let token: string
  try { token = await accessToken(acc.id) } catch (e) {
    if (e instanceof EmailAuthError) { await setState(acc.id, { status: 'needs_reauth', last_error_code: 'auth', last_error_at: now.toISOString() }); return { status: 'needs_reauth', reason: 'reconnect the account' } }
    return fail(acc, st, now, new ReadError('transient', 0, 'could not refresh the authorization'))
  }
  let batch: ReadBatch
  try { batch = await read(acc, token, st) } catch (e) {
    if (e instanceof ReadError) return fail(acc, st, now, e)
    throw e
  }
  let stored = 0, duplicates = 0, quarantined = 0
  for (const m of batch.messages) {
    const r = await storeProviderMessage(acc, m, actor)
    if (r === 'duplicate' || r === 'skipped') duplicates += r === 'duplicate' ? 1 : 0
    else { stored++; if (r === 'quarantined') quarantined++ }
  }
  let answered = 0
  for (const s of batch.sent) {
    const r = await admin(db => db.query(`update email_inbound set answered_at = $3 where account_id = $1 and provider_thread_id = $2 and received_at < $3 and answered_at is null returning id`, [acc.id, s.threadId, s.at]))
    answered += r.length
  }
  await setState(acc.id, { cursor: batch.cursor, sent_cursor: batch.sentCursor ?? st.sent_cursor, status: 'ok', last_sync_at: now.toISOString(), ...(batch.full ? { last_full_sync_at: now.toISOString() } : {}),
    last_error_code: null, failures: 0, backoff_until: null })
  if (stored) await admin(db => db.query('update email_sync_state set messages_stored = messages_stored + $2 where account_id = $1', [acc.id, stored]))
  await admin(db => db.query(`update email_accounts set last_success_at = now(), last_checked_at = now(), last_error_code = null where id = $1 and status = 'active'`, [acc.id]))
  if (stored || batch.full) await admin(db => audit(db, { orgId: acc.org_id, entityType: 'email', entityId: acc.id, event: 'email.inbox_synced', actor, detail: { provider: acc.provider, stored, quarantined, answered, full: batch.full, skipped: batch.skipped } }))
  await ensurePush(acc, token, now).catch(e => log.warn('email.inbox_push_failed', { account_id: acc.id, error: (e as Error).message.slice(0, 120) }))
  return { status: 'synced', stored, duplicates, quarantined, answered, full: batch.full, skipped: batch.skipped }
}

async function fail(acc: EmailAccountRow, st: SyncState, now: Date, e: ReadError): Promise<SyncResult> {
  if (e.kind === 'auth') {
    await markAccountAuthFailure(acc.id, e.message)
    await setState(acc.id, { status: 'needs_reauth', last_error_code: `auth_${e.status}`, last_error_at: now.toISOString() })
    return { status: 'needs_reauth', reason: e.message }
  }
  const failures = st.failures + 1
  const delay = e.retryAfterSec ?? Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6))
  const until = new Date(now.getTime() + delay * 1000).toISOString()
  const code = e.kind === 'throttled' ? 'rate_limited' : e.kind === 'transient' ? `unavailable_${e.status}` : `error_${e.status}`
  await setState(acc.id, { status: 'backoff', failures, backoff_until: until, last_error_code: code, last_error_at: now.toISOString() })
  await admin(db => db.query('update email_accounts set last_checked_at = now(), last_error_code = $2 where id = $1', [acc.id, code.slice(0, 60)]))
  return { status: e.kind === 'bad' ? 'error' : 'backoff', reason: e.message, retryAt: until }
}

const bare = (a: string) => a.trim().toLowerCase()

/** Store one provider message on its account (idempotent). */
export async function storeProviderMessage(acc: EmailAccountRow, m: ProviderMessage, actor: string): Promise<'accepted' | 'quarantined' | 'duplicate' | 'skipped'> {
  const from = bare(m.from)
  if (!from || from === acc.address.toLowerCase()) return 'skipped' // the account's own mail
  return admin(async db => {
    if (await db.one('select 1 from email_inbound where account_id = $1 and provider_email_id = $2', [acc.id, m.providerMessageId])) return 'duplicate'
    if (m.internetMessageId && await db.one('select 1 from email_inbound where account_id = $1 and internet_message_id = $2', [acc.id, m.internetMessageId])) return 'duplicate'
    const quoted = [m.inReplyTo, ...m.references].filter((x): x is string => Boolean(x))
    let thread = quoted.length ? await db.one<{ id: string; to_addresses: string[]; cc_addresses: string[] }>(`select id, to_addresses, cc_addresses from email_messages where account_id = $1 and internet_message_id = any($2::text[]) order by created_at desc limit 1`, [acc.id, quoted]) : null
    if (!thread && m.providerThreadId) thread = await db.one(`select id, to_addresses, cc_addresses from email_messages where account_id = $1 and provider_thread_id = $2 and status in ('accepted','delivery_unknown') order by created_at desc limit 1`, [acc.id, m.providerThreadId])
    const member = await db.one<{ id: string }>(`select id from profiles where agency_id = $1 and lower(email) = $2`, [acc.org_id, from])
    const classification = thread ? 'reply' : member ? 'merchant_cc' : 'other'
    const autoReply = autoReplyReason({ subject: m.subject, headers: m.headers }, from, emailConfig.agentMailDomain)
    const decision = await decideSender(db, { orgId: acc.org_id, accountId: acc.id, from, receivedAt: m.receivedAt, known: Boolean(member) || Boolean(thread && [...thread.to_addresses, ...thread.cc_addresses].includes(from)),
      firstContactAllowed: true, auth: m.authentication, autoReply, headers: m.headers })
    const row = await db.one<{ id: string }>(`insert into email_inbound (org_id, account_id, agent_id, provider_email_id, internet_message_id, from_address, to_addresses, cc_addresses, classification, status, status_reason,
        thread_message_id, auth_results, key_id, content_ciphertext, attachment_count, received_at, attachments, auto_reply, auto_reply_reason, provider_thread_id, provider_message_id, first_contact, quarantine_code)
      values ($1,$2,null,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending','pending',$13,$14,$15,$16,$17,$18,$3,$19,$20) on conflict do nothing returning id`,
      [acc.org_id, acc.id, m.providerMessageId, m.internetMessageId, from, m.to, m.cc, classification, decision.status, decision.reason, thread?.id ?? null, JSON.stringify(m.authentication ?? {}),
        m.attachments.length, m.receivedAt, JSON.stringify(m.attachments), Boolean(autoReply), autoReply, m.providerThreadId, decision.firstContact, decision.code])
    if (!row) return 'duplicate'
    const text = m.truncated && !m.text ? `(This message is too large to show here; open it in ${acc.provider === 'gmail' ? 'Gmail' : 'Outlook'}.)` : m.text
    const enc = encryptSecret(JSON.stringify({ subject: m.subject.slice(0, 500), text }), `email-inbound:${row.id}`)
    await db.query('update email_inbound set key_id = $2, content_ciphertext = $3 where id = $1', [row.id, enc.keyId, enc.ciphertext])
    if (thread && decision.status === 'accepted' && !autoReply) await db.query('update email_messages set reply_count = reply_count + 1, reply_seen_at = greatest(coalesce(reply_seen_at, $2), $2) where id = $1', [thread.id, m.receivedAt])
    await audit(db, { orgId: acc.org_id, entityType: 'execution', entityId: row.id, event: `email.inbound.${decision.status}`, actor,
      detail: { email_inbound: true, source: acc.provider, classification, thread_message_id: thread?.id ?? null, reason: decision.reason, quarantine_code: decision.code, first_contact: decision.firstContact, attachments: m.attachments.length, auto_reply: autoReply, truncated: m.truncated } })
    return decision.status
  })
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Optional push (behind configuration): Gmail users.watch, Graph subscription. Renewed a day before expiry. */
async function ensurePush(acc: EmailAccountRow, token: string, now: Date) {
  const st = (await admin(db => db.one<SyncState>('select * from email_sync_state where account_id = $1', [acc.id])))!
  const fresh = st.push_expires_at && new Date(st.push_expires_at).getTime() - now.getTime() > 864e5
  if (fresh) return
  if (acc.provider === 'gmail' && emailConfig.gmailPushEnabled) {
    const w = await gmailWatch(token, emailConfig.gmailPushTopic)
    await setState(acc.id, { push_kind: 'gmail_watch', push_id: null, push_expires_at: w.expiresAt })
  }
  if (acc.provider === 'microsoft' && emailConfig.graphPushEnabled) {
    const clientState = st.push_id && st.push_secret_hash ? null : randomBytes(32).toString('hex')
    let s: { id: string; expiresAt: string }
    try { s = await graphSubscribe(token, { id: st.push_id }, clientState) } catch (e) {
      if (clientState || !(e instanceof ReadError) || e.status !== 404) throw e
      const cs = randomBytes(32).toString('hex')
      s = await graphSubscribe(token, { id: null }, cs)
      await setState(acc.id, { push_secret_hash: sha(cs) })
    }
    await setState(acc.id, { push_kind: 'graph_subscription', push_id: s.id, push_expires_at: s.expiresAt, ...(clientState ? { push_secret_hash: sha(clientState) } : {}) })
  }
}

/** Connection health for the reconnection UI (owned elsewhere): what the inbox reader last saw. */
export async function inboxSyncHealth(accountId: string) {
  const s = await admin(db => db.one<SyncState & { account_status: string }>(`select s.*, a.status as account_status from email_sync_state s join email_accounts a on a.id = s.account_id where s.account_id = $1`, [accountId]))
  if (!s) return null
  return { status: s.status, needsReauth: s.status === 'needs_reauth' || s.account_status === 'needs_reauth', lastSyncAt: s.last_sync_at, lastFullSyncAt: s.last_full_sync_at, lastErrorCode: s.last_error_code,
    backoffUntil: s.backoff_until, failures: s.failures, push: s.push_kind ? { kind: s.push_kind, expiresAt: s.push_expires_at } : null }
}

/** Sync every readable account in the organization (or all), e.g. after a push notification or from cron. */
export async function syncReadableInboxes(opts: { orgId?: string; accountIds?: string[]; now?: Date; actor?: string } = {}) {
  const rows = await admin(db => db.query<{ id: string }>(`select a.id from email_accounts a where a.provider in ('gmail','microsoft') and a.status = 'active' and a.can_read
    and ($1::uuid is null or a.org_id = $1) and ($2::uuid[] is null or a.id = any($2::uuid[]))`, [opts.orgId ?? null, opts.accountIds ?? null]))
  const out: { accountId: string; result: SyncResult }[] = []
  for (const r of rows) out.push({ accountId: r.id, result: await syncAccountInbox(r.id, { now: opts.now, actor: opts.actor }) })
  return out
}
