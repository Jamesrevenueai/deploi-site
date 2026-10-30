/**
 * An agent's structured task and permission policy. This object, not the plain-English task, is
 * what the merchant reviews and grants, and it is what the engine enforces in code: which store,
 * which products, which corrections and fields, which rules and reference files, which exceptions,
 * which limits, and whether covered changes run without asking (autonomous) or wait for approval
 * of each exact change (review).
 */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../engine/hash'

import { CORRECTION_TYPES, correctionCapability, correctionTypeForAction, fieldForAction, type CorrectionType } from '../engine/capabilities'
import type { Platform } from '../engine/types'
import { MAX_COMPETITOR_STORES, normalizeStoreUrl, storeKey } from '../competitors/url'
export { CORRECTION_TYPES, type CorrectionType }

export const CORRECTION_LABEL: Record<CorrectionType, string> = {
  oversell_policy: 'Overselling configuration',
  publication: 'Product publication',
  price: 'Prices',
  sku: 'SKUs',
}

/** The correction type and field of an action key come from the connector that registered it (lib/engine/capabilities.ts). */
export const actionType = (actionKey: string): CorrectionType | undefined => correctionTypeForAction(actionKey)
export const actionField = (actionKey: string): string | undefined => fieldForAction(actionKey)

/** Platform record ids (Shopify gids, WooCommerce numeric ids, Amazon SKUs): opaque, compared only. */
const productId = z.string().trim().min(1).max(200).regex(/^[\w:/.\-]+$/, 'not a product id')

/**
 * The three permission tiers, the same for every tool (store and email):
 *  draft            drafts only: proposals and drafts you can read; nothing is ever written or sent
 *  send_approved    after approval: each exact change or message waits for your approval
 *  send_autonomous  without asking, within the granted scope, limits and an end date at most one year away
 * New agents start at draft. Moving up a tier is an expansion and needs a new grant.
 */
export const TIERS = ['draft', 'send_approved', 'send_autonomous'] as const
export type Tier = typeof TIERS[number]
export const TIER_LABEL: Record<Tier, string> = {
  draft: 'Drafts only',
  send_approved: 'After my approval',
  send_autonomous: 'Without asking, within limits (up to one year)',
}
/** Store-change approval modes map one-to-one onto the tiers. */
export const APPROVAL_MODES = ['draft', 'review', 'autonomous'] as const
export type ApprovalMode = typeof APPROVAL_MODES[number]
export const tierOfMode = (m: ApprovalMode): Tier => (m === 'draft' ? 'draft' : m === 'review' ? 'send_approved' : 'send_autonomous')
export const MAX_AUTONOMY_MS = 366 * 864e5

