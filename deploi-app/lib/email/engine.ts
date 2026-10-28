/**
 * Email engine. Every agent message follows one path:
 *   created (Draft / Awaiting approval / Queued) -> Sending -> Accepted by provider | Failed | Delivery unknown
 * - Review: the merchant approves the exact content; the approval is bound to its content hash, so any
 *   change to sender, recipients, subject, body or attachments invalidates it.
 * - Autonomous: the agent's granted policy version is checked in code before queueing and again right
 *   before every send; anything outside it waits for approval with the reason.
 * - One message row is one send: a row moves Queued -> Sending once (row lock), and an uncertain outcome
 *   is never retried until the provider's Sent folder shows it was not sent (or the merchant decides).
 * - Pause, revoke, delete and disconnect cancel queued messages; the sender's agent and account are
 *   rechecked before every send. "Delivered" is never claimed: providers report acceptance only.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { encryptSecret } from '../connectors/credentials'
import { parsePolicy, permissionRank, type AgentPolicy } from '../agents/policy'
import { emailAdapter } from './adapters'
import { accessToken, accountRef, EmailAuthError, markAccountAuthFailure, type EmailAccountRow } from './accounts'
import { emailConfig, liveSendAllowed } from './config'
import { attachmentBytes, contentHash, decryptContent } from './content'
import { qualifyEmail, sendBlockers, type EmailQualification } from './check'
import { isAddress, newInternetMessageId } from './mime'
import type { DraftMessage } from './tasks'
import type { FindResult, MessageContent } from './types'
import { randomBytes } from 'node:crypto'
import { replyAddress } from './mailbox'

export type EmailStatus = 'draft' | 'awaiting_approval' | 'queued' | 'sending' | 'accepted' | 'failed' | 'delivery_unknown' | 'cancelled'
export type EmailMessageRow = {
  id: string; org_id: string; agent_id: string | null; run_id: string | null; account_id: string; policy_id: string | null; policy_version: number | null
  task_key: DraftMessage['taskKey']; dedupe_key: string; status: EmailStatus; status_reason: string | null
  from_address: string; to_addresses: string[]; cc_addresses: string[]; attachment_count: number; attachment_bytes: number
  key_id: string; content_ciphertext: string; content_hash: string; internet_message_id: string
  approval_kind: 'individual' | 'standing' | null; approved_by: string | null; approved_hash: string | null; approved_at: string | null; qualification: EmailQualification | null
  attempts: number; next_attempt_at: string | null; sending_started_at: string | null; accepted_at: string | null; accepted_evidence: string | null
  provider_message_id: string | null; provider_thread_id: string | null; failure_code: string | null; reconcile_checks: number
  reply_seen_at: string | null; reply_count: number; meta: Record<string, unknown>; created_at: string; updated_at: string
  in_reply_to: string | null; reply_token: string | null
}
export type SendOutcome = { messageId: string; status: EmailStatus; reason?: string | null; duplicate?: boolean }

type AgentPolicyCtx = { agentStatus: string; policyId: string | null; policyStatus: string; policyVersion: number; policy: AgentPolicy | null; agentName: string }

async function agentPolicy(db: Db, agentId: string | null): Promise<AgentPolicyCtx> {
  if (!agentId) return { agentStatus: 'deleted', policyId: null, policyStatus: 'none', policyVersion: 0, policy: null, agentName: '' }
  const a = await db.one<{ status: string; name: string; active_policy_id: string | null }>('select status, name, active_policy_id from agents where id = $1', [agentId])
  if (!a) return { agentStatus: 'deleted', policyId: null, policyStatus: 'none', policyVersion: 0, policy: null, agentName: '' }
  const p = a.active_policy_id ? await db.one<{ id: string; status: string; version: number; policy: unknown }>('select id, status, version, policy from agent_policies where id = $1', [a.active_policy_id]) : null
  return { agentStatus: a.status, agentName: a.name, policyId: p?.id ?? null, policyStatus: p?.status ?? 'none', policyVersion: p?.version ?? 0, policy: p ? parsePolicy(p.policy) : null }
}

/** Standing-authorization sends already counted today for this agent (queued or later, not cancelled or failed). */
async function dayCount(db: Db, agentId: string, excludeId?: string): Promise<number> {
  const r = await db.one<{ n: string }>(`select count(*)::text as n from email_messages where agent_id = $1 and approval_kind = 'standing'
    and status in ('queued','sending','accepted','delivery_unknown') and approved_at >= date_trunc('day', now()) and ($2::uuid is null or id <> $2)`, [agentId, excludeId ?? null])
  return Number(r?.n ?? 0)
}

