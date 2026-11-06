/**
 * The content policy every outgoing pack message passes before it is sent (lib/packs/outbound.ts).
 *
 * General checks (every pack): a valid single recipient, a subject and a body, no unfilled template field,
 * no raw HTML, a bounded length.
 *
 * Fair housing checks (leasing, real estate, property management): the message never mentions or infers a
 * protected characteristic (race, colour, national origin, religion, sex, familial status, disability, and the
 * common state and local additions: age, sexual orientation, gender identity, marital status, source of income)
 * and never uses steering language ("safe area", "good schools", "nice neighborhood", "people like you" ...).
 * The recipient's own name and address are masked before the scan, so a person named Christian or Black is
 * never refused a reply because of their name. A message that fails is not sent; the owner is told.
 */
export type PolicyKind = 'general' | 'fair_housing'
export type PolicyResult = { ok: boolean; fairHousing: boolean; checked: string[]; violations: { kind: string; term: string }[] }

const PROTECTED: { kind: string; terms: string[] }[] = [
  { kind: 'race or colour', terms: ['race', 'racial', 'white', 'black', 'hispanic', 'latino', 'latina', 'latinx', 'asian', 'african', 'caucasian', 'ethnic', 'ethnicity', 'minority', 'minorities', 'colored', 'coloured'] },
  { kind: 'national origin', terms: ['national origin', 'nationality', 'immigrant', 'immigrants', 'foreigner', 'foreigners', 'citizenship', 'english speaking', 'english-speaking', 'speak english', 'accent', 'country of origin', 'undocumented'] },
  { kind: 'religion', terms: ['religion', 'religious', 'christian', 'christians', 'muslim', 'muslims', 'jewish', 'jew', 'jews', 'catholic', 'church', 'churches', 'mosque', 'synagogue', 'temple', 'hindu', 'buddhist', 'sikh'] },
  { kind: 'sex or gender', terms: ['gender', 'male only', 'female only', 'men only', 'women only', 'man only', 'woman only', 'ladies only', 'gentlemen only', 'transgender', 'gender identity'] },
  { kind: 'familial status', terms: ['children', 'child', 'kids', 'kid', 'family-friendly', 'family friendly', 'families', 'pregnant', 'pregnancy', 'adults only', 'adult only', 'adult community', 'no kids', 'empty nesters', 'newlyweds', 'couples only', 'singles only'] },
  { kind: 'disability', terms: ['disability', 'disabilities', 'disabled', 'handicap', 'handicapped', 'wheelchair', 'blind', 'deaf', 'mental illness', 'able-bodied', 'able bodied', 'impairment'] },
  { kind: 'age', terms: ['elderly', 'seniors only', 'senior citizens', 'retirees', 'young professionals', 'students only', 'too old', 'too young'] },
  { kind: 'sexual orientation', terms: ['sexual orientation', 'gay', 'lesbian', 'straight couple', 'bisexual', 'queer'] },
  { kind: 'marital status', terms: ['marital status', 'married couple', 'married couples', 'unmarried'] },
  { kind: 'source of income', terms: ['section 8', 'section-8', 'voucher holders', 'no vouchers', 'welfare', 'public assistance', 'source of income'] },
]
const STEERING = ['safe area', 'safe neighborhood', 'safe neighbourhood', 'safe part of town', 'good schools', 'great schools', 'best schools', 'school district', 'nice neighborhood', 'nice neighbourhood',
  'good neighborhood', 'good neighbourhood', 'bad neighborhood', 'bad neighbourhood', 'bad area', 'rough area', 'sketchy', 'crime', 'low crime', 'high crime', 'exclusive', 'desirable area',
  'up-and-coming', 'up and coming', 'you would fit in', "you'd fit in", 'fit right in', 'your kind', 'people like you', 'perfect for you', 'ideal for you', 'right kind of', 'better suited', 'you might prefer', 'more comfortable in']

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (t: string) => new RegExp(`(^|[^a-z0-9])${esc(t).replace(/[ -]/g, '[\\s-]+')}(?=$|[^a-z0-9])`, 'i')
const PROTECTED_RE = PROTECTED.flatMap(p => p.terms.map(t => ({ kind: p.kind, term: t, re: wordRe(t) })))
const STEERING_RE = STEERING.map(t => ({ kind: 'steering', term: t, re: wordRe(t) }))
const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/** Replace the recipient's own name and address with neutral tokens before scanning. */
export function maskRecipient(text: string, names: (string | null | undefined)[], to: string | null): string {
  let t = text
  const parts = names.flatMap(n => (n ?? '').split(/\s+/)).map(p => p.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(p => p.length >= 2)
  for (const p of [...new Set(parts)].sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`(^|[^\\p{L}])${esc(p)}(?=$|[^\\p{L}])`, 'giu'), '$1[name]')
  if (to) t = t.split(to).join('[address]')
  return t
}

export function checkMessage(m: { to: string; subject: string; body: string }, o: { kind: PolicyKind; recipientNames?: (string | null | undefined)[] }): PolicyResult {
  const violations: PolicyResult['violations'] = []
  const checked = ['recipient', 'subject and body', 'template fields', 'no html', 'length']
  if (!EMAIL.test(m.to.trim()) || /[,;]/.test(m.to)) violations.push({ kind: 'recipient', term: 'not one valid address' })
  if (!m.subject.trim() || !m.body.trim()) violations.push({ kind: 'empty', term: 'subject or body is empty' })
  if (/\{\{|\}\}|\bundefined\b|\bnull\b|NaN/.test(`${m.subject}\n${m.body}`)) violations.push({ kind: 'template', term: 'an unfilled template field' })
  if (/<\s*(script|iframe|a|img|html|body)\b/i.test(m.body)) violations.push({ kind: 'html', term: 'raw HTML' })
  if (m.subject.length > 250 || m.body.length > 8000) violations.push({ kind: 'length', term: 'too long' })
  const fairHousing = o.kind === 'fair_housing'
  if (fairHousing) {
    checked.push('fair housing: protected characteristics', 'fair housing: steering language')
    const text = maskRecipient(`${m.subject}\n${m.body}`, o.recipientNames ?? [], m.to)
    for (const r of [...PROTECTED_RE, ...STEERING_RE]) if (r.re.test(text)) violations.push({ kind: r.kind, term: r.term })
  }
  return { ok: violations.length === 0, fairHousing, checked, violations }
}