/** Email tasks an agent can be authorized for. Each builds its messages from templates and store data; recipients come only from the policy. */
export const EMAIL_TASKS = ['run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup'] as const
export type EmailTask = typeof EMAIL_TASKS[number]
export const EMAIL_TASK_LABEL: Record<EmailTask, string> = {
  run_report: 'Send a summary of each run',
  needs_person_alert: 'Alert people about problems that need a person',
  supplier_reorder: 'Ask a supplier to confirm restock for low-stock products',
  supplier_followup: 'Follow up once, in the same thread, when a supplier has not replied',
}
/** cumulative permission levels: each includes the ones before it */
export const EMAIL_PERMISSIONS = ['draft', 'send_approved', 'send_autonomous'] as const
export type EmailPermission = typeof EMAIL_PERMISSIONS[number]
export const EMAIL_PERMISSION_LABEL: Record<EmailPermission, string> = {
  draft: 'Create drafts for review (never sends)',
  send_approved: 'Send messages you approve one by one',
  send_autonomous: 'Send without asking, within the recipients, purpose, limits and dates below',
}
const emailAddress = z.string().trim().toLowerCase().max(254).regex(/^[^\s@<>(),;:"\[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'not a valid email address')
const emailDomain = z.string().trim().toLowerCase().transform(d => d.replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'not a valid domain'))

export const EmailPolicySchema = z.object({
  accountId: z.string().uuid(),
  /** new email permissions start at drafts only */
  permission: z.enum(EMAIL_PERMISSIONS).default('draft'),
  /** shown in the authorization summary and in every message's audit record */
  purpose: z.string().trim().min(3).max(300),
  tasks: z.array(z.enum(EMAIL_TASKS)).min(1).max(4),
  /** who the agent may ever write to; a message to anyone else always waits for approval */
  recipients: z.object({
    addresses: z.array(emailAddress).max(50).default([]),
    domains: z.array(emailDomain).max(20).default([]),
  }).default({ addresses: [], domains: [] }),
  /** recipients of run summaries and alerts (each must satisfy the recipient rules) */
  notify: z.array(emailAddress).max(20).default([]),
  maxRecipientsPerMessage: z.number().int().min(1).max(20).default(5),
  limits: z.object({
    perRun: z.number().int().min(1).max(100).default(10),
    perDay: z.number().int().min(1).max(500).default(25),
  }).default({ perRun: 10, perDay: 25 }),
  /** end of the authorization (ISO date); required to send without asking */
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  allowAttachments: z.boolean().default(false),
  supplierReorder: z.object({
    supplierAddress: emailAddress,
    /** variants with this many available or fewer are listed */
    thresholdAvailable: z.number().int().min(0).max(10000).default(0),
    /** do not ask about the same variant again within this many days */
    cooldownDays: z.number().int().min(1).max(60).default(7),
    /** supplier_followup: days without a reply before the single follow-up */
    followupDays: z.number().int().min(1).max(30).default(3),
  }).optional(),
  /** reading the mailbox is a separate permission, only for a task that needs it */
  read: z.object({
    enabled: z.boolean().default(false),
    scope: z.literal('replies_to_agent_messages').default('replies_to_agent_messages'),
  }).default({ enabled: false, scope: 'replies_to_agent_messages' }),
})
export type EmailPolicy = z.infer<typeof EmailPolicySchema>

/** Is this address allowed by the policy's recipient rules? */
export function recipientAllowed(e: Pick<EmailPolicy, 'recipients'>, address: string): boolean {
  const a = address.trim().toLowerCase()
  if (e.recipients.addresses.includes(a)) return true
  const domain = a.split('@')[1] ?? ''
  return e.recipients.domains.some(d => domain === d)
}
export const permissionRank = (p: EmailPermission) => EMAIL_PERMISSIONS.indexOf(p)

/**
 * Competitor & Trend Watcher: which other stores' public pages to read, what to look for, and what to
 * alert on. Read only: it never logs in, buys, contacts the store or touches the merchant's store.
 */
export const COMPETITOR_ALERTS = ['launches', 'price_changes', 'discounts', 'availability', 'bestsellers', 'featured', 'trends'] as const
export type CompetitorAlert = typeof COMPETITOR_ALERTS[number]
export const COMPETITOR_ALERT_LABEL: Record<CompetitorAlert, string> = {
  launches: 'New products',
  price_changes: 'Price changes',
  discounts: 'Advertised discounts starting or ending',
  availability: 'Sold out or back in stock',
  bestsellers: 'Changes in public best-seller lists',
  featured: 'Newly featured or promoted products',
  trends: 'Similar products on several stores, and possible opportunities',
}
const keyword = z.string().trim().min(2).max(60).transform(k => k.toLowerCase())
export const CompetitorPolicySchema = z.object({
  /** each store is identified by its https origin; what the merchant typed is normalized on save */
  stores: z.array(z.object({ url: z.string().min(1).max(300), label: z.string().trim().max(80).optional() })).min(1, 'add at least one competitor store').max(MAX_COMPETITOR_STORES),
  /** only products whose title, type or tags contain one of these; empty = every product */
  keywords: z.array(keyword).max(30).default([]),
  alerts: z.array(z.enum(COMPETITOR_ALERTS)).min(1, 'choose at least one kind of alert').default([...COMPETITOR_ALERTS]),
  /** price changes smaller than this (percent) are not reported */
  minPriceChangePct: z.number().min(0).max(100).default(5),
  /** compare what competitors show with your own catalog titles (read only) to suggest opportunities */
  compareOwnCatalog: z.boolean().default(true),
}).transform((c, ctx) => {
  const seen = new Set<string>()
  const stores: { url: string; label?: string }[] = []
  c.stores.forEach((st, i) => {
    const n = normalizeStoreUrl(st.url)
    if (!n.ok) { ctx.addIssue({ code: 'custom', path: ['stores', i, 'url'], message: `${n.input || 'store'}: ${n.reason}` }); return }
    if (seen.has(storeKey(n.host))) { ctx.addIssue({ code: 'custom', path: ['stores', i, 'url'], message: `${n.host} is listed twice` }); return }
    seen.add(storeKey(n.host))
    stores.push({ url: n.url, ...(st.label ? { label: st.label } : {}) })
  })
  return { ...c, stores, keywords: [...new Set(c.keywords)], alerts: [...new Set(c.alerts)] }
})
export type CompetitorPolicy = z.infer<typeof CompetitorPolicySchema>
const tag = z.string().trim().min(1).max(255).transform(t => t.toLowerCase())

export const PolicySchema = z.object({
  connectionId: z.string().uuid(),
  correctionTypes: z.array(z.enum(CORRECTION_TYPES)).max(4).default([]),
  productScope: z.object({
    mode: z.enum(['all', 'products', 'tags']),
    productIds: z.array(productId).max(5000).default([]),
    tags: z.array(tag).max(50).default([]),
  }).superRefine((s, ctx) => {
    if (s.mode === 'products' && !s.productIds.length) ctx.addIssue({ code: 'custom', message: 'choose at least one product' })
    if (s.mode === 'tags' && !s.tags.length) ctx.addIssue({ code: 'custom', message: 'choose at least one tag' })
  }),
  exceptions: z.object({ productIds: z.array(productId).max(5000).default([]), tags: z.array(tag).max(50).default([]) }).default({ productIds: [], tags: [] }),
  rules: z.object({
    oversell_policy: z.object({
      exemptTags: z.array(tag).max(50).default(['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order']),
      flagInStockVariants: z.boolean().default(true),
    }).optional(),
    publication: z.object({
      publicationId: z.string().regex(/^gid:\/\/shopify\/Publication\/\d+$/),
      publicationName: z.string().min(1).max(120),
      /** instructions come from a publication list file, or from a tag rule */
      sourceId: z.string().uuid().nullable().default(null),
      publishTags: z.array(tag).max(50).default([]),
      allowUnpublish: z.boolean().default(false),
    }).optional(),
    price: z.object({
      sourceId: z.string().uuid(),
      fields: z.array(z.enum(['price', 'compareAtPrice'])).min(1).default(['price']),
      /** changes larger than this need individual approval even in autonomous mode; null = no limit */
      maxChangePct: z.number().min(0).max(1000).nullable().default(20),
      skipVariantsOnSale: z.boolean().default(true),
    }).optional(),
    sku: z.object({
      sourceId: z.string().uuid(),
      /** false: only fill missing SKUs; true: also correct SKUs that differ from the mapping */
      allowOverwrite: z.boolean().default(false),
    }).optional(),
  }).default({}),
  limits: z.object({
    maxChangesPerRun: z.number().int().min(1).max(500).default(25),
    maxChangesPerDay: z.number().int().min(1).max(5000).default(100),
  }).default({ maxChangesPerRun: 25, maxChangesPerDay: 100 }),
  /** drafts only by default; autonomous needs validUntil at most one year away */
  approvalMode: z.enum(APPROVAL_MODES).default('draft'),
  /** end of an autonomous store authorization (ISO); after it, changes wait for approval again */
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  /** read-only checks that report problems for a person (never write), e.g. oversold variants */
  watch: z.array(z.string().min(1).max(80)).max(10).default([]),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('interval'), everyHours: z.number().int().min(1).max(168) }),
    z.object({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), timezone: z.string().min(1).max(64) }),
  ]).default({ kind: 'manual' }),
  email: EmailPolicySchema.optional(),
  competitors: CompetitorPolicySchema.optional(),
}).superRefine((p, ctx) => {
  if (!p.correctionTypes.length && !p.email && !p.watch.length && !p.competitors) ctx.addIssue({ code: 'custom', path: ['correctionTypes'], message: 'choose at least one correction type, check, email task or competitor store' })
  if (p.approvalMode === 'autonomous' && p.correctionTypes.length) {
    if (!p.validUntil) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'changing the store without asking needs an end date' })
    else if (new Date(p.validUntil).getTime() - Date.now() > MAX_AUTONOMY_MS) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'an authorization to change the store without asking lasts at most one year' })
  }
  if (p.email) {
    const e = p.email
    if (!e.recipients.addresses.length && !e.recipients.domains.length) ctx.addIssue({ code: 'custom', path: ['email', 'recipients'], message: 'name at least one recipient address or domain the agent may write to' })
    for (const a of e.notify) if (!recipientAllowed(e, a)) ctx.addIssue({ code: 'custom', path: ['email', 'notify'], message: `${a} is outside the recipient rules` })
    if ((e.tasks.includes('run_report') || e.tasks.includes('needs_person_alert')) && !e.notify.length) ctx.addIssue({ code: 'custom', path: ['email', 'notify'], message: 'choose who receives summaries and alerts' })
    if (e.tasks.includes('supplier_reorder')) {
      if (!e.supplierReorder) ctx.addIssue({ code: 'custom', path: ['email', 'supplierReorder'], message: 'the supplier reorder task needs a supplier address and threshold' })
      else if (!recipientAllowed(e, e.supplierReorder.supplierAddress)) ctx.addIssue({ code: 'custom', path: ['email', 'supplierReorder'], message: 'the supplier address is outside the recipient rules' })
    }
    if (e.tasks.includes('supplier_followup') && !e.tasks.includes('supplier_reorder')) ctx.addIssue({ code: 'custom', path: ['email', 'tasks'], message: 'following up needs the supplier restock task' })
    if (e.tasks.includes('supplier_followup') && !e.read.enabled) ctx.addIssue({ code: 'custom', path: ['email', 'read'], message: 'following up only when there is no reply needs permission to notice replies' })
    if (e.read.enabled && !e.tasks.includes('supplier_reorder')) ctx.addIssue({ code: 'custom', path: ['email', 'read'], message: 'mailbox reading is only for tracking supplier replies; no configured task needs it' })
    if (e.permission === 'send_autonomous') {
      if (!e.validUntil) ctx.addIssue({ code: 'custom', path: ['email', 'validUntil'], message: 'sending without asking needs an end date' })
      else if (new Date(e.validUntil).getTime() - Date.now() > MAX_AUTONOMY_MS) ctx.addIssue({ code: 'custom', path: ['email', 'validUntil'], message: 'an authorization to send without asking lasts at most one year' })
    }
  }
  for (const t of p.correctionTypes) {
    if (t === 'oversell_policy') continue
    if (!p.rules[t]) ctx.addIssue({ code: 'custom', path: ['rules', t], message: `${CORRECTION_LABEL[t]} needs its rule or reference file` })
  }
  if (p.correctionTypes.includes('publication') && p.rules.publication && !p.rules.publication.sourceId && !p.rules.publication.publishTags.length)
    ctx.addIssue({ code: 'custom', path: ['rules', 'publication'], message: 'publication needs a publication list or tags to publish' })
})

