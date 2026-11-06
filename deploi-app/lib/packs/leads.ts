/**
 * Lead intake for every pack (the LeadSource): a lead email from Zillow, Apartments.com, Zumper, Realtor.com,
 * a website form or a plain email is reduced to a name, an address, a phone and, for renters, the answers to
 * the four questions everyone is asked. Only labelled fields are read ("Budget: $2,000", "Move-in: ...",
 * "Bedrooms: 2", "Pets: no"); free text is never mined for anything, so nothing about a person is inferred.
 * One row per provider message; the same person writing again within 30 days is a duplicate, not a new lead.
 */
import type { Db } from '../db'
import type { LeasingCriteria } from './templates'

export type LeadSourceKey = 'email' | 'website' | 'zillow' | 'apartments_com' | 'zumper' | 'realtor_com' | 'crm' | 'buildium' | 'phone' | 'manual'
export type ParsedLead = { source: LeadSourceKey; externalId: string; name: string | null; email: string | null; phone: string | null; subject: string | null; criteria: LeasingCriteria; intent: 'inquiry' | 'buyer' | 'seller' | 'renter' | 'service' }
/** A lead source turns a provider event into a lead (W3's Outlook / CRM / Buildium clients emit the same payload shape). */
export interface LeadSource { parse(payload: Record<string, unknown>): ParsedLead | null }

const PORTALS: [RegExp, LeadSourceKey][] = [[/zillow\.com$|trulia\.com$|hotpads\.com$/i, 'zillow'], [/apartments\.com$/i, 'apartments_com'], [/zumper\.com$|padmapper\.com$/i, 'zumper'], [/realtor\.com$/i, 'realtor_com']]
const EMAIL = /[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i
const str = (v: unknown, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
const field = (text: string, labels: string[]) => {
  for (const l of labels) {
    const m = new RegExp(`^\\s*(?:${l})\\s*[:\\-]\\s*(.+?)\\s*$`, 'im').exec(text)
    if (m) return m[1].trim()
  }
  return null
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const iso = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null }

/** A move-in date written as 2026-12-01, 12/01/2026, December 1, 2026 or 1 December 2026 (a year-less date is the next one after today). */
export function parseDate(v: string | null, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!v) return null
  const t = v.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1')
  let m = /\b(20\d\d)-(\d\d?)-(\d\d?)\b/.exec(t)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = /\b(\d\d?)\/(\d\d?)\/(20\d\d)\b/.exec(t)
  if (m) return iso(+m[3], +m[1], +m[2])
  const year = +today.slice(0, 4)
  const next = (mo: number, d: number, y?: string) => y ? iso(+y, mo, d) : ((iso(year, mo, d) ?? '') >= today ? iso(year, mo, d) : iso(year + 1, mo, d))
  m = /\b([a-z]{3})[a-z]*\.? (\d\d?)(?:,? (20\d\d))?\b/.exec(t)
  if (m && MONTHS.includes(m[1])) return next(MONTHS.indexOf(m[1]) + 1, +m[2], m[3])
  m = /\b(\d\d?) ([a-z]{3})[a-z]*\.?(?:,? (20\d\d))?\b/.exec(t)
  if (m && MONTHS.includes(m[2])) return next(MONTHS.indexOf(m[2]) + 1, +m[1], m[3])
  return null
}
export function parseMoney(v: string | null): number | null {
  if (!v) return null
  const m = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k)?\b/i.exec(v)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, '')) * (m[3] ? 1000 : 1) + (m[2] ? Number(`0.${m[2]}`) : 0)
  return n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null
}
export function parseBedrooms(v: string | null): number | null {
  if (!v) return null
  if (/\bstudio\b/i.test(v)) return 0
  const m = /\b(\d{1,2})\b/.exec(v)
  return m && +m[1] <= 10 ? +m[1] : null
}
export function parsePets(v: string | null): boolean | null {
  if (!v) return null
  const t = v.toLowerCase()
  if (/^\s*(no|none|n\/a|0|no pets|false)\b/.test(t)) return false
  if (/\b(yes|dog|dogs|cat|cats|pet|pets|bird|1|2|true)\b/.test(t)) return true
  return null
}

export function renterCriteria(text: string, today?: string): LeasingCriteria {
  return {
    budget: parseMoney(field(text, ['budget', 'max(?:imum)? rent', 'monthly budget', 'price range', 'rent'])),
    moveIn: parseDate(field(text, ['move[- ]?in(?: date)?', 'desired move[- ]?in', 'move date']), today),
    bedrooms: parseBedrooms(field(text, ['bedrooms', 'beds', 'bedroom'])),
    pets: parsePets(field(text, ['pets', 'pet'])),
  }
}

