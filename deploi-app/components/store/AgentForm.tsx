'use client'
/**
 * The structured task and permission form an agent is authorized from. Used to review a fresh draft
 * (create) and to edit an existing agent. Nothing here grants anything: submitting produces a policy
 * version that the merchant still has to grant after reading its summary.
 */
import { useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input, Select, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { Panel, useStore } from './bits'
import {
  AGENT_CORRECTION_HELP, AGENT_CORRECTION_LABEL, AGENT_CORRECTION_TYPES, AGENT_EMAIL_PERMISSIONS, AGENT_EMAIL_PERMISSION_HELP, AGENT_EMAIL_PERMISSION_LABEL,
  AGENT_EMAIL_TASKS, AGENT_EMAIL_TASK_HELP, AGENT_EMAIL_TASK_LABEL, COMPETITOR_ALERTS, COMPETITOR_ALERT_WORDS, emailAccountWords, referenceKindLabel, type AgentCorrectionType, type AgentEmailPermission, type AgentEmailTask, type CompetitorAlertKey,
} from './format'
import { MAX_COMPETITOR_STORES, normalizeStoreUrl, storeKey } from '@/lib/competitors/url'
import type {
  AgentPolicy, Connection, EmailAccountsResponse, EmailAccountView, PublicationsResponse, ReferenceKindName, ReferenceSourceView, ReferencesResponse, TaskDraft, UploadReferenceResponse,
} from './types'

// ---------------------------------------------------------------- form state

export type AgentFormState = {
  connectionId: string
  types: Record<AgentCorrectionType, boolean>
  scopeMode: '' | 'all' | 'products' | 'tags'
  scopeProductIds: string
  scopeTags: string
  exceptTags: string
  exceptProductIds: string
  oversellExemptTags: string
  flagInStock: boolean
  pubId: string
  pubName: string
  pubSource: 'file' | 'tags'
  pubSourceId: string
  pubTags: string
  allowUnpublish: boolean
  priceSourceId: string
  priceField: boolean
  compareAtField: boolean
  maxChangePct: string
  noPriceLimit: boolean
  skipSale: boolean
  skuSourceId: string
  skuOverwrite: boolean
  scheduleKind: 'manual' | 'interval' | 'daily'
  everyHours: string
  dailyTime: string
  maxPerRun: string
  maxPerDay: string
  approvalMode: '' | 'draft' | 'review' | 'autonomous'
  /** what the plain-English task asked for; shown as a suggestion, never pre-selected (new agents start at drafts only) */
  suggestedMode: '' | 'review' | 'autonomous'
  /** YYYY-MM-DD, last day of an autonomous store authorization (required, at most one year) */
  storeValidUntil: string
  /** read-only check: report oversold variants for a person */
  watchOversold: boolean
  // email (optional; an email-only agent needs no correction types)
  emailOn: boolean
  emailAccountId: string
  emailPermission: '' | AgentEmailPermission
  suggestedEmailPermission: '' | AgentEmailPermission
  emailPurpose: string
  emailTasks: Record<AgentEmailTask, boolean>
  emailAddresses: string
  emailDomains: string
  /** addresses found in the plain-English task: placed in the allowed list but not accepted until confirmed */
  emailSuggested: string[]
  emailSuggestedConfirmed: boolean
  emailNotify: string
  supplierAddress: string
  supplierThreshold: string
  supplierCooldown: string
  supplierFollowup: string
  emailPerRun: string
  emailPerDay: string
  emailMaxRecipients: string
  /** YYYY-MM-DD, last day of the authorization */
  emailValidUntil: string
  emailAttachments: boolean
  emailRead: boolean
  // competitor monitoring (public pages of other stores, read only)
  competitorOn: boolean
  competitorStores: string
  competitorKeywords: string
  competitorAlerts: Record<CompetitorAlertKey, boolean>
  competitorMinPct: string
  competitorCompare: boolean
}

import { OVERSOLD_WATCH } from '@/lib/agents/watch'
export { OVERSOLD_WATCH }
const DEFAULT_EXEMPT = ['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order']
const noTypes = (): Record<AgentCorrectionType, boolean> => ({ oversell_policy: false, publication: false, price: false, sku: false })
const pad2 = (n: number) => String(n).padStart(2, '0')
const list = (s: string) => [...new Set(s.split(/[,\n]/).map(x => x.trim()).filter(Boolean))]
const tagList = (s: string) => list(s).map(t => t.toLowerCase())

/** 1234 or gid://shopify/Product/1234 -> gid; anything else is reported */
function productIds(s: string): { ids: string[]; bad: string[] } {
  const ids: string[] = [], bad: string[] = []
  for (const x of list(s)) {
    if (/^\d+$/.test(x)) ids.push(`gid://shopify/Product/${x}`)
    else if (/^gid:\/\/shopify\/Product\/\d+$/.test(x)) ids.push(x)
    else bad.push(x)
  }
  return { ids: [...new Set(ids)], bad }
}
const showIds = (ids: string[]) => ids.map(id => id.replace(/^gid:\/\/shopify\/Product\//, '')).join(', ')
const allAlerts = (): Record<CompetitorAlertKey, boolean> => Object.fromEntries(COMPETITOR_ALERTS.map(a => [a, true])) as Record<CompetitorAlertKey, boolean>
const noEmailTasks = (): Record<AgentEmailTask, boolean> => ({ run_report: false, needs_person_alert: false, supplier_reorder: false, supplier_followup: false })

// same formats the server accepts (lib/agents/policy.ts)
const EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
export const isEmailAddress = (a: string) => a.length <= 254 && EMAIL_RE.test(a)
export const isEmailDomain = (d: string) => DOMAIN_RE.test(d)

/** Recipient rules as typed: valid entries, invalid ones, and which notify / supplier addresses fall outside the rules. */
export function emailRules(f: Pick<AgentFormState, 'emailAddresses' | 'emailDomains' | 'emailNotify' | 'supplierAddress' | 'emailTasks'>) {
  const addrIn = list(f.emailAddresses).map(a => a.toLowerCase())
  const domIn = list(f.emailDomains).map(d => d.toLowerCase().replace(/^@/, ''))
  // the notify list only matters for summaries and alerts
  const notifyIn = f.emailTasks.run_report || f.emailTasks.needs_person_alert ? list(f.emailNotify).map(a => a.toLowerCase()) : []
  const addresses = addrIn.filter(isEmailAddress), domains = domIn.filter(isEmailDomain), notify = notifyIn.filter(isEmailAddress)
  const allowed = (a: string) => addresses.includes(a) || domains.includes(a.split('@')[1] ?? '')
  const supplier = f.supplierAddress.trim().toLowerCase()
  const outside = [...notify.filter(a => !allowed(a)), ...(f.emailTasks.supplier_reorder && isEmailAddress(supplier) && !allowed(supplier) ? [supplier] : [])]
  return {
    addresses, domains, notify, supplier,
    badAddresses: addrIn.filter(a => !isEmailAddress(a)), badDomains: domIn.filter(d => !isEmailDomain(d)), badNotify: notifyIn.filter(a => !isEmailAddress(a)),
    outside: [...new Set(outside)],
  }
}

const isoDay = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
/** end of the chosen day, local time */
const endOfDay = (day: string) => new Date(`${day}T23:59:59`)

export function emptyForm(connectionId: string): AgentFormState {
  return {
    connectionId, types: noTypes(), scopeMode: '', scopeProductIds: '', scopeTags: '', exceptTags: '', exceptProductIds: '',
    oversellExemptTags: DEFAULT_EXEMPT.join(', '), flagInStock: true,
    pubId: '', pubName: '', pubSource: 'file', pubSourceId: '', pubTags: '', allowUnpublish: false,
    priceSourceId: '', priceField: true, compareAtField: false, maxChangePct: '20', noPriceLimit: false, skipSale: true,
    skuSourceId: '', skuOverwrite: false,
    scheduleKind: 'manual', everyHours: '6', dailyTime: '06:00', maxPerRun: '25', maxPerDay: '100', approvalMode: 'draft', suggestedMode: '', storeValidUntil: '', watchOversold: false,
    emailOn: false, emailAccountId: '', emailPermission: 'draft', suggestedEmailPermission: '', emailPurpose: '', emailTasks: noEmailTasks(), emailAddresses: '', emailDomains: '',
    emailSuggested: [], emailSuggestedConfirmed: false, emailNotify: '', supplierAddress: '', supplierThreshold: '0', supplierCooldown: '7', supplierFollowup: '3',
    emailPerRun: '10', emailPerDay: '25', emailMaxRecipients: '5', emailValidUntil: '', emailAttachments: false, emailRead: false,
    competitorOn: false, competitorStores: '', competitorKeywords: '', competitorAlerts: allAlerts(), competitorMinPct: '5', competitorCompare: true,
  }
}

/** Prefill from the plain-English draft. Only what the text said is filled in; the rest stays for the merchant to choose. */
export function formFromDraft(d: TaskDraft, connectionId: string): AgentFormState {
  const f = emptyForm(connectionId)
  for (const t of d.correctionTypes) f.types[t] = true
  if (d.productScope.mode) f.scopeMode = d.productScope.mode
  f.scopeTags = d.productScope.tags.join(', ')
  f.exceptTags = d.exceptionTags.join(', ')
  if (d.approvalMode) f.suggestedMode = d.approvalMode
  if (d.schedule?.kind === 'interval') { f.scheduleKind = 'interval'; f.everyHours = String(d.schedule.everyHours) }
  if (d.schedule?.kind === 'daily') { f.scheduleKind = 'daily'; f.dailyTime = `${pad2(d.schedule.hour)}:${pad2(d.schedule.minute)}` }
  if (d.priceFields.length) { f.priceField = d.priceFields.includes('price'); f.compareAtField = d.priceFields.includes('compareAtPrice') }
  if (d.publicationName) f.pubName = d.publicationName
  f.allowUnpublish = d.allowUnpublish
  f.skuOverwrite = d.allowSkuOverwrite
  if (d.email) {
    f.emailOn = true
    for (const t of d.email.tasks) f.emailTasks[t] = true
    if (d.email.permission) f.suggestedEmailPermission = d.email.permission
    // suggestions only: they go into the allowed list, and the merchant must confirm them
    f.emailSuggested = d.email.addresses
    f.emailAddresses = d.email.addresses.join(', ')
  }
  return f
}

/** Prefill from an existing policy version (edit). */
export function formFromPolicy(p: AgentPolicy): AgentFormState {
  const f = emptyForm(p.connectionId)
  for (const t of p.correctionTypes) f.types[t] = true
  f.scopeMode = p.productScope.mode
  f.scopeProductIds = showIds(p.productScope.productIds ?? [])
  f.scopeTags = (p.productScope.tags ?? []).join(', ')
  f.exceptTags = (p.exceptions?.tags ?? []).join(', ')
  f.exceptProductIds = showIds(p.exceptions?.productIds ?? [])
  if (p.rules.oversell_policy) { f.oversellExemptTags = p.rules.oversell_policy.exemptTags.join(', '); f.flagInStock = p.rules.oversell_policy.flagInStockVariants }
  if (p.rules.publication) {
    const b = p.rules.publication
    f.pubId = b.publicationId; f.pubName = b.publicationName; f.pubSource = b.sourceId ? 'file' : 'tags'; f.pubSourceId = b.sourceId ?? ''; f.pubTags = b.publishTags.join(', '); f.allowUnpublish = b.allowUnpublish
  }
  if (p.rules.price) {
    const r = p.rules.price
    f.priceSourceId = r.sourceId; f.priceField = r.fields.includes('price'); f.compareAtField = r.fields.includes('compareAtPrice')
    f.noPriceLimit = r.maxChangePct === null; f.maxChangePct = r.maxChangePct === null ? '20' : String(r.maxChangePct); f.skipSale = r.skipVariantsOnSale
  }
  if (p.rules.sku) { f.skuSourceId = p.rules.sku.sourceId; f.skuOverwrite = p.rules.sku.allowOverwrite }
  f.scheduleKind = p.schedule.kind
  if (p.schedule.kind === 'interval') f.everyHours = String(p.schedule.everyHours)
  if (p.schedule.kind === 'daily') f.dailyTime = `${pad2(p.schedule.hour)}:${pad2(p.schedule.minute)}`
  f.maxPerRun = String(p.limits.maxChangesPerRun)
  f.maxPerDay = String(p.limits.maxChangesPerDay)
  f.approvalMode = p.approvalMode
  f.storeValidUntil = p.validUntil ? isoDay(p.validUntil) : ''
  f.watchOversold = (p.watch ?? []).includes(OVERSOLD_WATCH)
  if (p.email) {
    const e = p.email
    f.emailOn = true
    f.emailAccountId = e.accountId
    f.emailPermission = e.permission
    f.emailPurpose = e.purpose
    for (const t of e.tasks) f.emailTasks[t] = true
    f.emailAddresses = (e.recipients?.addresses ?? []).join(', ')
    f.emailDomains = (e.recipients?.domains ?? []).join(', ')
    f.emailNotify = (e.notify ?? []).join(', ')
    if (e.supplierReorder) { f.supplierAddress = e.supplierReorder.supplierAddress; f.supplierThreshold = String(e.supplierReorder.thresholdAvailable); f.supplierCooldown = String(e.supplierReorder.cooldownDays); f.supplierFollowup = String(e.supplierReorder.followupDays ?? 3) }
    f.emailPerRun = String(e.limits?.perRun ?? 10)
    f.emailPerDay = String(e.limits?.perDay ?? 25)
    f.emailMaxRecipients = String(e.maxRecipientsPerMessage ?? 5)
    f.emailValidUntil = e.validUntil ? isoDay(e.validUntil) : ''
    f.emailAttachments = Boolean(e.allowAttachments)
    f.emailRead = Boolean(e.read?.enabled)
  }
  if (p.competitors) {
    const c = p.competitors
    f.competitorOn = true
    f.competitorStores = c.stores.map(st => st.url.replace(/^https:\/\//, '')).join('\n')
    f.competitorKeywords = c.keywords.join(', ')
    f.competitorAlerts = Object.fromEntries(COMPETITOR_ALERTS.map(a => [a, c.alerts.includes(a)])) as Record<CompetitorAlertKey, boolean>
    f.competitorMinPct = String(c.minPriceChangePct)
    f.competitorCompare = c.compareOwnCatalog
  }
  return f
}

/** Products only matter to an email-only agent when it asks a supplier about low stock. */
export const needsProducts = (f: AgentFormState) => AGENT_CORRECTION_TYPES.some(t => f.types[t]) || (!f.emailOn && !f.competitorOn) || (f.emailOn && f.emailTasks.supplier_reorder)
/** Store-change approval only matters when the agent corrects something. */
export const needsApprovalMode = (f: AgentFormState) => AGENT_CORRECTION_TYPES.some(t => f.types[t]) || (!f.emailOn && !f.watchOversold && !f.competitorOn)

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)

/**
 * Form -> policy, with every problem in words. A policy is only produced when nothing is missing:
 * a vague task ("fix my store") leaves correction types, product scope and approval mode unchosen,
 * and the form refuses to continue until the merchant picks them.
 */
export function policyFromForm(f: AgentFormState, timezone: string): { policy: AgentPolicy | null; problems: string[] } {
  const problems: string[] = []
  const types = AGENT_CORRECTION_TYPES.filter(t => f.types[t])
  if (!f.connectionId) problems.push('Choose the store.')
  if (!types.length && !f.emailOn && !f.watchOversold && !f.competitorOn) problems.push('Choose at least one correction type or check, turn on email, or add competitor stores.')
  const products = needsProducts(f), approval = needsApprovalMode(f)
  if (products && !f.scopeMode) problems.push('Choose which products the agent may work on.')
  const scopeIds = productIds(f.scopeProductIds), exceptIds = productIds(f.exceptProductIds)
  if (f.scopeMode === 'products' && !scopeIds.ids.length) problems.push('List at least one product ID for the product scope.')
  if (f.scopeMode === 'products' && scopeIds.bad.length) problems.push(`These are not Shopify product IDs: ${scopeIds.bad.join(', ')}.`)
  if (f.scopeMode === 'tags' && !tagList(f.scopeTags).length) problems.push('List at least one tag for the product scope.')
  if (exceptIds.bad.length) problems.push(`These exception entries are not Shopify product IDs: ${exceptIds.bad.join(', ')}.`)
  if (f.types.publication) {
    if (!f.pubId) problems.push('Product publication: choose the sales channel.')
    if (f.pubSource === 'file' && !f.pubSourceId) problems.push('Product publication: choose or upload a publication list.')
    if (f.pubSource === 'tags' && !tagList(f.pubTags).length) problems.push('Product publication: list the tags whose products should be published.')
  }
  if (f.types.price) {
    if (!f.priceSourceId) problems.push('Prices: choose or upload a price list.')
    if (!f.priceField && !f.compareAtField) problems.push('Prices: choose at least one field (price or compare-at price).')
    const pct = Number(f.maxChangePct)
    if (!f.noPriceLimit && (!f.maxChangePct.trim() || !Number.isFinite(pct) || pct < 0 || pct > 1000)) problems.push('Prices: the largest change must be a number from 0 to 1000 (%).')
  }
  if (f.types.sku && !f.skuSourceId) problems.push('SKUs: choose or upload a SKU mapping.')
  const everyHours = int(f.everyHours)
  if (f.scheduleKind === 'interval' && !(everyHours >= 1 && everyHours <= 168)) problems.push('Schedule: every 1 to 168 hours.')
  const tm = /^(\d{2}):(\d{2})$/.exec(f.dailyTime)
  if (f.scheduleKind === 'daily' && (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59)) problems.push('Schedule: choose a time of day.')
  const perRun = int(f.maxPerRun), perDay = int(f.maxPerDay)
  if (!(perRun >= 1 && perRun <= 500)) problems.push('Limits: changes per run must be 1 to 500.')
  if (!(perDay >= 1 && perDay <= 5000)) problems.push('Limits: changes per day must be 1 to 5000.')
  if (approval && !f.approvalMode) problems.push('Choose how changes are approved: drafts only, review each change, or act within limits.')
  let storeValidUntil: string | null = null
  if (approval && f.approvalMode === 'autonomous' && types.length) {
    const end = f.storeValidUntil ? endOfDay(f.storeValidUntil) : null
    if (!end) problems.push('Acting without asking needs an end date (at most one year from today).')
    else if (Number.isNaN(end.getTime())) problems.push('The end date is not a date.')
    else if (end.getTime() <= Date.now()) problems.push('The end date must be in the future.')
    else if (end.getTime() - Date.now() > 365 * 864e5) problems.push('The end date can be at most one year from today.')
    else storeValidUntil = end.toISOString()
  }
  const email = f.emailOn ? emailFromForm(f, problems) : undefined
  const competitors = f.competitorOn ? competitorsFromForm(f, problems) : undefined
  if (problems.length) return { policy: null, problems }

  const rules: AgentPolicy['rules'] = {}
  if (f.types.oversell_policy) rules.oversell_policy = { exemptTags: tagList(f.oversellExemptTags), flagInStockVariants: f.flagInStock }
  if (f.types.publication) rules.publication = { publicationId: f.pubId, publicationName: f.pubName || 'Sales channel', sourceId: f.pubSource === 'file' ? f.pubSourceId : null, publishTags: f.pubSource === 'tags' ? tagList(f.pubTags) : [], allowUnpublish: f.allowUnpublish }
  if (f.types.price) rules.price = { sourceId: f.priceSourceId, fields: [...(f.priceField ? ['price' as const] : []), ...(f.compareAtField ? ['compareAtPrice' as const] : [])], maxChangePct: f.noPriceLimit ? null : Number(f.maxChangePct), skipVariantsOnSale: f.skipSale }
  if (f.types.sku) rules.sku = { sourceId: f.skuSourceId, allowOverwrite: f.skuOverwrite }
  const policy: AgentPolicy = {
    connectionId: f.connectionId,
    correctionTypes: types,
    // an email-only agent without supplier requests reads no products for corrections; its scope is recorded as all products
    productScope: products ? { mode: f.scopeMode as 'all' | 'products' | 'tags', productIds: f.scopeMode === 'products' ? scopeIds.ids : [], tags: f.scopeMode === 'tags' ? tagList(f.scopeTags) : [] } : { mode: 'all', productIds: [], tags: [] },
    exceptions: { productIds: exceptIds.ids, tags: tagList(f.exceptTags) },
    rules,
    limits: { maxChangesPerRun: perRun, maxChangesPerDay: perDay },
    approvalMode: approval ? f.approvalMode as 'draft' | 'review' | 'autonomous' : 'draft',
    validUntil: storeValidUntil,
    watch: f.watchOversold ? [OVERSOLD_WATCH] : [],
    schedule: f.scheduleKind === 'manual' ? { kind: 'manual' } : f.scheduleKind === 'interval' ? { kind: 'interval', everyHours } : { kind: 'daily', hour: Number(tm![1]), minute: Number(tm![2]), timezone },
    ...(email ? { email } : {}),
    ...(competitors ? { competitors } : {}),
  }
  return { policy, problems: [] }
}

/** The competitor part of the policy, or problems in words. Addresses are normalized the same way the server does. */
function competitorsFromForm(f: AgentFormState, problems: string[]): NonNullable<AgentPolicy['competitors']> | undefined {
  const before = problems.length
  const stores: { url: string }[] = []
  const seen = new Set<string>()
  for (const raw of list(f.competitorStores)) {
    const n = normalizeStoreUrl(raw)
    if (!n.ok) { problems.push(`Competitor stores: ${raw}: ${n.reason}.`); continue }
    if (seen.has(storeKey(n.host))) { problems.push(`Competitor stores: ${n.host} is listed twice.`); continue }
    seen.add(storeKey(n.host)); stores.push({ url: n.url })
  }
  if (!stores.length && problems.length === before) problems.push('Competitor stores: add at least one store address.')
  if (stores.length > MAX_COMPETITOR_STORES) problems.push(`Competitor stores: at most ${MAX_COMPETITOR_STORES}.`)
  const alerts = COMPETITOR_ALERTS.filter(a => f.competitorAlerts[a])
  if (!alerts.length) problems.push('Competitor stores: choose at least one kind of alert.')
  const pct = Number(f.competitorMinPct)
  if (!(f.competitorMinPct.trim() && pct >= 0 && pct <= 100)) problems.push('Competitor stores: the smallest price change must be a number from 0 to 100 (%).')
  const keywords = tagList(f.competitorKeywords).filter(k => k.length >= 2)
  if (problems.length > before) return undefined
  return { stores, keywords, alerts, minPriceChangePct: pct, compareOwnCatalog: f.competitorCompare }
}

/** The email part of the policy, or problems in words. */
function emailFromForm(f: AgentFormState, problems: string[]): NonNullable<AgentPolicy['email']> | undefined {
  const before = problems.length
  const tasks = AGENT_EMAIL_TASKS.filter(t => f.emailTasks[t])
  const r = emailRules(f)
  if (!f.emailAccountId) problems.push('Email: choose the account it sends from.')
  if (!f.emailPermission) problems.push('Email: choose whether it only drafts, sends messages you approve, or sends without asking.')
  const purpose = f.emailPurpose.trim()
  if (purpose.length < 3 || purpose.length > 300) problems.push('Email: describe its purpose (3 to 300 characters).')
  if (!tasks.length) problems.push('Email: choose at least one email task.')
  if (r.badAddresses.length) problems.push(`Email: these are not valid email addresses: ${r.badAddresses.join(', ')}.`)
  if (r.badDomains.length) problems.push(`Email: these are not valid domains: ${r.badDomains.join(', ')}.`)
  if (!r.addresses.length && !r.domains.length) problems.push('Email: name at least one address or domain it may write to.')
  const unconfirmed = f.emailSuggested.filter(a => r.addresses.includes(a.toLowerCase()))
  if (unconfirmed.length && !f.emailSuggestedConfirmed) problems.push(`Email: confirm the addresses found in your text (${unconfirmed.join(', ')}), or remove them.`)
  if (r.badNotify.length) problems.push(`Email: these notify entries are not valid email addresses: ${r.badNotify.join(', ')}.`)
  if ((f.emailTasks.run_report || f.emailTasks.needs_person_alert) && !r.notify.length) problems.push('Email: choose who receives summaries and alerts.')
  const threshold = int(f.supplierThreshold), cooldown = int(f.supplierCooldown), followup = int(f.supplierFollowup)
  if (f.emailTasks.supplier_followup && !f.emailTasks.supplier_reorder) problems.push('Email: following up needs the supplier restock task.')
  if (f.emailTasks.supplier_followup && !f.emailRead) problems.push('Email: following up only when there is no reply needs permission to notice replies (below).')
  if (f.emailTasks.supplier_followup && !(followup >= 1 && followup <= 30)) problems.push('Email: days before following up must be 1 to 30.')
  if (f.emailTasks.supplier_reorder) {
    if (!r.supplier) problems.push('Email: enter the supplier address.')
    else if (!isEmailAddress(r.supplier)) problems.push(`Email: the supplier address ${r.supplier} is not a valid email address.`)
    if (!(threshold >= 0 && threshold <= 10000)) problems.push('Email: the low-stock threshold must be a whole number from 0 to 10000.')
    if (!(cooldown >= 1 && cooldown <= 60)) problems.push('Email: days between requests for the same product must be 1 to 60.')
  }
  if (r.outside.length) problems.push(`Email: outside the recipient rules: ${r.outside.join(', ')}. Add them (or their domain) to the allowed recipients.`)
  const perRun = int(f.emailPerRun), perDay = int(f.emailPerDay), maxRcpt = int(f.emailMaxRecipients)
  if (!(perRun >= 1 && perRun <= 100)) problems.push('Email: messages per run must be 1 to 100.')
  if (!(perDay >= 1 && perDay <= 500)) problems.push('Email: messages per day must be 1 to 500.')
  if (!(maxRcpt >= 1 && maxRcpt <= 20)) problems.push('Email: recipients per message must be 1 to 20.')
  let validUntil: string | null = null
  if (f.emailValidUntil) {
    const end = endOfDay(f.emailValidUntil)
    if (Number.isNaN(end.getTime())) problems.push('Email: the end date is not a date.')
    else if (end.getTime() <= Date.now()) problems.push('Email: the end date must be in the future.')
    else if (end.getTime() - Date.now() > 365 * 864e5) problems.push('Email: the end date can be at most one year from today.')
    else validUntil = end.toISOString()
  } else if (f.emailPermission === 'send_autonomous') problems.push('Email: sending without asking needs an end date (at most one year from today).')
  if (problems.length > before) return undefined
  return {
    accountId: f.emailAccountId,
    permission: f.emailPermission as AgentEmailPermission,
    purpose,
    tasks,
    recipients: { addresses: r.addresses, domains: r.domains },
    notify: f.emailTasks.run_report || f.emailTasks.needs_person_alert ? r.notify : [],
    maxRecipientsPerMessage: maxRcpt,
    limits: { perRun, perDay },
    validUntil,
    allowAttachments: f.emailAttachments,
    ...(f.emailTasks.supplier_reorder ? { supplierReorder: { supplierAddress: r.supplier, thresholdAvailable: threshold, cooldownDays: cooldown, followupDays: f.emailTasks.supplier_followup ? followup : 3 } } : {}),
    read: { enabled: f.emailRead && f.emailTasks.supplier_reorder, scope: 'replies_to_agent_messages' },
  }
}

// ---------------------------------------------------------------- form

type Props = {
  value: AgentFormState
  onChange: (f: AgentFormState) => void
  connections: Connection[]
  timezone: string
  /** connection can only be chosen on create */
  lockConnection?: boolean
  showProblems: boolean
  /** editing an existing agent: its own mailbox is offered as a sender */
  agentId?: string | null
}

export function AgentPolicyForm({ value: f, onChange, connections, timezone, lockConnection, showProblems, agentId = null }: Props) {
  const set = (patch: Partial<AgentFormState>) => onChange({ ...f, ...patch })
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const refs = useLoad(() => f.connectionId ? storeFetch<ReferencesResponse>(`/api/store/references?connection=${encodeURIComponent(f.connectionId)}`) : Promise.resolve(null), `refs:${f.connectionId}`)
  const pubs = useLoad(() => f.connectionId && f.types.publication ? storeFetch<PublicationsResponse>(`/api/store/publications?connection=${encodeURIComponent(f.connectionId)}`) : Promise.resolve(null), `pubs:${f.connectionId}:${f.types.publication}`)
  const { problems } = policyFromForm(f, timezone)
  const references = refs.data?.references ?? []
  const products = needsProducts(f), approval = needsApprovalMode(f)
  const hasRules = f.types.oversell_policy || f.types.publication || f.types.price || f.types.sku
  let n = 2
  const num = () => ++n

  return (
    <div className="flex flex-col gap-4">
      <FormBlock title="Store" n={1}>
        <label className="block text-[14px] text-grey" htmlFor={id('store')}>Connected store</label>
        <Select id={id('store')} value={f.connectionId} disabled={lockConnection} onChange={e => set({ connectionId: e.target.value, priceSourceId: '', skuSourceId: '', pubSourceId: '', pubId: '' })}>
          {connections.map(c => <option key={c.id} value={c.id}>{c.display_name ?? c.external_id}</option>)}
        </Select>
        {lockConnection && <p className="text-[13px] text-grey-h">An agent stays on the store it was created for.</p>}
      </FormBlock>

      <FormBlock title="What it may correct" n={2} sub="Only the corrections you tick here are authorized. Each one writes only its own field. An agent that only emails can leave these unticked.">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Correction types</legend>
          {AGENT_CORRECTION_TYPES.map(t => (
            <label key={t} className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
              <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={f.types[t]} onChange={e => set({ types: { ...f.types, [t]: e.target.checked } })} />
              <span>{AGENT_CORRECTION_LABEL[t]}<span className="block text-[13px] text-grey-h">{AGENT_CORRECTION_HELP[t]}</span></span>
            </label>
          ))}
        </fieldset>
        <fieldset className="mt-2 flex flex-col gap-3 border-t border-line pt-3">
          <legend className="sr-only">Read-only checks</legend>
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={f.watchOversold} onChange={e => set({ watchOversold: e.target.checked })} />
            <span>Check for oversold products (read only)<span className="block text-[13px] text-grey-h">Reports variants that sold past zero while still selling. A person decides what to do; nothing is changed.</span></span>
          </label>
        </fieldset>
      </FormBlock>

      <EmailBlock f={f} set={set} n={num()} agentId={agentId} />

      <FormBlock title="Competitor stores" n={num()} sub="Optional. Reads the public pages of other stores (read only), following their robots.txt. It never changes your store and never sees anyone's sales.">
        <Check checked={f.competitorOn} onChange={v => set({ competitorOn: v })} label="Watch competitor stores" />
        {f.competitorOn && (
          <div className="flex flex-col gap-4">
            <AreaField id={id('cmp-stores')} label="Store addresses (one per line, up to 10)" hint="Adding a store is a wider permission and needs a new grant. Removing one takes effect at once." value={f.competitorStores} onChange={v => set({ competitorStores: v })} />
            <TextField id={id('cmp-keywords')} label="Categories or keywords (optional)" hint="Comma separated. Only matching products are recorded; empty means every product." value={f.competitorKeywords} onChange={v => set({ competitorKeywords: v })} />
            <fieldset className="flex flex-col gap-2">
              <legend className="text-[14px] text-grey">Alert me about</legend>
              {COMPETITOR_ALERTS.map(a => <Check key={a} checked={f.competitorAlerts[a]} onChange={v => set({ competitorAlerts: { ...f.competitorAlerts, [a]: v } })} label={COMPETITOR_ALERT_WORDS[a]} />)}
            </fieldset>
            <TextField id={id('cmp-pct')} label="Ignore price changes smaller than (%)" value={f.competitorMinPct} onChange={v => set({ competitorMinPct: v })} inputMode="decimal" />
            <Check checked={f.competitorCompare} onChange={v => set({ competitorCompare: v })} label="Compare with my own product names to point out possible opportunities (reads your store, never changes it)" />
          </div>
        )}
      </FormBlock>

      {products && <FormBlock title="Which products" n={num()} sub="The agent never reads past or changes products outside this scope. Exceptions always win.">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Product scope</legend>
          {([['all', 'All products in the store'], ['products', 'Specific products (by product ID)'], ['tags', 'Products with any of these tags']] as const).map(([m, l]) => (
            <label key={m} className="flex cursor-pointer items-center gap-3 text-[15px] text-ink">
              <input type="radio" name={id('scope')} className="h-5 w-5 accent-white" checked={f.scopeMode === m} onChange={() => set({ scopeMode: m })} />{l}
            </label>
          ))}
        </fieldset>
        {f.scopeMode === 'products' && <TextField id={id('scope-ids')} label="Product IDs" hint="Comma or line separated, e.g. 1001, 1002 (the number at the end of the product's admin URL)." value={f.scopeProductIds} onChange={v => set({ scopeProductIds: v })} />}
        {f.scopeMode === 'tags' && <TextField id={id('scope-tags')} label="Tags in scope" hint="Comma separated. Matching ignores upper and lower case." value={f.scopeTags} onChange={v => set({ scopeTags: v })} />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField id={id('ex-tags')} label="Exception tags (never touched)" hint="Comma separated, e.g. wholesale, do-not-change." value={f.exceptTags} onChange={v => set({ exceptTags: v })} />
          <TextField id={id('ex-ids')} label="Exception product IDs (never touched)" hint="Comma separated product IDs." value={f.exceptProductIds} onChange={v => set({ exceptProductIds: v })} />
        </div>
      </FormBlock>}

      {hasRules && (
        <FormBlock title="Rules and reference files" n={num()} sub="Files are treated as data only: Deploi reads the columns it knows and ignores everything else. Nothing in a file can widen what the agent may do.">
          {refs.error && <Banner tone="warn"><strong>Could not load your files.</strong> {refs.error.message}</Banner>}
          {f.types.oversell_policy && (
            <RuleCard title={AGENT_CORRECTION_LABEL.oversell_policy}>
              <TextField id={id('os-tags')} label="Exempt tags (pre-order, backorder and similar)" hint="Products with any of these tags may keep selling past zero and are never changed." value={f.oversellExemptTags} onChange={v => set({ oversellExemptTags: v })} />
              <Check checked={f.flagInStock} onChange={v => set({ flagInStock: v })} label="Also correct in-stock variants that would oversell after the last unit sells" />
            </RuleCard>
          )}
          {f.types.publication && (
            <RuleCard title={AGENT_CORRECTION_LABEL.publication}>
              <label className="block text-[14px] text-grey" htmlFor={id('pub')}>Sales channel</label>
              <Select id={id('pub')} value={f.pubId} onChange={e => set({ pubId: e.target.value, pubName: pubs.data?.publications.find(p => p.id === e.target.value)?.title ?? '' })}>
                <option value="">{pubs.loading ? 'Loading sales channels…' : 'Choose a sales channel'}</option>
                {(pubs.data?.publications ?? []).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
              {pubs.error && <p className="text-[13px] text-warn">Could not read the store&apos;s sales channels: {pubs.error.message}</p>}
              {f.pubName && !f.pubId && <p className="text-[13px] text-grey-h">Your task mentioned {f.pubName}; choose it above to confirm.</p>}
              <fieldset className="flex flex-col gap-2">
                <legend className="text-[14px] text-grey">What says a product should be published</legend>
                <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink"><input type="radio" name={id('pubsrc')} className="h-5 w-5 accent-white" checked={f.pubSource === 'file'} onChange={() => set({ pubSource: 'file' })} />A publication list file</label>
                <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink"><input type="radio" name={id('pubsrc')} className="h-5 w-5 accent-white" checked={f.pubSource === 'tags'} onChange={() => set({ pubSource: 'tags' })} />Publish products with these tags</label>
              </fieldset>
              {f.pubSource === 'file'
                ? <ReferencePicker kind="publication_list" value={f.pubSourceId} onChange={v => set({ pubSourceId: v })} references={references} connectionId={f.connectionId} onUploaded={refs.reload} />
                : <TextField id={id('pub-tags')} label="Publish tags" hint="Comma separated." value={f.pubTags} onChange={v => set({ pubTags: v })} />}
              <Check checked={f.allowUnpublish} onChange={v => set({ allowUnpublish: v })} label="Also allow unpublishing products the list says should not be published" />
            </RuleCard>
          )}
          {f.types.price && (
            <RuleCard title={AGENT_CORRECTION_LABEL.price}>
              <ReferencePicker kind="price_list" value={f.priceSourceId} onChange={v => set({ priceSourceId: v })} references={references} connectionId={f.connectionId} onUploaded={refs.reload} />
              <fieldset className="flex flex-col gap-2">
                <legend className="text-[14px] text-grey">Fields it may set (store currency only)</legend>
                <Check checked={f.priceField} onChange={v => set({ priceField: v })} label="Price" />
                <Check checked={f.compareAtField} onChange={v => set({ compareAtField: v })} label="Compare-at price" />
              </fieldset>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextField id={id('pct')} label="Largest change it may make without asking (%)" hint="Larger changes always wait for your approval." value={f.maxChangePct} onChange={v => set({ maxChangePct: v })} disabled={f.noPriceLimit} inputMode="decimal" />
              </div>
              <Check checked={f.noPriceLimit} onChange={v => set({ noPriceLimit: v })} label="No limit on the size of a price change" />
              <Check checked={f.skipSale} onChange={v => set({ skipSale: v })} label="Protect sale prices (leave variants with a compare-at price above the price alone)" />
            </RuleCard>
          )}
          {f.types.sku && (
            <RuleCard title={AGENT_CORRECTION_LABEL.sku}>
              <ReferencePicker kind="sku_mapping" value={f.skuSourceId} onChange={v => set({ skuSourceId: v })} references={references} connectionId={f.connectionId} onUploaded={refs.reload} />
              <Check checked={f.skuOverwrite} onChange={v => set({ skuOverwrite: v })} label="Also correct existing SKUs that differ from the mapping (otherwise it only fills missing SKUs)" />
            </RuleCard>
          )}
        </FormBlock>
      )}

      <FormBlock title="When it runs" n={num()}>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Schedule</legend>
          <label className="flex cursor-pointer items-center gap-3 text-[15px] text-ink"><input type="radio" name={id('sched')} className="h-5 w-5 accent-white" checked={f.scheduleKind === 'manual'} onChange={() => set({ scheduleKind: 'manual' })} />Only when I press Run now</label>
          <label className="flex cursor-pointer flex-wrap items-center gap-3 text-[15px] text-ink">
            <input type="radio" name={id('sched')} className="h-5 w-5 accent-white" checked={f.scheduleKind === 'interval'} onChange={() => set({ scheduleKind: 'interval' })} />Every
            <span className="w-20"><Input aria-label="Hours between runs" inputMode="numeric" value={f.everyHours} onFocus={() => set({ scheduleKind: 'interval' })} onChange={e => set({ everyHours: e.target.value, scheduleKind: 'interval' })} /></span>hours
          </label>
          <label className="flex cursor-pointer flex-wrap items-center gap-3 text-[15px] text-ink">
            <input type="radio" name={id('sched')} className="h-5 w-5 accent-white" checked={f.scheduleKind === 'daily'} onChange={() => set({ scheduleKind: 'daily' })} />Daily at
            <span className="w-40"><Input type="time" aria-label="Time of day" value={f.dailyTime} onChange={e => set({ dailyTime: e.target.value, scheduleKind: 'daily' })} /></span>
            <span className="text-[13px] text-grey-h">({timezone})</span>
          </label>
        </fieldset>
      </FormBlock>

      {approval && <FormBlock title="How changes are approved" n={num()}>
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Approval mode</legend>
          {f.suggestedMode && f.suggestedMode !== f.approvalMode && <p className="text-[13px] text-grey-h">Your task asked to {f.suggestedMode === 'autonomous' ? 'act without asking' : 'ask before each change'}. New agents start at drafts only; choose it here if you want it.</p>}
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="radio" name={id('mode')} className="mt-1 h-5 w-5 accent-white" checked={f.approvalMode === 'draft'} onChange={() => set({ approvalMode: 'draft' })} />
            <span>Drafts only (default)<span className="block text-[13px] text-grey-h">The agent finds problems and shows the exact change it would make. It never changes your store. Allowing changes later needs a new grant.</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="radio" name={id('mode')} className="mt-1 h-5 w-5 accent-white" checked={f.approvalMode === 'review'} onChange={() => set({ approvalMode: 'review' })} />
            <span>After my approval<span className="block text-[13px] text-grey-h">The agent proposes exact changes. Nothing is written until you approve each one.</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
            <input type="radio" name={id('mode')} className="mt-1 h-5 w-5 accent-white" checked={f.approvalMode === 'autonomous'} onChange={() => set({ approvalMode: 'autonomous' })} />
            <span>Without asking, within limits (up to one year)<span className="block text-[13px] text-grey-h">Changes this authorization covers are made without asking, up to the limits below and until the end date. Anything it does not cover (outside the scope, over a limit, ambiguous) waits for you.</span></span>
          </label>
          {f.approvalMode === 'autonomous' && (
            <div className="flex flex-col gap-1 pl-8">
              <label className="text-[14px] text-grey" htmlFor={id('store-until')}>Authorization ends on (required, at most one year)</label>
              <span className="w-48"><Input id={id('store-until')} type="date" value={f.storeValidUntil} onChange={e => set({ storeValidUntil: e.target.value })} /></span>
            </div>
          )}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField id={id('per-run')} label="Changes per run, at most" value={f.maxPerRun} onChange={v => set({ maxPerRun: v })} inputMode="numeric" />
          <TextField id={id('per-day')} label="Changes per day, at most" value={f.maxPerDay} onChange={v => set({ maxPerDay: v })} inputMode="numeric" />
        </div>
        <p className="text-[13px] text-grey-h">Limits apply to changes made without asking. Changes beyond them wait for your approval.</p>
      </FormBlock>}

      {showProblems && problems.length > 0 && (
        <div role="alert">
          <Banner tone="warn">
            <strong>Still to choose before this can be reviewed:</strong>
            <ul className="mt-1 list-disc pl-5">{problems.map(p => <li key={p}>{p}</li>)}</ul>
          </Banner>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- email

function EmailBlock({ f, set, n, agentId }: { f: AgentFormState; set: (patch: Partial<AgentFormState>) => void; n: number; agentId: string | null }) {
  const { base } = useStore()
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const accounts = useLoad(() => f.emailOn ? storeFetch<EmailAccountsResponse>(`/api/store/email/accounts${agentId ? `?agent=${encodeURIComponent(agentId)}` : ''}`) : Promise.resolve(null), `email-accounts:${f.emailOn}:${agentId}`)
  const list: EmailAccountView[] = accounts.data?.accounts ?? []
  const chosen = list.find(a => a.id === f.emailAccountId) ?? null
  const r = emailRules(f)
  const notifyNeeded = f.emailTasks.run_report || f.emailTasks.needs_person_alert
  const suggested = f.emailSuggested.filter(a => r.addresses.includes(a.toLowerCase()))
  const readBlocked = !f.emailTasks.supplier_reorder || (chosen !== null && !chosen.can_read)

  return (
    <FormBlock title="Email" n={n} sub="Optional. The agent may only use one connected account, for the tasks, recipients and limits you set here. Incoming mail never changes what it may do.">
      <Check checked={f.emailOn} onChange={v => set({ emailOn: v })} label="Let this agent use email" />
      {f.emailOn && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[14px] text-grey" htmlFor={id('account')}>Send from</label>
            <Select id={id('account')} value={f.emailAccountId} onChange={e => set({ emailAccountId: e.target.value, ...(list.find(a => a.id === e.target.value)?.can_read ? {} : { emailRead: false }) })} aria-describedby={id('account-hint')}>
              <option value="">{accounts.loading && !accounts.data ? 'Loading email accounts…' : list.length ? 'Choose a connected account' : 'No email account connected'}</option>
              {list.map(a => <option key={a.id} value={a.id}>{a.address} · {a.label}{a.status !== 'active' ? ` · ${emailAccountWords(a.status).label}` : ''}</option>)}
            </Select>
            <span id={id('account-hint')} className="text-[13px] text-grey-h">
              {list.length === 0 && !accounts.loading
                ? <>Connect an account first on <Link href={`${base}/connections`} className="text-ink underline">Connections</Link>. Deploi never asks for your mailbox password.</>
                : <>Accounts are connected on <Link href={`${base}/connections`} className="text-ink underline">Connections</Link>.</>}
            </span>
            {accounts.error && <span className="text-[13px] text-warn">Could not load your email accounts: {accounts.error.message}</span>}
            {chosen && chosen.status !== 'active' && <span className="text-[13px] text-warn">This account is {emailAccountWords(chosen.status).label.toLowerCase()}{chosen.status_reason ? `: ${chosen.status_reason}` : ''}. It cannot send until it is reconnected.</span>}
            {chosen && !chosen.can_send && f.emailPermission && f.emailPermission !== 'draft' && <span className="text-[13px] text-warn">This account was connected without permission to send. Reconnect it and allow sending, or choose drafts only.</span>}
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-[14px] text-grey">What it may do with email</legend>
            {f.suggestedEmailPermission && f.suggestedEmailPermission !== f.emailPermission && <p className="text-[13px] text-grey-h">Your task asked for: {AGENT_EMAIL_PERMISSION_LABEL[f.suggestedEmailPermission].toLowerCase()}. New agents start at drafts only; choose it here if you want it.</p>}
            {AGENT_EMAIL_PERMISSIONS.map(p => (
              <label key={p} className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
                <input type="radio" name={id('perm')} className="mt-1 h-5 w-5 accent-white" checked={f.emailPermission === p} onChange={() => set({ emailPermission: p })} />
                <span>{AGENT_EMAIL_PERMISSION_LABEL[p]}<span className="block text-[13px] text-grey-h">{AGENT_EMAIL_PERMISSION_HELP[p]}</span></span>
              </label>
            ))}
          </fieldset>

          <TextField id={id('purpose')} label="Purpose" hint="Required. Shown in the authorization and recorded with every message, e.g. Restock requests to our supplier and run summaries for the owner." value={f.emailPurpose} onChange={v => set({ emailPurpose: v })} />

          <fieldset className="flex flex-col gap-3">
            <legend className="text-[14px] text-grey">Email tasks</legend>
            {AGENT_EMAIL_TASKS.map(t => (
              <label key={t} className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
                <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={f.emailTasks[t]} onChange={e => set({ emailTasks: { ...f.emailTasks, [t]: e.target.checked }, ...(t === 'supplier_reorder' && !e.target.checked ? { emailRead: false } : {}) })} />
                <span>{AGENT_EMAIL_TASK_LABEL[t]}<span className="block text-[13px] text-grey-h">{AGENT_EMAIL_TASK_HELP[t]}</span></span>
              </label>
            ))}
          </fieldset>

          <RuleCard title="Who it may write to">
            <p className="text-[13px] text-grey-h">The agent may only ever write to these addresses and domains. A message to anyone else always waits for your approval.</p>
            <AreaField id={id('addresses')} label="Allowed recipient addresses" hint="Comma or line separated, e.g. owner@yourstore.com, orders@supplier.com." value={f.emailAddresses} onChange={v => set({ emailAddresses: v })} />
            {suggested.length > 0 && (
              <div className="rounded-[14px] border border-[#4a3a1a] p-3">
                <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink"><Badge tone="warn">found in your text: confirm</Badge>{suggested.join(', ')}</div>
                <p className="pt-1 text-[13px] text-grey-h">These addresses came from your task description. They are not allowed until you confirm them; remove any you do not want.</p>
                <div className="mt-2"><Check checked={f.emailSuggestedConfirmed} onChange={v => set({ emailSuggestedConfirmed: v })} label="I confirm the agent may write to these addresses" /></div>
              </div>
            )}
            {r.badAddresses.length > 0 && <p className="text-[13px] text-warn">Not valid email addresses: {r.badAddresses.join(', ')}</p>}
            <AreaField id={id('domains')} label="Allowed recipient domains" hint="Anyone at these domains, e.g. supplier.com. Comma or line separated." value={f.emailDomains} onChange={v => set({ emailDomains: v })} />
            {r.badDomains.length > 0 && <p className="text-[13px] text-warn">Not valid domains: {r.badDomains.join(', ')}</p>}
            {notifyNeeded && (
              <>
                <AreaField id={id('notify')} label="Send summaries and alerts to" hint="Each address must be allowed above." value={f.emailNotify} onChange={v => set({ emailNotify: v })} />
                {r.badNotify.length > 0 && <p className="text-[13px] text-warn">Not valid email addresses: {r.badNotify.join(', ')}</p>}
              </>
            )}
            {r.outside.length > 0 && <p className="text-[13px] text-warn" role="status">Outside the recipient rules: {r.outside.join(', ')}. Add them, or their domain, to the allowed recipients.</p>}
          </RuleCard>

          {f.emailTasks.supplier_reorder && (
            <RuleCard title="Supplier restock requests">
              <TextField id={id('supplier')} label="Supplier address" hint="Must be allowed above. The agent asks this address to confirm a restock; it never places an order or changes stock." value={f.supplierAddress} onChange={v => set({ supplierAddress: v })} />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextField id={id('threshold')} label="Ask when available is at or below" hint="Units available to sell. 0 means out of stock." value={f.supplierThreshold} onChange={v => set({ supplierThreshold: v })} inputMode="numeric" />
                <TextField id={id('cooldown')} label="Days before asking again about the same product" value={f.supplierCooldown} onChange={v => set({ supplierCooldown: v })} inputMode="numeric" />
                {f.emailTasks.supplier_followup && <TextField id={id('followup')} label="Days without a reply before the one follow-up" value={f.supplierFollowup} onChange={v => set({ supplierFollowup: v })} inputMode="numeric" />}
              </div>
            </RuleCard>
          )}

          <RuleCard title="Limits and dates">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <TextField id={id('e-run')} label="Messages per run, at most" value={f.emailPerRun} onChange={v => set({ emailPerRun: v })} inputMode="numeric" />
              <TextField id={id('e-day')} label="Messages per day, at most" value={f.emailPerDay} onChange={v => set({ emailPerDay: v })} inputMode="numeric" />
              <TextField id={id('e-rcpt')} label="Recipients per message, at most" value={f.emailMaxRecipients} onChange={v => set({ emailMaxRecipients: v })} inputMode="numeric" />
            </div>
            <div className="flex flex-col gap-1 md:max-w-[260px]">
              <label className="text-[14px] text-grey" htmlFor={id('until')}>Authorization ends on{f.emailPermission === 'send_autonomous' ? ' (required)' : ' (optional)'}</label>
              <Input id={id('until')} type="date" value={f.emailValidUntil} onChange={e => set({ emailValidUntil: e.target.value })} aria-describedby={id('until-hint')} />
              <span id={id('until-hint')} className="text-[13px] text-grey-h">Sending without asking needs an end date, at most one year from today. After it, messages wait for your approval.</span>
            </div>
            <Check checked={f.emailAttachments} onChange={v => set({ emailAttachments: v })} label="Allow attachments (for example the list of low-stock products as a CSV file)" />
          </RuleCard>

          <RuleCard title="Reading replies">
            <label className={`flex items-start gap-3 text-[15px] ${readBlocked ? 'text-grey-h' : 'cursor-pointer text-ink'}`}>
              <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={f.emailRead && !readBlocked} disabled={readBlocked} onChange={e => set({ emailRead: e.target.checked })} />
              <span>Notice supplier replies to the restock requests it sent</span>
            </label>
            <p className="text-[13px] text-grey-h">
              A separate, extra permission: the agent looks only for replies to messages it sent, and records who replied and when. It never acts on what a reply says.
              {!f.emailTasks.supplier_reorder ? ' Only available with supplier restock requests.' : chosen && !chosen.can_read ? <> The chosen account has no read access: add it on <Link href={`${base}/connections`} className="text-ink underline">Connections</Link> first.</> : ' The account must have read access.'}
            </p>
          </RuleCard>
        </div>
      )}
    </FormBlock>
  )
}

function AreaField({ id, label, hint, value, onChange }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[14px] text-grey" htmlFor={id}>{label}</label>
      <Textarea id={id} rows={2} value={value} onChange={e => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <span id={`${id}-hint`} className="text-[13px] text-grey-h">{hint}</span>}
    </div>
  )
}

function FormBlock({ title, sub, n, children }: { title: string; sub?: string; n: number; children: ReactNode }) {
  return (
    <Panel>
      <h3 className="text-[1.05rem]"><span className="text-grey-h">{n}.</span> {title}</h3>
      {sub && <p className="pt-1 text-[13px] text-grey-h">{sub}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </Panel>
  )
}

function RuleCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="text-[15px] font-medium text-ink">{title}</div>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </div>
  )
}

function TextField({ id, label, hint, value, onChange, disabled, inputMode }: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; disabled?: boolean; inputMode?: 'numeric' | 'decimal' }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[14px] text-grey" htmlFor={id}>{label}</label>
      <Input id={id} value={value} disabled={disabled} inputMode={inputMode} onChange={e => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <span id={`${id}-hint`} className="text-[13px] text-grey-h">{hint}</span>}
    </div>
  )
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink">
      <input type="checkbox" className="mt-1 h-5 w-5 accent-white" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

// ---------------------------------------------------------------- reference files

type UploadState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; r: UploadReferenceResponse } | { kind: 'error'; e: StoreApiError }

export function ReferencePicker({ kind, value, onChange, references, connectionId, onUploaded }: {
  kind: ReferenceKindName; value: string; onChange: (id: string) => void; references: ReferenceSourceView[]; connectionId: string; onUploaded: () => Promise<void>
}) {
  const uid = useId()
  const options = references.filter(r => r.kind === kind)
  const selected = options.find(r => r.id === value)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [up, setUp] = useState<UploadState>({ kind: 'idle' })
  const label = referenceKindLabel(kind)

  async function upload() {
    if (!file) return
    setUp({ kind: 'busy' })
    try {
      const csv = await file.text()
      const r = await storeFetch<UploadReferenceResponse>('/api/store/references', { method: 'POST', body: { connectionId, kind, name: name.trim() || file.name.replace(/\.csv$/i, ''), csv } })
      setUp({ kind: 'done', r })
      await onUploaded()
      onChange(r.source.id)
      setFile(null)
    } catch (e) { setUp({ kind: 'error', e: asApiError(e) }) }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[14px] text-grey" htmlFor={`${uid}-sel`}>{label}</label>
      <Select id={`${uid}-sel`} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{options.length ? `Choose a ${label.toLowerCase()}` : `No ${label.toLowerCase()} uploaded yet`}</option>
        {options.map(r => <option key={r.id} value={r.id}>{r.name} · version {r.version} · {r.row_count} row{r.row_count === 1 ? '' : 's'}</option>)}
      </Select>
      {selected && (
        <div className="flex flex-wrap gap-2 text-[13px]">
          <Badge tone="muted">{selected.row_count} row{selected.row_count === 1 ? '' : 's'} read</Badge>
          {selected.error_count > 0 && <Badge tone="warn">{selected.error_count} row{selected.error_count === 1 ? '' : 's'} skipped</Badge>}
          {selected.ambiguous_keys > 0 && <Badge tone="warn">{selected.ambiguous_keys} ambiguous (blocked, never guessed)</Badge>}
        </div>
      )}
      <details className="rounded-[14px] border border-line p-3">
        <summary className="cursor-pointer text-[14px] text-ink">Upload a {label.toLowerCase()} (CSV)</summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-[13px] text-grey-h">
            Uploading a file with the same name as an existing one replaces it with a new version; changes based on the old version are recomputed.{' '}
            <a href={`/api/store/references?template=${kind}`} download className="text-ink underline">Download the {label.toLowerCase()} template</a>
          </p>
          <label className="text-[14px] text-grey" htmlFor={`${uid}-file`}>CSV file</label>
          <input id={`${uid}-file`} type="file" accept=".csv,text/csv" className="text-[14px] text-grey file:mr-3 file:rounded-full file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:text-ink"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setUp({ kind: 'idle' }) }} />
          <label className="text-[14px] text-grey" htmlFor={`${uid}-name`}>Name</label>
          <Input id={`${uid}-name`} value={name} maxLength={120} placeholder={file ? file.name.replace(/\.csv$/i, '') : `e.g. ${label} autumn`} onChange={e => setName(e.target.value)} />
          <div><Button type="button" variant="ghost" size="sm" onClick={upload} disabled={!file || up.kind === 'busy'} aria-label={`Upload ${label.toLowerCase()}`}><Icon name="upload" size={15} />{up.kind === 'busy' ? 'Uploading…' : 'Upload'}</Button></div>
          <div aria-live="polite">
            {up.kind === 'error' && <Banner tone="warn"><strong>Not uploaded.</strong> {up.e.message}</Banner>}
            {up.kind === 'done' && (
              <Banner icon="check">
                <strong>{up.r.unchanged ? 'Same as the current version; nothing changed.' : `Uploaded "${up.r.source.name}" as version ${up.r.source.version}.`}</strong>{' '}
                {up.r.source.row_count} row{up.r.source.row_count === 1 ? '' : 's'} read{up.r.source.ambiguous_keys ? `, ${up.r.source.ambiguous_keys} ambiguous (the agent blocks on these instead of guessing)` : ''}.
                {up.r.rowErrors.length > 0 && (
                  <span className="block pt-1">{up.r.rowErrors.length} row{up.r.rowErrors.length === 1 ? '' : 's'} skipped:
                    <ul className="list-disc pl-5">{up.r.rowErrors.slice(0, 10).map(e => <li key={`${e.row}-${e.message}`}>Row {e.row}: {e.message}</li>)}</ul>
                  </span>
                )}
              </Banner>
            )}
          </div>
        </div>
      </details>
    </div>
  )
}