export type AgentPolicy = z.infer<typeof PolicySchema>

export function parsePolicy(raw: unknown): AgentPolicy {
  const p = PolicySchema.parse(raw)
  if (p.correctionTypes.includes('oversell_policy') && !p.rules.oversell_policy) p.rules.oversell_policy = { exemptTags: ['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order'], flagInStockVariants: true }
  return p
}

export function policyHash(p: AgentPolicy): string {
  return createHash('sha256').update(canonicalJson(p)).digest('hex')
}

/** Is a product inside the agent's permitted scope (and not an exception)? Evaluated on fresh records too. */
export function inScope(p: Pick<AgentPolicy, 'productScope' | 'exceptions'>, productId: string, productTags: string[]): boolean {
  const tags = productTags.map(t => t.trim().toLowerCase())
  if (p.exceptions.productIds.includes(productId)) return false
  if (p.exceptions.tags.some(t => tags.includes(t))) return false
  if (p.productScope.mode === 'all') return true
  if (p.productScope.mode === 'products') return p.productScope.productIds.includes(productId)
  return p.productScope.tags.some(t => tags.includes(t))
}

/**
 * Which fields a policy allows the agent to write on a platform, from that platform's declared
 * capabilities. A drafts-only agent writes nothing; a price agent writes only the price fields it chose.
 */
