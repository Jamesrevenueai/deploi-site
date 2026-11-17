/**
 * Every outgoing message a pack agent writes goes through sendPackMessage: the content policy check
 * (lib/packs/content-policy.ts) first, then the mail port, then a pack_messages row (the proof). The same
 * dedupe key never sends twice. A message that fails the policy is never sent (status 'blocked').
 */
import type { Db } from '../db'
import { checkMessage, type PolicyKind, type PolicyResult } from './content-policy'
import { PortError, portsFor } from './ports'
import type { ProofItem } from '../notify'

export type SendInput = {
  orgId: string; agentKey: string; leadId?: string | null
  to: string; subject: string; body: string
  dedupeKey: string
  policy: PolicyKind
  recipientNames?: (string | null | undefined)[]
  replyToMessageId?: string | null
}
export type SendResult =
  | { status: 'sent'; messageId: string; rowId: string; repeat: boolean; policy: PolicyResult }
  | { status: 'blocked'; policy: PolicyResult; rowId: string }
  | { status: 'failed'; error: string; rowId: string; policy: PolicyResult }

export async function sendPackMessage(db: Db, m: SendInput): Promise<SendResult> {
  const prior = await db.one<{ id: string; status: string; provider_message_id: string | null; policy: PolicyResult }>('select id, status, provider_message_id, policy from pack_messages where org_id = $1 and dedupe_key = $2', [m.orgId, m.dedupeKey])
  if (prior?.status === 'sent' && prior.provider_message_id) return { status: 'sent', messageId: prior.provider_message_id, rowId: prior.id, repeat: true, policy: prior.policy }
  const to = m.to.trim().toLowerCase()
  const policy = checkMessage({ to, subject: m.subject, body: m.body }, { kind: m.policy, recipientNames: m.recipientNames })
  const save = async (status: 'sent' | 'blocked' | 'failed', provider: string, messageId: string | null, error: string | null) => (await db.one<{ id: string }>(
    `insert into pack_messages (org_id, agent_key, lead_id, to_address, subject, body, status, policy, provider, provider_message_id, error, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (org_id, dedupe_key) do update set status = excluded.status, policy = excluded.policy, provider = excluded.provider, provider_message_id = excluded.provider_message_id,
       error = excluded.error, subject = excluded.subject, body = excluded.body, to_address = excluded.to_address returning id`,
    [m.orgId, m.agentKey, m.leadId ?? null, to.slice(0, 254), m.subject.slice(0, 300), m.body.slice(0, 20000), status, JSON.stringify(policy), provider, messageId, error, m.dedupeKey.slice(0, 300)]))!.id
  if (!policy.ok) return { status: 'blocked', policy, rowId: await save('blocked', 'none', null, policy.violations.map(v => `${v.kind}: ${v.term}`).join('; ').slice(0, 1000)) }
  const ports = await portsFor(m.orgId)
  try {
    const r = await ports.mail.send({ to, subject: m.subject, body: m.body, idempotencyKey: `${m.orgId}:${m.dedupeKey}`, replyToMessageId: m.replyToMessageId ?? null })
    return { status: 'sent', messageId: r.messageId, rowId: await save('sent', ports.mail.provider, r.messageId, null), repeat: false, policy }
  } catch (e) {
    const error = e instanceof PortError ? e.message : 'the mail provider stopped on an unexpected error'
    return { status: 'failed', error, rowId: await save('failed', ports.mail.provider, null, error), policy }
  }
}

/** Fresh read of a sent message from the mail provider (the verify step). */
export async function verifySent(orgId: string, messageId: string, label = 'Message'): Promise<{ ok: boolean; proof: ProofItem[] }> {
  const ports = await portsFor(orgId)
  try {
    const m = await ports.mail.getSent(messageId)
    if (!m) return { ok: false, proof: [{ label: `${label} not found at the mail provider`, value: messageId }] }
    if (m.status === 'bounced') return { ok: false, proof: [{ label: `${label} bounced`, value: m.to }] }
    return { ok: true, proof: [{ label: `${label} delivered to the provider`, value: `${m.to}: ${m.subject}` }] }
  } catch (e) {
    return { ok: false, proof: [{ label: `${label}: the mail provider did not answer the check`, value: (e as Error).message.slice(0, 200) }] }
  }
}

export const policyProof = (p: PolicyResult): ProofItem => ({ label: 'Content policy', value: p.ok ? `passed (${p.checked.length} checks${p.fairHousing ? ', fair housing included' : ''})` : `refused: ${p.violations.map(v => v.term).join(', ')}` })
