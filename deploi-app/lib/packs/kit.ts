/** Small shared pieces for the pack agents. */
import type { Db } from '../db'
import type { AgentEvent } from '../events'
import type { ProofItem } from '../notify'
import type { LeadRow } from './leads'

/** The event's own time (the sweep's tick, the mail's arrival): agents never read the wall clock. */
export const eventNow = (e: AgentEvent) => { const t = Date.parse(e.occurredAt); return Number.isNaN(t) ? new Date() : new Date(t) }
export const str = (v: unknown, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
export const addressOf = (v: unknown) => { const m = /[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i.exec(String(v ?? '')); return m ? m[0].toLowerCase() : null }
export const days = (n: number) => n * 864e5
export const hours = (n: number) => n * 3600e3
export const isoDay = (d: Date) => d.toISOString().slice(0, 10)
export const rowProof = (label: string, value: string): ProofItem => ({ label, value })

/** The new part of a reply (quoted lines and everything after "On ... wrote:" dropped), lower case. */
export function replyText(subject: unknown, text: unknown): string {
  const lines: string[] = []
  for (const l of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (/^On .{4,200} wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim())) break
    if (l.trim().startsWith('>')) continue
    lines.push(l)
  }
  return `${String(subject ?? '')}\n${lines.join('\n')}`.toLowerCase().slice(0, 5000)
}
export const saysYes = (t: string) => /\b(yes|yep|yeah|accept(?:ed)?|go ahead|let'?s do it|book it|sounds good|approved?|confirm(?:ed)?|all good|it'?s fixed|fixed|works now)\b/.test(t) && !saysNo(t)
export const saysNo = (t: string) => /\b(no thanks|not interested|went with (?:someone|another)|decline[ds]?|too expensive|not fixed|still (?:broken|leaking|not working)|doesn'?t work|^no\b|\bno\b[,.!]?\s*$)/m.test(t)
export const optedOut = (t: string) => /\b(unsubscribe|opt[ -]?out|remove me|stop (?:emailing|contacting|sending)|do not (?:contact|email)|don'?t (?:contact|email))\b/.test(t)

/** The most recent open lead of a pack from this address. */
export async function leadFrom(db: Db, orgId: string, packs: string[], email: string | null, statuses: string[]): Promise<LeadRow | null> {
  if (!email) return null
  return db.one<LeadRow>(`select * from pack_leads where org_id = $1 and pack = any($2::text[]) and lower(email) = $3 and status = any($4::text[]) order by created_at desc limit 1`, [orgId, packs, email, statuses])
}