export function writableFields(p: AgentPolicy, platform: Platform = 'shopify'): string[] {
  if (p.approvalMode === 'draft') return []
  const out = new Set<string>()
  for (const t of p.correctionTypes) {
    const cap = correctionCapability(platform, t)
    if (!cap) continue
    for (const field of Object.values(cap.actions)) {
      if (t === 'price' && !(p.rules.price?.fields ?? ['price']).includes(field as 'price' | 'compareAtPrice')) continue
      out.add(field)
    }
  }
  return [...out]
}

const sub = <T,>(a: T[], b: T[]) => a.every(x => b.includes(x))

/**
 * Does `next` grant anything `prev` did not? Expansions need a fresh grant; narrowing and neutral
 * edits (schedule, lower limits, more exceptions, fewer types) can take effect without one.
 */
export function expansionReasons(prev: AgentPolicy, next: AgentPolicy): string[] {
  const r: string[] = []
  if (prev.connectionId !== next.connectionId) r.push('different store')
  if (!sub(next.correctionTypes, prev.correctionTypes)) r.push('new correction types')
  if (!sub(writableFields(next), writableFields(prev))) r.push('new writable fields')
  const ps = prev.productScope, ns = next.productScope
  if (ps.mode === 'all') { /* anything is within "all products" */ }
  else if (ns.mode === 'all') r.push('product scope widened to all products')
  else if (ns.mode !== ps.mode) r.push('product scope changed')
  else if (ns.mode === 'products' && !sub(ns.productIds, ps.productIds)) r.push('products added to scope')
  else if (ns.mode === 'tags' && !sub(ns.tags, ps.tags)) r.push('tags added to scope')
  if (!sub(prev.exceptions.productIds, next.exceptions.productIds) || !sub(prev.exceptions.tags, next.exceptions.tags)) r.push('exceptions removed')
  const rank = (m: ApprovalMode) => APPROVAL_MODES.indexOf(m)
  if (rank(next.approvalMode) > rank(prev.approvalMode)) r.push(next.approvalMode === 'autonomous' ? 'switched to autonomous mode' : 'may now make changes you approve (was drafts only)')
  const until = (x: string | null) => (x ? new Date(x).getTime() : Infinity)
  if (next.approvalMode === 'autonomous' && prev.approvalMode === 'autonomous' && until(next.validUntil) > until(prev.validUntil)) r.push('store authorization extended')
  if (!sub(next.watch, prev.watch)) r.push('new checks to run')
  if (next.limits.maxChangesPerRun > prev.limits.maxChangesPerRun || next.limits.maxChangesPerDay > prev.limits.maxChangesPerDay) r.push('higher limits')
  const pp = prev.rules.price, np = next.rules.price
  if (np && pp) {
    if (np.sourceId !== pp.sourceId) r.push('different price list')
    const lim = (x: number | null) => (x === null ? Infinity : x)
    if (lim(np.maxChangePct) > lim(pp.maxChangePct)) r.push('larger price changes allowed')
    if (pp.skipVariantsOnSale && !np.skipVariantsOnSale) r.push('sale prices no longer protected')
  }
  const pk = prev.rules.sku, nk = next.rules.sku
  if (nk && pk) { if (nk.sourceId !== pk.sourceId) r.push('different SKU mapping'); if (nk.allowOverwrite && !pk.allowOverwrite) r.push('may now overwrite existing SKUs') }
  const pb = prev.rules.publication, nb = next.rules.publication
  if (nb && pb) {
    if (nb.publicationId !== pb.publicationId) r.push('different sales channel')
    if (nb.sourceId !== pb.sourceId) r.push('different publication list')
    if (!sub(nb.publishTags, pb.publishTags)) r.push('new publish tags')
    if (nb.allowUnpublish && !pb.allowUnpublish) r.push('may now unpublish')
  }
  const po = prev.rules.oversell_policy, no = next.rules.oversell_policy
  if (no && po && !sub(po.exemptTags, no.exemptTags)) r.push('pre-order/backorder exemptions removed')
  r.push(...emailExpansion(prev.email, next.email))
  r.push(...competitorExpansion(prev.competitors, next.competitors))
  return [...new Set(r)]
}

