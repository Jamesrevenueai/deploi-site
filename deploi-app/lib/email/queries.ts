/**
 * Email reads for the merchant UI. Rows are selected as the actor (RLS limits them to their
 * organization); message content is decrypted on the server only after that, and only for merchant
 * users of the organization. Deploi staff see metadata (status, counts, times), never content.
 */
import { admin } from '../db'
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { EMAIL_PROVIDERS, emailAdapter } from './adapters'
import { providerStatus, type EmailAccountRow } from './accounts'
import { decryptContent } from './content'

const ACCOUNT_COLS = 'id, org_id, provider, address, display_name, status, status_reason, granted_scopes, can_send, can_read, is_synthetic, last_checked_at, last_success_at, last_error_code, connected_by, connected_at, disconnected_at'
const orgFilter = (actor: Actor) => (actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()')

/** Implementation status shown to merchants: honest about what is configured and verified. */
export function providers() {
  return EMAIL_PROVIDERS.map(p => {
    const s = providerStatus(p)
    return {
      provider: p, label: s.label, configured: s.configured,
      status: p === 'synthetic' ? 'test_only' : s.configured ? 'configured_unverified' : 'not_configured',
      readScopes: emailAdapter(p).scopesFor({ read: true }).filter(x => !emailAdapter(p).scopesFor({ read: false }).includes(x)),
    }
  })
}

/** The organization's connected accounts. Agent mailboxes belong to one agent: listed only when `agentId` names that agent. */
export async function listAccounts(actor: Actor, opts: { includeDisconnected?: boolean; agentId?: string | null } = {}) {
  const agentId = opts.agentId && /^[0-9a-f-]{36}$/i.test(opts.agentId) ? opts.agentId : null
  const accounts = await withActor(actor, db => db.query<EmailAccountRow>(
    `select ${ACCOUNT_COLS} from email_accounts where ${orgFilter(actor)} ${opts.includeDisconnected ? '' : `and status <> 'disconnected'`}
     and (provider <> 'deploi' or agent_id = $1::uuid) order by connected_at`, [agentId]))
  if (!accounts.length) return []
  const usage = await withActor(actor, db => db.query<{ account_id: string; agents: string; sent_today: string; failed_7d: string; unknown: string; awaiting: string }>(
    `select a.id as account_id,
       (select count(*) from agents g join agent_policies p on p.id = g.active_policy_id where g.status in ('active','paused') and p.policy->'email'->>'accountId' = a.id::text)::text as agents,
       (select count(*) from email_messages m where m.account_id = a.id and m.status = 'accepted' and m.accepted_at >= date_trunc('day', now()))::text as sent_today,
       (select count(*) from email_messages m where m.account_id = a.id and m.status = 'failed' and m.updated_at > now() - interval '7 days')::text as failed_7d,
       (select count(*) from email_messages m where m.account_id = a.id and m.status = 'delivery_unknown')::text as unknown,
       (select count(*) from email_messages m where m.account_id = a.id and m.status = 'awaiting_approval')::text as awaiting
     from email_accounts a where a.id = any($1::uuid[])`, [accounts.map(a => a.id)]))
  const u = new Map(usage.map(x => [x.account_id, x]))
  return accounts.map(a => ({ ...a, label: emailAdapter(a.provider).label, usage: { agents: Number(u.get(a.id)?.agents ?? 0), sentToday: Number(u.get(a.id)?.sent_today ?? 0), failed7d: Number(u.get(a.id)?.failed_7d ?? 0), unknown: Number(u.get(a.id)?.unknown ?? 0), awaiting: Number(u.get(a.id)?.awaiting ?? 0) } }))
}

const MSG_COLS = `id, org_id, agent_id, run_id, account_id, policy_version, task_key, status, status_reason, from_address, to_addresses, cc_addresses, attachment_count, attachment_bytes,
  content_hash, approval_kind, approved_by, approved_at, qualification, attempts, next_attempt_at, accepted_at, accepted_evidence, failure_code, reply_seen_at, reply_count, created_at, updated_at`

export type MessageListItem = Record<string, unknown> & { id: string; subject: string | null; agent_name: string | null }

export async function listMessages(actor: Actor, f: { agentId?: string | null; status?: string | null; accountId?: string | null; limit?: number }) {
  const rows = await withActor(actor, db => db.query<Record<string, unknown> & { id: string; agent_id: string | null }>(
    `select ${MSG_COLS.split(',').map(c => 'm.' + c.trim()).join(', ')}, g.name as agent_name from email_messages m left join agents g on g.id = m.agent_id
     where ${actor.kind === 'staff' ? 'true' : 'm.org_id = current_org_id()'} and ($1::uuid is null or m.agent_id = $1) and ($2::text is null or m.status = $2) and ($3::uuid is null or m.account_id = $3)
     order by m.created_at desc limit $4`, [f.agentId ?? null, f.status ?? null, f.accountId ?? null, Math.min(f.limit ?? 100, 200)]))
  if (actor.kind === 'staff' || !rows.length) return rows.map(r => ({ ...r, subject: null }))
  const enc = await admin(db => db.query<{ id: string; key_id: string; content_ciphertext: string }>('select id, key_id, content_ciphertext from email_messages where id = any($1::uuid[])', [rows.map(r => r.id)]))
  const subj = new Map(enc.map(e => { try { return [e.id, decryptContent(e.id, e.key_id, e.content_ciphertext).subject] } catch { return [e.id, null] } }))
  return rows.map(r => ({ ...r, subject: subj.get(r.id) ?? null }))
}

/** One message with its exact content (what an approval covers). Merchant users of the organization only. */
export async function getMessage(actor: Actor, id: string) {
  const row = await withActor(actor, db => db.one<Record<string, unknown> & { id: string; org_id: string }>(`select ${MSG_COLS} from email_messages where id = $1 and ${orgFilter(actor)}`, [id]))
  if (!row) throw new EngineError('not_found', 'message not found')
  if (actor.kind === 'staff') return { ...row, content: null }
  const enc = await admin(db => db.one<{ key_id: string; content_ciphertext: string }>('select key_id, content_ciphertext from email_messages where id = $1', [id]))
  const c = decryptContent(id, enc!.key_id, enc!.content_ciphertext)
  return { ...row, content: { subject: c.subject, bodyText: c.bodyText, attachments: c.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, bytes: Math.floor(a.contentBase64.length * 3 / 4), preview: a.contentType === 'text/csv' ? Buffer.from(a.contentBase64, 'base64').toString('utf8').slice(0, 4000) : null })) } }
}