/**
 * Create the messages an agent run produced and decide each one: Draft (draft-only agents), Awaiting
 * approval (review, or outside the standing authorization) or Queued (covered). Duplicates of an
 * earlier run's message (same agent and dedupe key) are skipped.
 */
export async function createAgentMessages(input: { agentId: string; runId: string | null; drafts: DraftMessage[]; actor: string; now?: Date }) {
  const now = input.now ?? new Date()
  return admin(async db => {
    const ctx = await agentPolicy(db, input.agentId)
    const e = ctx.policy?.email
    if (!e) return { created: [] as { id: string; status: EmailStatus }[], skipped: input.drafts.length }
    const account = await db.one<EmailAccountRow>('select * from email_accounts where id = $1', [e.accountId])
    const org = await db.one<{ org_id: string }>('select org_id from agents where id = $1', [input.agentId])
    const created: { id: string; status: EmailStatus }[] = []
    let run = 0, day = await dayCount(db, input.agentId), skipped = 0
    for (const d of input.drafts) {
      const to = [...new Set(d.to.map(a => a.toLowerCase()))].filter(isAddress), cc = [...new Set(d.cc.map(a => a.toLowerCase()))].filter(isAddress)
      if (!to.length) { skipped++; continue }
      const from = account?.address ?? 'unknown@invalid'
      const hash = contentHash({ from, to, cc, content: d.content })
      // agent mailboxes route replies back to this exact message through a tagged Reply-To address
      const agentMailbox = account?.provider === 'deploi'
      const row = await db.one<{ id: string }>(`insert into email_messages (org_id, agent_id, run_id, account_id, policy_id, policy_version, task_key, dedupe_key, status, from_address, to_addresses, cc_addresses,
          attachment_count, attachment_bytes, key_id, content_ciphertext, content_hash, internet_message_id, meta, in_reply_to, reply_token)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12,$13,'pending','pending',$14,$15,$16,$17,$18) on conflict (agent_id, dedupe_key) do nothing returning id`,
        [org!.org_id, input.agentId, input.runId, e.accountId, ctx.policyId, ctx.policyVersion, d.taskKey, d.dedupeKey, from, to, cc,
          d.content.attachments.length, attachmentBytes(d.content), hash, newInternetMessageId(agentMailbox ? emailConfig.agentMailDomain || undefined : undefined), JSON.stringify(d.meta),
          d.inReplyTo ?? null, agentMailbox ? randomBytes(16).toString('hex') : null])
      if (!row) { skipped++; continue }
      const enc = encryptSecret(JSON.stringify(d.content), `email-message:${row.id}`)
      let status: EmailStatus, reason: string, q: EmailQualification | null = null
      if (permissionRank(e.permission) < permissionRank('send_approved')) { status = 'draft'; reason = 'this agent only drafts: review it and send it yourself, or grant send permission' }
      else if (e.permission === 'send_approved') { status = 'awaiting_approval'; reason = 'waiting for your approval of this exact message' }
      else {
        q = qualifyEmail({ agentStatus: ctx.agentStatus, policyStatus: ctx.policyStatus, policyVersion: ctx.policyVersion, policy: ctx.policy!, account, now,
          message: { from, to, cc, attachmentCount: d.content.attachments.length, taskKey: d.taskKey }, counts: { run, day } })
        if (q.covered) { status = 'queued'; reason = 'covered by the standing authorization'; run++; day++ }
        else { status = 'awaiting_approval'; reason = `waiting for your approval: ${q.blockers.join('; ')}` }
      }
      await db.query(`update email_messages set key_id = $2, content_ciphertext = $3, status = $4, status_reason = $5, qualification = $6,
          approval_kind = case when $4 = 'queued' then 'standing' else null end, approved_by = case when $4 = 'queued' then $7 else null end,
          approved_hash = case when $4 = 'queued' then content_hash else null end, approved_at = case when $4 = 'queued' then now() else null end where id = $1`,
        [row.id, enc.keyId, enc.ciphertext, status, reason, q ? JSON.stringify(q) : null, `agent:${ctx.agentName}@v${ctx.policyVersion}`])
      await audit(db, { orgId: org!.org_id, entityType: 'execution', entityId: row.id, event: `email.${status}`, actor: input.actor,
        detail: { email_message: true, task: d.taskKey, agent_id: input.agentId, policy_version: ctx.policyVersion, recipients: to.length + cc.length, blockers: q?.blockers ?? [] } })
      created.push({ id: row.id, status })
    }
    return { created, skipped }
  })
}

