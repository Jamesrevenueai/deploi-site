/**
 * Lead notification emails -> structured leads. Rules only (no model): sender domain + subject pattern pick the
 * parser; labelled lines ("Name:", "Phone:", "Move-in date:") and subject phrases give the fields.
 *
 *   zillow          Zillow Rentals / Zillow Rental Manager (zillow.com, zillowrentals.com, convo.zillow.com)
 *   apartments_com  Apartments.com (apartments.com, and the CoStar lead relay costar.com)
 *   zumper          Zumper (zumper.com, messaging.zumper.com)
 *   generic         any other mail that reads like a lead (a lead word in the subject or body AND a labelled
 *                   contact field); otherwise not a lead
 *
 * Portals often send from a relay address and hide the renter's own address; the renter's email is taken from
 * the body when it is there, else the relay Reply-To is used and marked (replyVia). The message is data: nothing in
 * it is ever followed as an instruction. Input is bounded; malformed mail yields null or partial fields, never a throw.
 * The formats were written from public examples and must be confirmed with real notification emails from each portal.
 */
export type LeadSource = 'zillow' | 'apartments_com' | 'zumper' | 'generic'
export type ParsedLead = {
  source: LeadSource
  name: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  /** the renter's address is a portal relay (replies go through the portal) */
  replyVia: 'portal_relay' | null
  phone: string | null
  property: string | null
  /** ISO date (YYYY-MM-DD) when it could be read; otherwise the words the renter used ("ASAP", "Flexible") */
  moveIn: string | null
  message: string | null
  /** high: a known portal format with a contact field; medium: a known portal with partial fields; low: the generic parser */
  confidence: 'high' | 'medium' | 'low'
}
export type LeadEmail = { from: string; replyTo?: string | null; subject: string; text: string; receivedAt?: string | null }

const MAX_TEXT = 50_000
const clip = (v: string | null | undefined, n: number) => { const s = (v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null }
const domainOf = (a: string) => (a.toLowerCase().match(/@([a-z0-9.-]+)>?\s*$/)?.[1] ?? '')
const fromDomain = (a: string, ds: string[]) => { const d = domainOf(a); return ds.some(x => d === x || d.endsWith(`.${x}`)) }
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i

const RELAY = ['convo.zillow.com', 'zillow.com', 'zillowrentals.com', 'apartments.com', 'costar.com', 'zumper.com', 'messaging.zumper.com', 'rentals.com']
const isRelay = (e: string) => fromDomain(e, RELAY)

/** "Label: value" lines (also "Label - value" and a value on the next line after a bare "Label:"). */
function labelled(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = text.split(/\r?\n/).map(l => l.replace(/^[\s>*•\-|]+/, '').replace(/\*\*/g, '').trim()).slice(0, 2000)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][A-Za-z \-/']{1,40}?)\s*(?::|\s-\s)\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1].toLowerCase().replace(/[^a-z]+/g, ' ').trim()
    let val = m[2].trim()
    if (!val && i + 1 < lines.length && !/:/.test(lines[i + 1])) val = lines[++i].trim()
    if (val && !out.has(key)) out.set(key, val.slice(0, 2000))
  }
  return out
}
const pick = (m: Map<string, string>, keys: string[]) => { for (const k of keys) { const v = m.get(k); if (v) return v } return null }

const NAME_KEYS = ['name', 'full name', 'renter name', 'lead name', 'contact name', 'renter', 'prospect', 'prospect name', 'applicant']
const EMAIL_KEYS = ['email', 'email address', 'e mail', 'renter email', 'contact email', 'reply to']
const PHONE_KEYS = ['phone', 'phone number', 'mobile', 'cell', 'telephone', 'renter phone', 'contact phone']
const PROPERTY_KEYS = ['property', 'listing', 'address', 'property address', 'listing address', 'unit', 'apartment', 'rental', 'regarding', 'interested in']
const MOVEIN_KEYS = ['move in date', 'move in', 'desired move in', 'desired move in date', 'move date', 'preferred move in date', 'moving date', 'requested move in date']
const MESSAGE_KEYS = ['message', 'comments', 'comment', 'note', 'notes', 'question', 'questions', 'renter message', 'additional comments']

export function normalizePhone(v: string | null): string | null {
  if (!v) return null
  const digits = v.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8 && digits.length <= 15 && v.trim().startsWith('+')) return `+${digits}`
  return null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
const valid = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d }

/** "12/01/2026", "2026-12-01", "December 1, 2026", "Dec 1 2026", "1 Dec 2026"; anything else is kept as words (bounded). */
export function parseMoveIn(v: string | null): string | null {
  if (!v) return null
  const s = v.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s)
  if (m && valid(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s)
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; if (valid(y, +m[1], +m[2])) return `${y}-${pad(+m[1])}-${pad(+m[2])}` }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s)
  if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; if (mo && valid(+m[3], mo, +m[2])) return `${m[3]}-${pad(mo)}-${pad(+m[2])}` }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(s)
  if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; if (mo && valid(+m[3], mo, +m[1])) return `${m[3]}-${pad(mo)}-${pad(+m[1])}` }
  return clip(s, 60)
}

