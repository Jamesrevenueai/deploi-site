/**
 * Plain English -> draft structured task. Deterministic and conservative: it only suggests a draft
 * for the merchant to review and complete; it never grants anything, never picks "all products"
 * unless the text says so, and reports what is missing. A general instruction ("fix my store")
 * produces no correction types and a request for scope.
 */
import type { CorrectionType, EmailPermission, EmailTask } from './policy'

export type TaskDraft = {
  correctionTypes: CorrectionType[]
  productScope: { mode: 'all' | 'products' | 'tags' | null; tags: string[] }
  exceptionTags: string[]
  approvalMode: 'review' | 'autonomous' | null
  schedule: { kind: 'manual' } | { kind: 'interval'; everyHours: number } | { kind: 'daily'; hour: number; minute: number } | null
  priceFields: ('price' | 'compareAtPrice')[]
  publicationName: string | null
  allowUnpublish: boolean
  allowSkuOverwrite: boolean
  /** what the merchant still has to choose before the policy can be granted */
  missing: string[]
  /** requests the product cannot do; reported, never silently dropped */
  unsupported: string[]
  /** email the text asks for; recipients found in the text are suggestions only, never granted */
  email: { tasks: EmailTask[]; permission: EmailPermission | null; addresses: string[] } | null
  /** the text asks about competitor stores (read only public pages) */
  competitor?: boolean
  /** phrases that drove each decision, shown on the review screen */
  matched: { phrase: string; meaning: string }[]
}

const has = (t: string, re: RegExp) => re.test(t)