/** Approve one exact message (bound to the content hash the merchant saw) and send it. */
export async function approveMessage(actor: Actor, messageId: string, shownHash: string): Promise<SendOutcome> {
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from email_messages where id = $1', [messageId]))
  if (!visible) throw new EngineError('not_found', 'message not found')
  assertMerchant(actor, visible.org_id)
  await admin(async db => {
    const m = await db.one<EmailMessageRow>('select * from email_messages where id = $1 for update', [messageId])
    if (!m) throw new EngineError('not_found', 'message not found')
    if (m.status !== 'awaiting_approval') throw new EngineError('not_pending', `this message is ${label(m.status)}`)
    if (shownHash !== m.content_hash) throw new EngineError('hash_mismatch', 'the message changed after you opened it; review it again')
    const ctx = await agentPolicy(db, m.agent_id)
    const account = await db.one<EmailAccountRow>('select * from email_accounts where id = $1', [m.account_id])
    if (!ctx.policy) throw new EngineError('agent_inactive', 'the agent has no active authorization')
    const b = sendBlockers({ agentStatus: ctx.agentStatus, policyStatus: ctx.policyStatus, policy: ctx.policy, account, message: { from: m.from_address, to: m.to_addresses, cc: m.cc_addresses } as never })
    if (b.length) throw new EngineError(ctx.agentStatus !== 'active' ? 'agent_inactive' : 'invalid_input', `cannot send: ${b.join('; ')}`)
    await db.query(`update email_messages set status = 'queued', status_reason = 'approved by you', approval_kind = 'individual', approved_by = $2, approved_hash = content_hash,
      approved_at = now(), policy_id = $3, policy_version = $4, next_attempt_at = null where id = $1`, [m.id, actor.label, ctx.policyId, ctx.policyVersion])
    await audit(db, { orgId: m.org_id, entityType: 'approval', entityId: m.id, event: 'email.approved', actor: actor.label, detail: { email_message: true, content_hash: m.content_hash, policy_version: ctx.policyVersion } })
  })
  return sendMessage(messageId, { actor: actor.label })
}

/** Edit subject or body before sending. Any change clears an earlier approval and needs a new one. */
export async function editMessage(actor: Actor, messageId: string, patch: { subject?: string; bodyText?: string; shownHash: string }) {
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from email_messages where id = $1', [messageId]))
  if (!visible) throw new EngineError('not_found', 'message not found')
  assertMerchant(actor, visible.org_id)
  return admin(async db => {
    const m = await db.one<EmailMessageRow>('select * from email_messages where id = $1 for update', [messageId])
    if (!m || !['draft', 'awaiting_approval', 'queued'].includes(m.status)) throw new EngineError('not_pending', 'only unsent messages can be edited')
    if (patch.shownHash !== m.content_hash) throw new EngineError('hash_mismatch', 'the message changed after you opened it; review it again')
    const c = decryptContent(m.id, m.key_id, m.content_ciphertext)
    const next: MessageContent = { ...c, subject: (patch.subject ?? c.subject).replace(/[\r\n]+/g, ' ').slice(0, 250), bodyText: (patch.bodyText ?? c.bodyText).slice(0, 50_000) }
    const hash = contentHash({ from: m.from_address, to: m.to_addresses, cc: m.cc_addresses, content: next })
    if (hash === m.content_hash) return { contentHash: hash, status: m.status }
    const enc = encryptSecret(JSON.stringify(next), `email-message:${m.id}`)
    const status: EmailStatus = m.status === 'draft' ? 'draft' : 'awaiting_approval'
    await db.query(`update email_messages set key_id = $2, content_ciphertext = $3, content_hash = $4, status = $5, status_reason = $6, approval_kind = null, approved_by = null,
      approved_hash = null, approved_at = null where id = $1`, [m.id, enc.keyId, enc.ciphertext, hash, status, status === 'draft' ? 'edited draft' : 'edited: waiting for your approval of the new version'])
    await audit(db, { orgId: m.org_id, entityType: 'execution', entityId: m.id, event: 'email.edited', actor: actor.label, detail: { email_message: true, approval_cleared: Boolean(m.approved_hash) } })
    return { contentHash: hash, status }
  })
}