function competitorExpansion(pc: CompetitorPolicy | undefined, nc: CompetitorPolicy | undefined): string[] {
  if (!nc) return []
  if (!pc) return ['competitor monitoring added']
  const r: string[] = []
  const hosts = (c: CompetitorPolicy) => c.stores.map(st => storeKey(new URL(st.url).hostname))
  if (!sub(hosts(nc), hosts(pc))) r.push('new competitor stores to watch')
  // an empty keyword list means every product, so dropping all keywords or adding one widens what is read
  if (pc.keywords.length && (!nc.keywords.length || !sub(nc.keywords, pc.keywords))) r.push('more competitor products in scope')
  if (nc.compareOwnCatalog && !pc.compareOwnCatalog) r.push('now compares with your catalog')
  return r
}

function emailExpansion(pe: EmailPolicy | undefined, ne: EmailPolicy | undefined): string[] {
  if (!ne) return []
  if (!pe) return ['email access added']
  const r: string[] = []
  if (ne.accountId !== pe.accountId) r.push('different email account')
  if (permissionRank(ne.permission) > permissionRank(pe.permission)) r.push(ne.permission === 'send_autonomous' ? 'may now send email without asking' : 'may now send approved email')
  if (!sub(ne.tasks, pe.tasks)) r.push('new email tasks')
  if (ne.purpose !== pe.purpose) r.push('different email purpose')
  if (!sub(ne.recipients.addresses, pe.recipients.addresses) || !sub(ne.recipients.domains, pe.recipients.domains)) r.push('more email recipients allowed')
  if (ne.maxRecipientsPerMessage > pe.maxRecipientsPerMessage || ne.limits.perRun > pe.limits.perRun || ne.limits.perDay > pe.limits.perDay) r.push('higher sending limits')
  const until = (x: string | null) => (x ? new Date(x).getTime() : Infinity)
  if (ne.permission === 'send_autonomous' && (pe.permission !== 'send_autonomous' || until(ne.validUntil) > until(pe.validUntil))) r.push('email authorization extended')
  if (ne.allowAttachments && !pe.allowAttachments) r.push('may now attach files')
  if (ne.read.enabled && !pe.read.enabled) r.push('may now read replies in the mailbox')
  const ps = pe.supplierReorder, ns = ne.supplierReorder
  if (ns && (!ps || ns.supplierAddress !== ps.supplierAddress)) r.push('different supplier address')
  if (ns && ps && (ns.thresholdAvailable > ps.thresholdAvailable || ns.cooldownDays < ps.cooldownDays || ns.followupDays < ps.followupDays)) r.push('supplier emails sent more often')
  return r
}