/** The lead.email payload: { from, fromName?, replyTo?, subject, text, messageId, source? }. */
export const emailLeadSource: LeadSource = {
  parse(p) {
    const from = str(p.from, 254)?.toLowerCase() ?? null
    const text = str(p.text, 20000) ?? ''
    const subject = str(p.subject, 300)
    const externalId = str(p.messageId, 300) ?? str(p.externalId, 300)
    if (!externalId) return null
    const domain = from?.split('@')[1] ?? ''
    const portal = PORTALS.find(([re]) => re.test(domain))?.[1]
    const given = str(p.source, 40) as LeadSourceKey | null
    const source: LeadSourceKey = portal ?? (given && ['email', 'website', 'zillow', 'apartments_com', 'zumper', 'realtor_com', 'crm', 'buildium', 'phone', 'manual'].includes(given) ? given : 'email')
    const labelled = field(text, ['email', 'e-mail', 'email address'])
    const email = (labelled && EMAIL.exec(labelled)?.[0]) || (str(p.replyTo, 254) && EMAIL.exec(String(p.replyTo))?.[0]) || (!portal && from && EMAIL.test(from) ? from : null)
    const name = field(text, ['name', 'full name', 'renter', 'contact']) ?? str(p.fromName, 160)
    const phone = field(text, ['phone', 'phone number', 'mobile', 'tel'])
    const intentField = (field(text, ['lead type', 'inquiry type', 'type']) ?? '').toLowerCase()
    const seller = /\bsell|seller|home value|valuation|list my\b/.test(`${intentField} ${(subject ?? '').toLowerCase()}`)
    return {
      source, externalId, name: name ? name.slice(0, 160) : null, email: email ? email.toLowerCase().slice(0, 254) : null, phone: phone ? phone.replace(/[^\d+()\- .]/g, '').slice(0, 40) || null : null,
      subject, criteria: renterCriteria(text), intent: seller ? 'seller' : /\bbuy|buyer\b/.test(intentField) ? 'buyer' : 'inquiry',
    }
  },
}

export type LeadRow = {
  id: string; org_id: string; pack: string; source: string; external_id: string; name: string | null; email: string | null; phone: string | null; intent: string; subject: string | null
  criteria: LeasingCriteria; status: string; duplicate_of: string | null; replied_at: string | null; last_inbound_at: string | null; follow_ups: number; next_follow_up_at: string | null
  proposed_slots: { start: string; end: string; label: string }[]; crm_record_id: string | null; created_at: string
}

/** Record a lead once. Returns the row and whether it is new, a repeat of the same message, or a duplicate of an earlier lead. */
export async function intakeLead(db: Db, orgId: string, pack: string, l: ParsedLead, intent: LeadRow['intent']): Promise<{ lead: LeadRow; kind: 'new' | 'repeat' | 'duplicate' }> {
  const prior = await db.one<LeadRow>('select * from pack_leads where org_id = $1 and source = $2 and external_id = $3', [orgId, l.source, l.externalId])
  if (prior) return { lead: prior, kind: 'repeat' }
  const earlier = l.email ? await db.one<LeadRow>(`select * from pack_leads where org_id = $1 and pack = $2 and lower(email) = $3 and status <> 'duplicate' and created_at > now() - interval '30 days' order by created_at limit 1`, [orgId, pack, l.email]) : null
  const lead = (await db.one<LeadRow>(`insert into pack_leads (org_id, pack, source, external_id, name, email, phone, intent, subject, criteria, status, duplicate_of, last_inbound_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) on conflict (org_id, source, external_id) do update set last_inbound_at = now() returning *`,
    [orgId, pack, l.source, l.externalId, l.name, l.email, l.phone, intent, l.subject, JSON.stringify(l.criteria), earlier ? 'duplicate' : 'new', earlier?.id ?? null]))!
  if (earlier) {
    // a repeat inquiry: keep any answer the person gave this time, on the first lead (same questions for everyone)
    const merged = { ...earlier.criteria, ...Object.fromEntries(Object.entries(l.criteria).filter(([, v]) => v !== null && v !== undefined)) }
    await db.query(`update pack_leads set criteria = $2, last_inbound_at = now() where id = $1`, [earlier.id, JSON.stringify(merged)])
  }
  return { lead, kind: earlier ? 'duplicate' : 'new' }
}

/** A new lead created in the CRM: { externalId, email, name?, phone?, intent? ('buyer' | 'seller') }. */
export const crmLeadSource: LeadSource = {
  parse(p) {
    const externalId = str(p.externalId, 300) ?? str(p.id, 300)
    const email = str(p.email, 254)
    if (!externalId) return null
    const intent = p.intent === 'seller' ? 'seller' : p.intent === 'buyer' ? 'buyer' : 'inquiry'
    return { source: 'crm', externalId, name: str(p.name, 160), email: email && EMAIL.test(email) ? EMAIL.exec(email)![0].toLowerCase() : null, phone: str(p.phone, 40), subject: null, criteria: {}, intent }
  },
}
