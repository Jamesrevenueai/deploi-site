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

export const CORRECTION_TYPES = ['oversell_policy', 'publication', 'price', 'sku'] as const
export type CorrectionType = typeof CORRECTION_TYPES[number]

export const CORRECTION_LABEL: Record<CorrectionType, string> = {
  oversell_policy: 'Overselling configuration',
  publication: 'Product publication',
  price: 'Prices',
  sku: 'SKUs',
}

/** check key and action keys per correction type (the engine maps proposals back to the policy through these) */
export const CORRECTION_CHECK: Record<CorrectionType, string> = {
  oversell_policy: 'shopify.oversell_policy',
  publication: 'shopify.publication',
  price: 'shopify.price',
  sku: 'shopify.sku',
}
export const ACTION_TYPE: Record<string, CorrectionType> = {
  'shopify.variant.set_inventory_policy': 'oversell_policy',
  'shopify.product.publish': 'publication',
  'shopify.product.unpublish': 'publication',
  'shopify.variant.set_price': 'price',
  'shopify.variant.set_compare_at_price': 'price',
  'shopify.variant.set_sku': 'sku',
}
/** the platform field each action writes; connectors refuse any other field */
export const ACTION_FIELD: Record<string, string> = {
  'shopify.variant.set_inventory_policy': 'inventoryPolicy',
  'shopify.product.publish': 'published',
  'shopify.product.unpublish': 'published',
  'shopify.variant.set_price': 'price',
  'shopify.variant.set_compare_at_price': 'compareAtPrice',
  'shopify.variant.set_sku': 'sku',
}

const gidProduct = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/)
const tag = z.string().trim().min(1).max(255).transform(t => t.toLowerCase())

export const PolicySchema = z.object({
  connectionId: z.string().uuid(),
  correctionTypes: z.array(z.enum(CORRECTION_TYPES)).min(1, 'choose at least one correction type').max(4),
  productScope: z.object({
    mode: z.enum(['all', 'products', 'tags']),
    productIds: z.array(gidProduct).max(5000).default([]),
    tags: z.array(tag).max(50).default([]),
  }).superRefine((s, ctx) => {
    if (s.mode === 'products' && !s.productIds.length) ctx.addIssue({ code: 'custom', message: 'choose at least one product' })
    if (s.mode === 'tags' && !s.tags.length) ctx.addIssue({ code: 'custom', message: 'choose at least one tag' })
  }),
  exceptions: z.object({ productIds: z.array(gidProduct).max(5000).default([]), tags: z.array(tag).max(50).default([]) }).default({ productIds: [], tags: [] }),
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
  approvalMode: z.enum(['review', 'autonomous']),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('interval'), everyHours: z.number().int().min(1).max(168) }),
    z.object({ kind: z.literal('daily'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), timezone: z.string().min(1).max(64) }),
  ]).default({ kind: 'manual' }),
}).superRefine((p, ctx) => {
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

/** Which fields a policy allows the agent to write. */
export function writableFields(p: AgentPolicy): string[] {
  const out: string[] = []
  if (p.correctionTypes.includes('oversell_policy')) out.push('inventoryPolicy')
  if (p.correctionTypes.includes('publication')) out.push('published')
  if (p.correctionTypes.includes('price')) out.push(...(p.rules.price?.fields ?? ['price']))
  if (p.correctionTypes.includes('sku')) out.push('sku')
  return out
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
  if (prev.approvalMode === 'review' && next.approvalMode === 'autonomous') r.push('switched to autonomous mode')
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
  return [...new Set(r)]
}

export type SummaryContext = { storeName: string; sourceNames: Record<string, string>; productCount?: number }

/** Plain sentences describing exactly what granting this policy allows and does not allow. */
export function summarizePolicy(p: AgentPolicy, ctx: SummaryContext): { grants: string[]; limits: string[]; never: string[] } {
  const scope = p.productScope.mode === 'all' ? 'every product in the store'
    : p.productScope.mode === 'products' ? `${p.productScope.productIds.length} selected product${p.productScope.productIds.length === 1 ? '' : 's'}`
    : `products tagged ${p.productScope.tags.map(t => `"${t}"`).join(' or ')}`
  const except = [...p.exceptions.tags.map(t => `tagged "${t}"`), ...(p.exceptions.productIds.length ? [`${p.exceptions.productIds.length} excluded product(s)`] : [])]
  const grants: string[] = [`Works on ${ctx.storeName}, on ${scope}${except.length ? `, except products ${except.join(' and ')}` : ''}.`]
  const how = p.approvalMode === 'autonomous' ? 'may change without asking' : 'will propose; you approve each exact change before it is made'
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
  const limits: string[] = []
  if (p.approvalMode === 'autonomous') limits.push(`At most ${p.limits.maxChangesPerRun} changes per run and ${p.limits.maxChangesPerDay} per day without asking; anything beyond waits for your approval.`)
  if (p.correctionTypes.includes('price') && p.rules.price) limits.push(p.rules.price.maxChangePct === null ? 'No limit on the size of a price change.' : `Price changes larger than ${p.rules.price.maxChangePct}% always wait for your approval.`)
  limits.push(p.schedule.kind === 'manual' ? 'Runs only when you press Run now.' : p.schedule.kind === 'interval' ? `Runs every ${p.schedule.everyHours} hour${p.schedule.everyHours === 1 ? '' : 's'}.` : `Runs daily at ${String(p.schedule.hour).padStart(2, '0')}:${String(p.schedule.minute).padStart(2, '0')} (${p.schedule.timezone}).`)
  limits.push('Re-reads every record just before writing and stops if it changed; confirms every change with a fresh read.')
  const never = [
    'Never changes stock quantities.',
    'Never changes product status (draft, active, archived) or deletes anything.',
    'Never invents prices or SKUs: values come only from your files or rules.',
    'Never touches products or fields outside this list.',
  ]
  return { grants, limits, never }
}