export type SummaryContext = { watchLabels?: Record<string, string>; storeName: string; sourceNames: Record<string, string>; productCount?: number; emailAccount?: { address: string; provider: string } | null }

/** Plain sentences describing exactly what granting this policy allows and does not allow. */
export function summarizePolicy(p: AgentPolicy, ctx: SummaryContext): { grants: string[]; limits: string[]; never: string[] } {
  const scope = p.productScope.mode === 'all' ? 'every product in the store'
    : p.productScope.mode === 'products' ? `${p.productScope.productIds.length} selected product${p.productScope.productIds.length === 1 ? '' : 's'}`
    : `products tagged ${p.productScope.tags.map(t => `"${t}"`).join(' or ')}`
  const except = [...p.exceptions.tags.map(t => `tagged "${t}"`), ...(p.exceptions.productIds.length ? [`${p.exceptions.productIds.length} excluded product(s)`] : [])]
  // a competitor-only agent reads its own store at most for titles; every other agent works on the store
  const storeTools = !p.competitors || p.correctionTypes.length > 0 || p.watch.length > 0 || Boolean(p.email?.tasks.some(t => t === 'supplier_reorder'))
  const grants: string[] = storeTools ? [`Works on ${ctx.storeName}, on ${scope}${except.length ? `, except products ${except.join(' and ')}` : ''}.`]
    : p.competitors?.compareOwnCatalog ? [`Reads the product titles of ${ctx.storeName} only to compare them with what competitors show. It never changes your store.`]
    : [`Does not read or change ${ctx.storeName}.`]
  const how = p.approvalMode === 'autonomous' ? `may change without asking until ${p.validUntil ? p.validUntil.slice(0, 10) : '(no end date)'}`
    : p.approvalMode === 'review' ? 'will propose; you approve each exact change before it is made'
    : 'drafts only: will show you the exact change it would make, and never makes it'
  for (const t of p.correctionTypes) {
    if (t === 'oversell_policy') {
      const ex = p.rules.oversell_policy?.exemptTags ?? []
      grants.push(`Overselling: ${how}: "Continue selling when out of stock" from On to Off on tracked, active variants. Skips products tagged ${ex.map(x => `"${x}"`).join(', ') || '(none)'}, products sold through selling plans, gift cards and untracked inventory.`)
    }
    if (t === 'publication' && p.rules.publication) {
      const b = p.rules.publication
      const src = b.sourceId ? `the publication list "${ctx.sourceNames[b.sourceId] ?? 'uploaded file'}"` : `the rule "publish products tagged ${b.publishTags.map(x => `"${x}"`).join(' or ')}"`
      grants.push(`Publication: ${how}: publish${b.allowUnpublish ? ' or unpublish' : ''} active products on ${b.publicationName} so they match ${src}. Drafts and archived products are reported, never changed.`)
    }
    if (t === 'price' && p.rules.price) {
      const pr = p.rules.price
      grants.push(`Prices: ${how}: set ${pr.fields.map(f => (f === 'price' ? 'price' : 'compare-at price')).join(' and ')} in the store currency to match the price list "${ctx.sourceNames[pr.sourceId] ?? 'uploaded file'}".${pr.skipVariantsOnSale ? ' Variants on sale (compare-at above price) are left alone.' : ''}`)
    }
    if (t === 'sku' && p.rules.sku) {
      grants.push(`SKUs: ${how}: ${p.rules.sku.allowOverwrite ? 'fill missing SKUs and correct SKUs that differ from' : 'fill missing SKUs from'} the mapping "${ctx.sourceNames[p.rules.sku.sourceId] ?? 'uploaded file'}" when the match is unambiguous.`)
    }
  }
  for (const w of p.watch) grants.push(`Checks (read only): ${ctx.watchLabels?.[w] ?? w}. Problems are reported for a person; nothing is changed.`)
  if (p.competitors) {
    const c = p.competitors
    const hosts = c.stores.map(st => new URL(st.url).hostname)
    grants.push(`Competitor monitoring (read only): reads the public pages of ${hosts.join(', ')}, the same pages any visitor can see. ${c.keywords.length ? `Only products whose name, type or tags mention ${c.keywords.map(k => `"${k}"`).join(', ')}.` : 'Every product they list.'}`)
    grants.push(`Records, with the page address and time seen: products, prices, advertised discounts, availability, and the store's own public best-seller and featured collections. The first check is the starting point; later checks report changes against it.`)
    grants.push(`Alerts in Deploi on: ${c.alerts.map(a => COMPETITOR_ALERT_LABEL[a].toLowerCase()).join('; ')}.${c.alerts.includes('price_changes') ? ` Price changes under ${c.minPriceChangePct}% are not reported.` : ''}`)
  }
  const limits: string[] = []
  if (p.approvalMode === 'autonomous') limits.push(`At most ${p.limits.maxChangesPerRun} changes per run and ${p.limits.maxChangesPerDay} per day without asking; anything beyond waits for your approval.`)
  if (p.correctionTypes.includes('price') && p.rules.price) limits.push(p.rules.price.maxChangePct === null ? 'No limit on the size of a price change.' : `Price changes larger than ${p.rules.price.maxChangePct}% always wait for your approval.`)
  limits.push(p.schedule.kind === 'manual' ? 'Runs only when you press Run now.' : p.schedule.kind === 'interval' ? `Runs every ${p.schedule.everyHours} hour${p.schedule.everyHours === 1 ? '' : 's'}.` : `Runs daily at ${String(p.schedule.hour).padStart(2, '0')}:${String(p.schedule.minute).padStart(2, '0')} (${p.schedule.timezone}).`)
  if (p.correctionTypes.length) limits.push('Re-reads every record just before writing and stops if it changed; confirms every change with a fresh read.')
  if (p.competitors) limits.push("Follows each store's robots.txt and skips any store that does not allow it. At most one request per second to a store, and a fixed number of pages per check.")
  const never = storeTools ? [
    ...(p.approvalMode === 'draft' && p.correctionTypes.length ? ['Never changes anything in your store: drafts only. Making changes needs a wider permission and a new grant.'] : []),
    'Never changes stock quantities.',
    'Never changes product status (draft, active, archived) or deletes anything.',
    'Never invents prices or SKUs: values come only from your files or rules.',
    'Never touches products or fields outside this list.',
  ] : ['Never changes anything in your store: no products, prices, stock, publication or settings.']
  if (p.competitors) never.push(
    'Never logs in to, buys from, or contacts a competitor store, and never gets around a block or a login.',
    "Never claims to know a competitor's sales, revenue, units sold, conversion rate or exact sales ranking: none of these are public, and Deploi does not estimate them.",
  )
  if (p.email) {
    const e = p.email
    const sender = ctx.emailAccount ? `${ctx.emailAccount.address}` : 'the chosen email account'
    const who = [...e.recipients.addresses, ...e.recipients.domains.map(d => `anyone @${d}`)].join(', ')
    const what = e.tasks.map(t => EMAIL_TASK_LABEL[t].toLowerCase()).join('; ')
    const level = e.permission === 'draft' ? 'may write drafts for you to review; it never sends'
      : e.permission === 'send_approved' ? 'may send a message only after you approve that exact message'
      : `may send without asking until ${e.validUntil ? new Date(e.validUntil).toISOString().slice(0, 10) : '(no end date)'}`
    grants.push(`Email from ${sender}: ${level}. Purpose: "${e.purpose}". Tasks: ${what}.`)
    grants.push(`Email recipients allowed: ${who}.${e.notify.length ? ` Summaries and alerts go to ${e.notify.join(', ')}.` : ''}${e.supplierReorder ? ` Supplier requests go to ${e.supplierReorder.supplierAddress} for variants with ${e.supplierReorder.thresholdAvailable} or fewer available, at most once every ${e.supplierReorder.cooldownDays} days per variant.` : ''}${e.supplierReorder && e.tasks.includes('supplier_followup') ? ` If the supplier has not replied after ${e.supplierReorder.followupDays} days, one follow-up in the same thread.` : ''}`)
    if (e.read.enabled) grants.push('Mailbox reading: only to notice replies to messages this agent sent. Reply content is never acted on.')
    if (e.permission !== 'draft') limits.push(`Email: at most ${e.limits.perRun} messages per run, ${e.limits.perDay} per day and ${e.maxRecipientsPerMessage} recipients per message${e.allowAttachments ? '' : ', no attachments'}. Anything outside these limits waits for your approval.`)
    never.push(ctx.emailAccount?.provider === 'deploi' ? 'Never sends email to anyone outside the allowed recipients, even with your approval: adding a recipient needs a new grant.' : 'Never sends email to anyone outside the allowed recipients without your approval of that exact message.')
    never.push('Never lets an incoming email or attachment change what it is allowed to do.')
    if (!e.read.enabled) never.push('Never reads your mailbox.')
  } else never.push('Never sends email.')
  return { grants, limits, never }
}