/** Decline (cancel) an unsent message. */
export async function declineMessage(actor: Actor, messageId: string) {
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from email_messages where id = $1', [messageId]))
  if (!visible) throw new EngineError('not_found', 'message not found')
  assertMerchant(actor, visible.org_id)
  return admin(async db => {
    const r = await db.query(`update email_messages set status = 'cancelled', status_reason = 'declined by you', next_attempt_at = null where id = $1 and status in ('draft','awaiting_approval','queued') returning id`, [messageId])
    if (!r.length) throw new EngineError('not_pending', 'only unsent messages can be declined')
    await audit(db, { orgId: visible.org_id, entityType: 'execution', entityId: messageId, event: 'email.declined', actor: actor.label, detail: { email_message: true } })
  })
}

const label = (s: EmailStatus) => ({ draft: 'a draft', awaiting_approval: 'awaiting approval', queued: 'queued', sending: 'being sent', accepted: 'already accepted by the provider', failed: 'failed', delivery_unknown: 'of unknown delivery', cancelled: 'cancelled' } as const)[s]

/**
 * Send one queued message. The row is claimed (Queued -> Sending) under a lock after every gate has
 * passed; a concurrent caller sees Sending and stops. Never resends a message whose earlier attempt
 * may have gone out.
 */
export async function sendMessage(messageId: string, opts: { actor: string; now?: Date }): Promise<SendOutcome> {
  const now = opts.now ?? new Date()
  const claim = await admin(async db => {
    const m = await db.one<EmailMessageRow>('select * from email_messages where id = $1 for update', [messageId])
    if (!m) throw new EngineError('not_found', 'message not found')
    if (m.status !== 'queued') return { kind: 'skip' as const, m }
    if (m.next_attempt_at && new Date(m.next_attempt_at).getTime() > now.getTime()) return { kind: 'skip' as const, m }
    const stop = (status: EmailStatus, reason: string, extra: Record<string, unknown> = {}) => ({ kind: 'stop' as const, m, status, reason, extra })
    const ctx = await agentPolicy(db, m.agent_id)
    const account = await db.one<EmailAccountRow>('select * from email_accounts where id = $1', [m.account_id])
    if (ctx.agentStatus !== 'active') return stop('cancelled', `the agent is ${ctx.agentStatus}; queued messages are not sent`)
    if (!ctx.policy?.email || ctx.policy.email.accountId !== m.account_id) return stop('cancelled', "the agent's email authorization changed; this message is no longer covered")
    if (!account || account.status === 'disconnected') return stop('cancelled', 'the email account was disconnected')
    if (account.status !== 'active' || !account.can_send) return stop('failed', 'the email account needs to be reconnected before it can send', { failure_code: 'account' })
    if (m.approved_hash !== m.content_hash) return stop('awaiting_approval', 'the message changed after approval; approve the new version')
    const base = sendBlockers({ agentStatus: ctx.agentStatus, policyStatus: ctx.policyStatus, policy: ctx.policy, account, message: { from: m.from_address, to: m.to_addresses, cc: m.cc_addresses } as never })
    if (base.length) return stop('awaiting_approval', `cannot send: ${base.join('; ')}`)
    let qualification = m.qualification
    if (m.approval_kind === 'standing') {
      const q = qualifyEmail({ agentStatus: ctx.agentStatus, policyStatus: ctx.policyStatus, policyVersion: ctx.policyVersion, policy: ctx.policy, account, now,
        message: { from: m.from_address, to: m.to_addresses, cc: m.cc_addresses, attachmentCount: m.attachment_count, taskKey: m.task_key }, counts: { run: null, day: await dayCount(db, m.agent_id!, m.id) } })
      if (!q.covered) return stop('awaiting_approval', `no longer covered by the standing authorization: ${q.blockers.join('; ')}`, { qualification: JSON.stringify(q), approval_kind: null, approved_hash: null, approved_by: null })
      qualification = q
    } else if (m.approval_kind !== 'individual') return stop('awaiting_approval', 'waiting for your approval')
    if (!account.is_synthetic) {
      const live = liveSendAllowed([...m.to_addresses, ...m.cc_addresses])
      if (!live.ok) return stop('failed', live.reason, { failure_code: 'live_sends_disabled' })
    }
    if (m.attempts >= emailConfig.maxAttempts) return stop('failed', `gave up after ${m.attempts} attempts`, { failure_code: 'attempts' })
    await db.query(`update email_messages set status = 'sending', status_reason = null, attempts = attempts + 1, sending_started_at = now(), policy_id = $2, policy_version = $3, qualification = $4 where id = $1`,
      [m.id, ctx.policyId, ctx.policyVersion, qualification ? JSON.stringify(qualification) : null])
    await audit(db, { orgId: m.org_id, entityType: 'execution', entityId: m.id, event: 'email.sending', actor: opts.actor, detail: { email_message: true, attempt: m.attempts + 1, approval_kind: m.approval_kind, policy_version: ctx.policyVersion } })
    return { kind: 'go' as const, m, account }
  })
  if (claim.kind === 'skip') return { messageId, status: claim.m.status, reason: claim.m.status_reason, duplicate: claim.m.status === 'sending' || claim.m.status === 'accepted' }
  if (claim.kind === 'stop') {
    await finish(claim.m, claim.status, claim.reason, opts.actor, claim.extra)
    return { messageId, status: claim.status, reason: claim.reason }
  }
  const { m, account } = claim
  const adapter = emailAdapter(account.provider)
  let token: string
  try { token = await accessToken(account.id) } catch (e) {
    const auth = e instanceof EmailAuthError
    await finish(m, 'failed', auth ? 'the email account needs to be reconnected' : 'could not reach the provider to authorize the send; nothing was sent', opts.actor, { failure_code: auth ? 'auth' : 'token' })
    return { messageId, status: 'failed', reason: auth ? 'reconnect the account' : 'authorization unavailable' }
  }
  const content = decryptContent(m.id, m.key_id, m.content_ciphertext)
  const result = await adapter.send(accountRef(account), token, { internetMessageId: m.internet_message_id, from: account.address, fromName: account.display_name, to: m.to_addresses, cc: m.cc_addresses, content, deploiId: m.id,
    inReplyTo: m.in_reply_to, references: m.in_reply_to ? [m.in_reply_to] : [], replyTo: account.provider === 'deploi' && m.reply_token ? replyAddress(account.address, m.reply_token) : null })
  if (result.outcome === 'accepted') {
    await finish(m, 'accepted', null, opts.actor, { accepted_at: new Date().toISOString(), accepted_evidence: result.evidence, provider_message_id: result.providerMessageId, provider_thread_id: result.providerThreadId, failure_code: null })
    return { messageId, status: 'accepted' }
  }
  if (result.outcome === 'rejected') {
    if (result.auth) await markAccountAuthFailure(account.id, result.message)
    await finish(m, 'failed', result.message, opts.actor, { failure_code: result.code })
    return { messageId, status: 'failed', reason: result.message }
  }
  if (result.outcome === 'throttled') {
    const giveUp = m.attempts + 1 >= emailConfig.maxAttempts
    await finish(m, giveUp ? 'failed' : 'queued', giveUp ? 'the provider kept rate-limiting; nothing was sent' : `the provider asked to wait ${result.retryAfterSec}s; nothing was sent yet`, opts.actor,
      { failure_code: result.code, next_attempt_at: giveUp ? null : new Date(Date.now() + result.retryAfterSec * 1000).toISOString() })
    return { messageId, status: giveUp ? 'failed' : 'queued' }
  }
  // uncertain: the provider may have accepted it. Never resend blindly: look for it first.
  await finish(m, 'delivery_unknown', `${result.message}; checking whether it was sent`, opts.actor, { failure_code: result.code })
  return reconcileMessage(m.id, { actor: opts.actor })
}