const UNSUPPORTED: [RegExp, string][] = [
  [/\b(competitors?|rivals?|their|other stores?)'?s?\b[^.]{0,40}\b(sales|revenue|turnover|units sold|conversion|orders|profit)\b/, "another store's sales, revenue, units or conversion (not public; Deploi never estimates them)"],
  [/\b(restock|reorder|purchase order|stock (count|level)s?|inventory (count|quantit)|set (the )?stock|adjust (the )?(stock|inventory))\b/, 'changing stock quantities (Deploi never guesses or sets physical stock)'],
  [/\b(delete|remove) (the )?products?\b/, 'deleting products'],
  [/\b(archive|draft|un-?archive|change (the )?status)\b/, 'changing product status'],
  [/\b(write|rewrite|generate) (the )?(descriptions?|titles?|copy)\b/, 'writing product content'],
  [/\b(discount|coupon|promotion)s?\b/, 'discounts and promotions'],
  [/\b(amazon|woocommerce|ebay|etsy)\b/, 'other platforms (Shopify is the only operational platform today)'],
  [/\b(generate|create|make up|invent) (new )?skus?\b/, 'generating new SKUs (SKUs come only from your mapping file)'],
]

export function parseTask(input: string): TaskDraft {
  const t = ` ${input.toLowerCase().replace(/\s+/g, ' ')} `
  const d: TaskDraft = { correctionTypes: [], productScope: { mode: null, tags: [] }, exceptionTags: [], approvalMode: null, schedule: null, priceFields: [], publicationName: null, allowUnpublish: false, allowSkuOverwrite: false, email: null, missing: [], unsupported: [], matched: [] }
  const add = (c: CorrectionType, phrase: string) => { if (!d.correctionTypes.includes(c)) d.correctionTypes.push(c); d.matched.push({ phrase, meaning: `correction: ${c}` }) }

  if (has(t, /\b(backorders?|oversell(ing|s)?|over-sell(ing)?|oversold|continue selling|keep selling|sell (when|while|past|after) (out of stock|zero|sold out)|selling (with|at) (no|zero) stock|inventory polic(y|ies)|out of stock)\b/)) add('oversell_policy', 'overselling / backorders')
  if (has(t, /\b(publish|unpublish|published|sales channel|online store|point of sale|visible on|listed on|show on)\b/)) {
    add('publication', 'publication / sales channel')
    if (has(t, /\bpoint of sale\b/)) d.publicationName = 'Point of Sale'
    else if (has(t, /\bonline store\b/)) d.publicationName = 'Online Store'
    if (has(t, /\b(unpublish|hide|remove from)\b/)) { d.allowUnpublish = true; d.matched.push({ phrase: 'unpublish', meaning: 'may unpublish' }) }
  }
  if (has(t, /\b(price|prices|pricing|compare[- ]at)\b/)) {
    add('price', 'prices')
    d.priceFields.push('price')
    if (has(t, /\bcompare[- ]at\b/)) d.priceFields.push('compareAtPrice')
  }
  if (has(t, /\bskus?\b/)) {
    add('sku', 'SKUs')
    if (has(t, /\b(wrong|incorrect|fix|correct|mismatch)\w* skus?\b|\bskus? (that are )?(wrong|incorrect)\b/)) { d.allowSkuOverwrite = true; d.matched.push({ phrase: 'correct wrong SKUs', meaning: 'may overwrite SKUs that differ from the mapping' }) }
  }

  // email: only these three tasks exist; anything else about email is reported as unsupported
  const emailTasks: EmailTask[] = []
  if (has(t, /\b(email|e-mail|send|mail|notify|let me know|tell me)\b[^.]*\b(summary|summaries|report|results|what (it|you) did)\b|\b(daily|weekly)? ?(summary|report) (by|via|over) (e-?mail)\b/)) emailTasks.push('run_report')
  if (has(t, /\b(email|e-mail|notify|alert)\b[^.]*\b(needs? a person|problems?|issues?|anything (it|you) can'?t fix)\b/)) emailTasks.push('needs_person_alert')
  if (has(t, /\b(supplier|vendor|reorder|re-order|restock)\b/) && has(t, /\b(email|e-mail|write|message|ask|contact)\b/)) emailTasks.push('supplier_reorder')
  if (emailTasks.length) {
    const addresses = [...new Set([...input.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g)].map(m => m[0].toLowerCase()))].slice(0, 10)
    const permission: EmailPermission | null = has(t, /\b(draft|drafts|don'?t send|for me to send)\b/) ? 'draft'
      : has(t, /\b(automatically|without asking|on (its|it's) own)\b/) ? 'send_autonomous'
      : has(t, /\b(ask me|my approval|let me (review|approve)|before sending)\b/) ? 'send_approved' : null
    d.email = { tasks: emailTasks, permission, addresses }
    d.matched.push({ phrase: 'email', meaning: `email task${emailTasks.length === 1 ? '' : 's'}: ${emailTasks.join(', ')}` })
  }
  if (has(t, /\b(read|reply to|answer|respond to|go through) (my |the )?(inbox|emails?|mail)\b/)) d.unsupported.push('reading or answering your inbox (an agent can only notice replies to supplier requests it sent)')
  if (has(t, /\b(email|send) (to )?(all |my )?customers\b|\bnewsletter|marketing emails?\b/)) d.unsupported.push('emailing customers or marketing email')

  const tagMatch = [...t.matchAll(/\btagged (?:as |with )?["']?([a-z0-9][a-z0-9 _-]{0,40}?)["']?(?= products?\b| items?\b| and\b| or\b|[,.;]| except\b| $)/g)].map(m => m[1].trim())
  const exceptMatch = [...t.matchAll(/\bexcept (?:products |items |anything )?tagged (?:as |with )?["']?([a-z0-9][a-z0-9 _-]{0,40}?)["']?(?= products?\b| items?\b| and\b| or\b|[,.;]| $)/g)].map(m => m[1].trim())
  const scopeTags = tagMatch.filter(x => !exceptMatch.includes(x))
  if (exceptMatch.length) { d.exceptionTags = exceptMatch; d.matched.push({ phrase: `except tagged ${exceptMatch.join(', ')}`, meaning: 'exceptions' }) }
  if (scopeTags.length) { d.productScope = { mode: 'tags', tags: scopeTags }; d.matched.push({ phrase: `tagged ${scopeTags.join(', ')}`, meaning: 'product scope' }) }
  else if (has(t, /\b(all|every|each) (of (my|the) )?(products|items|variants)\b|\bwhole (store|catalog(ue)?)\b/)) { d.productScope = { mode: 'all', tags: [] }; d.matched.push({ phrase: 'all products', meaning: 'product scope: all products' }) }

  if (has(t, /\b(automatically|without asking|on (its|it's) own|no need to ask|just fix|go ahead and)\b/)) { d.approvalMode = 'autonomous'; d.matched.push({ phrase: 'automatically', meaning: 'suggests autonomous mode (you still grant it)' }) }
  else if (has(t, /\b(ask me|check with me|my approval|for approval|let me (review|approve)|before (changing|making))\b/)) { d.approvalMode = 'review'; d.matched.push({ phrase: 'ask me first', meaning: 'review mode' }) }

  const every = t.match(/\bevery (\d{1,3}) hours?\b/)
  if (every) d.schedule = { kind: 'interval', everyHours: Math.min(168, Math.max(1, Number(every[1]))) }
  else if (has(t, /\b(hourly|every hour)\b/)) d.schedule = { kind: 'interval', everyHours: 1 }
  else if (has(t, /\b(daily|every day|each day|every morning|nightly|every night)\b/)) d.schedule = { kind: 'daily', hour: has(t, /\b(night|nightly)\b/) ? 2 : 6, minute: 0 }
  else if (has(t, /\b(once|one[- ]time|right now|now)\b/)) d.schedule = { kind: 'manual' }
  if (d.schedule) d.matched.push({ phrase: 'schedule', meaning: d.schedule.kind === 'interval' ? `every ${d.schedule.everyHours} h` : d.schedule.kind })

  if (has(t, /\b(competitors?|rivals?|other stores?|competing stores?)\b/)) { d.competitor = true; d.matched.push({ phrase: 'competitors', meaning: 'check the competitor stores the agent watches (public pages only)' }) }
  for (const [re, what] of UNSUPPORTED) if (has(t, re)) d.unsupported.push(what)

  if (!d.correctionTypes.length && !d.email) d.missing.push('what the agent should correct (overselling settings, publication, prices or SKUs) or which email task it should do')
  if (d.email) {
    d.missing.push('which connected email account it sends from')
    d.missing.push('exactly which addresses or domains it may email')
    if (!d.email.permission) d.missing.push('whether it only drafts, sends after your approval, or sends without asking within limits')
  }
  const emailOnlyWithoutProducts = !d.correctionTypes.length && d.email && !d.email.tasks.includes('supplier_reorder')
  if (!d.productScope.mode && !emailOnlyWithoutProducts) d.missing.push('which products it may work on')
  if (d.correctionTypes.includes('price')) d.missing.push('the price list to compare against')
  if (d.correctionTypes.includes('sku')) d.missing.push('the SKU mapping to use')
  if (d.correctionTypes.includes('publication')) { if (!d.publicationName) d.missing.push('which sales channel'); d.missing.push('the publication list or tags that say what should be published') }
  if (!d.approvalMode) d.missing.push('whether to ask before each change or act within limits')
  return d
}
