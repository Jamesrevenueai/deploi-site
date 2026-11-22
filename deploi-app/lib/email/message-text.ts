/**
 * The text of a stored inbound message, for the agent that is handling it.
 *
 * The Outlook inbox sync stores every message in email_inbound with its subject and text encrypted (AAD
 * `email-inbound:<row id>`, the same key and AAD the inbox reader uses) and emits `mail.received` with ids, sender
 * and subject only, so no message text is ever stored in agent_events or connection_events. An agent that needs the
 * words (a renter's answers, a picked time, a vendor's "decline", an opt-out) reads them here, in-process, at the
 * moment it handles the event. Nothing read here is logged, stored on the event or returned to a caller other than
 * the handler.
 *
 *  readInboundText(db, orgId, inboundId)  the decrypted { subject, text }; null when the row is missing, belongs to
 *                                         another organization, is quarantined, not yet encrypted, or was purged.
 *  withInboundText(db, e)                 a mail.received event with `text` (and `subject`, `messageId`) filled in
 *                                         from the stored row when the payload carries none; null for quarantined
 *                                         mail (an agent never acts on it); the event unchanged otherwise.
 */
import type { Db } from '../db'
import type { AgentEvent } from '../events'
import { decryptSecret } from '../connectors/credentials'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Row = { id: string; status: string; key_id: string; content_ciphertext: string }

export async function readInboundText(db: Db, orgId: string, inboundId: string): Promise<{ subject: string; text: string } | null> {
  if (!UUID.test(String(inboundId ?? '')) || !UUID.test(String(orgId ?? ''))) return null
  const r = await db.one<Row>('select id, status, key_id, content_ciphertext from email_inbound where id = $1 and org_id = $2', [inboundId, orgId])
  if (!r || r.status !== 'accepted' || r.key_id === 'pending' || !r.content_ciphertext) return null
  try {
    const c = JSON.parse(decryptSecret(r.key_id, r.content_ciphertext, `email-inbound:${r.id}`)) as { subject?: unknown; text?: unknown }
    return { subject: typeof c.subject === 'string' ? c.subject : '', text: typeof c.text === 'string' ? c.text : '' }
  } catch {
    // a key that cannot open the row is treated as no text; the reason is never logged with content
    return null
  }
}

export async function withInboundText(db: Db, e: AgentEvent): Promise<AgentEvent | null> {
  const p = e.payload ?? {}
  if (e.type !== 'mail.received' || typeof p.text === 'string') return e
  if (p.status === 'quarantined') return null
  if (typeof p.inboundId !== 'string') return e
  const c = await readInboundText(db, e.orgId, p.inboundId)
  if (!c) return e
  return {
    ...e,
    payload: {
      ...p, text: c.text, subject: typeof p.subject === 'string' && p.subject ? p.subject : c.subject,
      messageId: p.messageId ?? p.providerMessageId ?? p.inboundId,
    },
  }
}