async function finish(m: EmailMessageRow, status: EmailStatus, reason: string | null, actor: string, extra: Record<string, unknown> = {}) {
  await admin(async db => {
    const sets = ['status = $2', 'status_reason = $3'], vals: unknown[] = [m.id, status, reason]
    for (const [k, v] of Object.entries(extra)) { vals.push(v); sets.push(`${k} = $${vals.length}`) }
    await db.query(`update email_messages set ${sets.join(', ')} where id = $1`, vals)
    await audit(db, { orgId: m.org_id, entityType: 'execution', entityId: m.id, event: `email.${status}`, actor, detail: { email_message: true, reason: reason?.slice(0, 200) ?? null, code: (extra.failure_code as string | undefined) ?? null } })
  })
}

/**
 * After an uncertain outcome: look the message up in the account's Sent mail (needs read access).
 * Found -> Accepted. Not found on two checks at least five minutes apart -> one more attempt.
 * Cannot look -> stays Delivery unknown until the merchant checks and decides.
 */
export async function reconcileMessage(messageId: string, opts: { actor: string; now?: Date }): Promise<SendOutcome> {
  const now = opts.now ?? new Date()
  const m = await admin(db => db.one<EmailMessageRow>('select * from email_messages where id = $1', [messageId]))
  if (!m || !['delivery_unknown', 'sending'].includes(m.status)) return { messageId, status: m?.status ?? 'failed', reason: m?.status_reason }
  const account = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [m.account_id]))
  let lookup: FindResult | null | 'error' = null
  try {
    if (account && account.status !== 'disconnected') lookup = await emailAdapter(account.provider).findSent(accountRef(account), await accessToken(account.id), m.internet_message_id)
  } catch { lookup = 'error' }
  if (lookup && lookup !== 'error' && lookup.found) {
    await finish(m, 'accepted', null, opts.actor, { accepted_at: now.toISOString(), accepted_evidence: 'found in the account\'s Sent mail after an uncertain response', provider_message_id: lookup.providerMessageId, provider_thread_id: lookup.providerThreadId, failure_code: null })
    return { messageId, status: 'accepted' }
  }
  if (lookup === null || lookup === 'error') {
    const reason = lookup === null
      ? 'the provider did not confirm the send and Deploi cannot check the Sent folder without read access: check it, then tell Deploi whether it went out'
      : 'the provider did not confirm the send and the Sent folder could not be checked yet; Deploi will check again'
    await finish(m, 'delivery_unknown', reason, opts.actor, { reconcile_checks: m.reconcile_checks + 1 })
    return { messageId, status: 'delivery_unknown', reason }
  }
  const checks = m.reconcile_checks + 1
  const since = now.getTime() - new Date(m.sending_started_at ?? m.updated_at).getTime()
  if (!emailAdapter(account!.provider).reliableNotFound) {
    const reason = 'not found in the Sent folder, but this provider cannot prove it was not sent: check the Sent folder, then tell Deploi whether it went out (Deploi will not resend on its own)'
    await finish(m, 'delivery_unknown', reason, opts.actor, { reconcile_checks: checks })
    return { messageId, status: 'delivery_unknown', reason }
  }
  if (checks >= 2 && since >= 5 * 60e3 && m.attempts < emailConfig.maxAttempts) {
    await finish(m, 'queued', 'not found in the Sent folder after an uncertain response: sending again once', opts.actor, { reconcile_checks: checks, next_attempt_at: null })
    return sendMessage(m.id, { actor: opts.actor, now })
  }
  const reason = 'not found in the Sent folder yet; Deploi will check again before deciding'
  await finish(m, 'delivery_unknown', reason, opts.actor, { reconcile_checks: checks })
  return { messageId, status: 'delivery_unknown', reason }
}