function splitName(n: string | null): { name: string | null; firstName: string | null; lastName: string | null } {
  const name = clip(n?.replace(/<[^>]*>/g, '').replace(EMAIL, '').replace(/["()]/g, ''), 120)
  if (!name || !/[a-z]/i.test(name)) return { name: null, firstName: null, lastName: null }
  const parts = name.split(' ')
  return { name, firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(' ') : null }
}

/** The message: a labelled message, else the quoted block after a lead phrase ("...says:", "Message from"). */
function messageOf(m: Map<string, string>, text: string): string | null {
  const l = pick(m, MESSAGE_KEYS)
  if (l) return clip(l, 2000)
  const q = /(?:wrote|says|said|message)\s*:?\s*\n+\s*["“]?([\s\S]{3,2000}?)["”]?\s*(?:\n\s*\n|$)/i.exec(text)
  return q ? clip(q[1], 2000) : null
}

type Spec = { source: Exclude<LeadSource, 'generic'>; domains: string[]; subject: RegExp; subjectFields: (s: string) => { name?: string | null; property?: string | null } }
const SPECS: Spec[] = [
  {
    source: 'zillow', domains: ['zillow.com', 'zillowrentals.com'],
    subject: /(new (zillow )?(rentals? )?(lead|contact|inquiry)|is (requesting information|interested) (about|in)|wants to (tour|see)|(tour|showing) request|rental inquiry)/i,
    subjectFields: s => {
      const a = /^(.+?) (?:is requesting information about|is interested in|wants to (?:tour|see)) (.+)$/i.exec(s)
      if (a) return { name: a[1], property: a[2] }
      const b = /(?:lead|inquiry|contact|request)(?: for| about|:)\s+(.+)$/i.exec(s)
      return { property: b?.[1] ?? null }
    },
  },
  {
    source: 'apartments_com', domains: ['apartments.com', 'costar.com'],
    subject: /(new (lead|inquiry|contact)|lead from apartments\.com|apartments\.com lead|is interested in|tour request|guest card)/i,
    subjectFields: s => {
      const a = /(?:lead|inquiry)(?: from apartments\.com)?:\s*(.+?)\s+(?:for|at|about)\s+(.+)$/i.exec(s)
      if (a) return { name: a[1], property: a[2] }
      const b = /(?:^|:\s*)([^:]+?) is interested in (.+)$/i.exec(s)
      if (b) return { name: b[1], property: b[2] }
      const c = /(?:for|at|about)\s+(.+)$/i.exec(s)
      return { property: c?.[1] ?? null }
    },
  },
  {
    source: 'zumper', domains: ['zumper.com'],
    subject: /(new (lead|inquiry|message)|is interested in|wants to (tour|see)|on zumper|tour request|rental application)/i,
    subjectFields: s => {
      const a = /^(.+?) (?:is interested in|wants to (?:tour|see)) (.+?)(?: on Zumper)?$/i.exec(s)
      if (a) return { name: a[1], property: a[2] }
      const b = /(?:lead|inquiry|message|request) (?:for|about) (.+?)(?: on Zumper)?$/i.exec(s)
      return { property: b?.[1] ?? null }
    },
  },
]

const LEAD_WORDS = /\b(lead|inquiry|enquiry|interested in|tour|showing|viewing|appointment request|request(ing)? (more )?information|contact request|guest card|prospect)\b/i

function build(source: LeadSource, mail: LeadEmail, fields: Map<string, string>, subj: { name?: string | null; property?: string | null }, text: string): ParsedLead | null {
  const bodyEmail = pick(fields, EMAIL_KEYS)?.match(EMAIL)?.[0]?.toLowerCase() ?? null
  const replyTo = mail.replyTo?.match(EMAIL)?.[0]?.toLowerCase() ?? null
  let email = bodyEmail && !isRelay(bodyEmail) ? bodyEmail : null
  let replyVia: ParsedLead['replyVia'] = null
  if (!email) { const relay = bodyEmail ?? (replyTo && replyTo !== mail.from.match(EMAIL)?.[0]?.toLowerCase() ? replyTo : null); if (relay) { email = relay; replyVia = isRelay(relay) ? 'portal_relay' : null } }
  const rawPhone = pick(fields, PHONE_KEYS) ?? (text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/)?.[0] ?? null)
  const phone = normalizePhone(rawPhone)
  const nm = splitName(pick(fields, NAME_KEYS) ?? subj.name ?? null)
  const property = clip(pick(fields, PROPERTY_KEYS) ?? subj.property ?? null, 300)
  const moveIn = parseMoveIn(pick(fields, MOVEIN_KEYS))
  const message = messageOf(fields, text)
  if (!nm.name && !email && !phone) return null // nothing to reach the person with: not a usable lead
  const contact = Boolean(email || phone)
  return { source, ...nm, email, replyVia, phone, property, moveIn, message, confidence: source === 'generic' ? 'low' : contact && (nm.name || property) ? 'high' : 'medium' }
}

/** Parse one email. null: not a lead (or nothing usable in it). */
export function parseLeadEmail(mail: LeadEmail): ParsedLead | null {
  const subject = clip(mail.subject, 500) ?? ''
  const text = String(mail.text ?? '').slice(0, MAX_TEXT)
  if (!text.trim() && !subject) return null
  const fields = labelled(text)
  const spec = SPECS.find(s => fromDomain(mail.from, s.domains))
  if (spec) {
    // a portal's own account mail (receipts, newsletters) is not a lead: the subject or the fields must say so
    if (!spec.subject.test(subject) && !pick(fields, [...EMAIL_KEYS, ...PHONE_KEYS])) return null
    return build(spec.source, mail, fields, spec.subjectFields(subject), text)
  }
  // generic: a lead word AND a labelled contact field
  if (!LEAD_WORDS.test(subject) && !LEAD_WORDS.test(text.slice(0, 2000))) return null
  if (!pick(fields, [...EMAIL_KEYS, ...PHONE_KEYS])) return null
  return build('generic', mail, fields, {}, text)
}