/** The merchant resolves an unknown outcome after checking their Sent folder. "Not sent" re-sends under their approval. */
export async function resolveUnknown(actor: Actor, messageId: string, decision: 'was_sent' | 'not_sent'): Promise<SendOutcome> {
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string; status: string }>('select id, org_id, status from email_messages where id = $1', [messageId]))
  if (!visible) throw new EngineError('not_found', 'message not found')
  assertMerchant(actor, visible.org_id)
  const m = await admin(db => db.one<EmailMessageRow>('select * from email_messages where id = $1', [messageId]))
  if (!m || m.status !== 'delivery_unknown') throw new EngineError('not_pending', 'only messages with unknown delivery can be resolved')
  if (decision === 'was_sent') {
    await finish(m, 'accepted', null, actor.label, { accepted_at: new Date().toISOString(), accepted_evidence: `confirmed by ${actor.label} from the account's Sent folder` })
    return { messageId, status: 'accepted' }
  }
  await admin(db => db.query(`update email_messages set status = 'queued', status_reason = 'you confirmed it was not sent: sending again', approval_kind = 'individual', approved_by = $2,
    approved_hash = content_hash, approved_at = now(), next_attempt_at = null where id = $1 and status = 'delivery_unknown'`, [m.id, actor.label]))
  return sendMessage(m.id, { actor: actor.label })
}

/** Retry a failed message (after reconnecting, for example) under the merchant's approval of the same content. */
export async function retryMessage(actor: Actor, messageId: string): Promise<SendOutcome> {
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from email_messages where id = $1', [messageId]))
  if (!visible) throw new EngineError('not_found', 'message not found')
  assertMerchant(actor, visible.org_id)
  const r = await admin(db => db.query(`update email_messages set status = 'awaiting_approval', status_reason = 'failed earlier: approve to send again', approval_kind = null, approved_hash = null,
    approved_by = null, approved_at = null, attempts = 0, reconcile_checks = 0, next_attempt_at = null where id = $1 and status = 'failed' returning id`, [messageId]))
  if (!r.length) throw new EngineError('not_retryable', 'only failed messages can be retried')
  const m = await admin(db => db.one<EmailMessageRow>('select content_hash from email_messages where id = $1', [messageId]))
  return approveMessage(actor, messageId, m!.content_hash)
}

/** Send every due queued message of one agent (or all agents when omitted), oldest first. */
export async function processQueue(opts: { agentId?: string; actor: string; now?: Date; limit?: number }) {
  const due = await admin(db => db.query<{ id: string }>(`select id from email_messages where status = 'queued' and (next_attempt_at is null or next_attempt_at <= $1)
    and ($2::uuid is null or agent_id = $2) order by created_at limit $3`, [(opts.now ?? new Date()).toISOString(), opts.agentId ?? null, opts.limit ?? 50]))
  const out: SendOutcome[] = []
  for (const d of due) out.push(await sendMessage(d.id, { actor: opts.actor, now: opts.now }))
  return out
}

/** Recover interrupted sends and re-check unknown outcomes (cron). */
export async function reconcileOpen(opts: { actor?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date()
  const actor = opts.actor ?? 'system:email'
  await admin(db => db.query(`update email_messages set status = 'delivery_unknown', status_reason = 'the send was interrupted; checking whether it went out'
    where status = 'sending' and sending_started_at < $1`, [new Date(now.getTime() - 10 * 60e3).toISOString()]))
  const open = await admin(db => db.query<{ id: string }>(`select id from email_messages where status = 'delivery_unknown' and updated_at < $1 and reconcile_checks < 20 order by updated_at limit 50`,
    [new Date(now.getTime() - 4 * 60e3).toISOString()]))
  const out: SendOutcome[] = []
  for (const o of open) out.push(await reconcileMessage(o.id, { actor, now }))
  return out
}

/** Pause, revoke and delete: queued messages never go out (revoke and delete also close those awaiting approval). */
export async function cancelAgentEmail(db: Db, agentId: string, reason: string, includeAwaiting: boolean) {
  const r = await db.query<{ id: string }>(`update email_messages set status = 'cancelled', status_reason = $2, next_attempt_at = null
    where agent_id = $1 and status in (${includeAwaiting ? `'queued','awaiting_approval','draft'` : `'queued'`}) returning id`, [agentId, reason])
  return r.length
}

/** Optional reply tracking (needs read permission): records that a reply arrived, never its content. */
export async function checkReplies(agentId: string, opts: { actor: string }) {
  const rows = await admin(async db => {
    const ctx = await agentPolicy(db, agentId)
    const e = ctx.policy?.email
    if (!e?.read.enabled || ctx.agentStatus !== 'active') return []
    return db.query<EmailMessageRow>(`select * from email_messages where agent_id = $1 and task_key = 'supplier_reorder' and status = 'accepted' and accepted_at > now() - interval '30 days'`, [agentId])
  })
  let updated = 0
  for (const m of rows) {
    const account = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [m.account_id]))
    if (!account || account.status !== 'active' || !account.can_read) continue
    try {
      const replies = await emailAdapter(account.provider).listReplies(accountRef(account), await accessToken(account.id), { internetMessageId: m.internet_message_id, providerThreadId: m.provider_thread_id })
      if (!replies || replies.length === m.reply_count) continue
      const last = replies.map(r => r.receivedAt).sort().pop() ?? null
      await admin(async db => {
        await db.query('update email_messages set reply_count = $2, reply_seen_at = $3 where id = $1', [m.id, replies.length, last])
        await audit(db, { orgId: m.org_id, entityType: 'execution', entityId: m.id, event: 'email.reply_seen', actor: opts.actor, detail: { email_message: true, replies: replies.length } })
      })
      updated++
    } catch { /* reply tracking is best effort and never changes what the agent may do */ }
  }
  return updated
}
