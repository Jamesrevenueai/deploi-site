/**
 * What the embedded Shopify app shows. Shopify review must see only features that work on a real store,
 * so every page under app/shopify is declared here with a readiness rule, and:
 *  - the App Bridge menu (app/shopify/layout.tsx) lists only ready features (embeddedNav),
 *  - every embedded page calls requireEmbeddedFeature() first: a feature that is not ready is a 404,
 *  - the store API refuses hidden features to a Shopify session token (lib/store/embedded-gate.ts), so a
 *    hidden feature cannot be reached by calling the API directly either.
 *
 * Readiness sources:
 *  - The engine features (overview, agents, approvals, issues, activity, rules, connections, privacy) run on
 *    the live Shopify connector (GraphQL Admin API) and are always ready.
 *  - Library agents (the Team page) read the store through lib/library/store-data.ts, whose live
 *    implementation refuses every call (`not_wired`). They are shown only when the shared pack registry
 *    (lib/packs/registry.ts, agentsFor('shopify')) marks them working and shopifyReady.
 *  - Plan: Shopify merchants are billed only through Shopify App Pricing. The embedded Plan page shows the
 *    plan read from Shopify and opens Shopify's hosted plan page; it exists only while BILLING_REQUIRED is on.
 *    The library tier page and its API (proposed prices, "coming soon") are never shown inside Shopify.
 *  - Agreements: shown only while the legal gate asks merchants to accept something (LEGAL_GATE).
 *
 * A new embedded page must be added to EMBEDDED_FEATURES (tests/shopify/embedded-gating.test.ts fails otherwise).
 */
import { notFound } from 'next/navigation'
import { agentsFor } from '../packs/registry'
import { agentByKey } from '../library/config'
import type { TemplateKey } from '../agents/templates'

export type EmbeddedFeatureKey =
  | 'overview' | 'agents' | 'approvals' | 'issues' | 'activity' | 'rules' | 'connections' | 'connect' | 'weekly'
  | 'privacy' | 'legal' | 'team' | 'plan'

export type EmbeddedFeature = {
  key: EmbeddedFeatureKey
  /** the page path; dynamic segments as [name] */
  path: string
  label: string
  /** listed in the App Bridge menu when ready */
  nav: boolean
  ready: () => boolean
  /** why it is hidden when not ready (shown in docs and tests, never to merchants) */
  hiddenWhy?: string
}

/**
 * Engine templates offered inside Shopify. Hidden: Supplier Coordinator (needs purchase orders imported on
 * the web app; the embedded app has no import page) and Competitor & Trend Watcher (reads other stores'
 * public pages; two implementations still await a decision, docs/COMPETITOR-WATCHER-DECISION.md).
 */
export const EMBEDDED_TEMPLATES: readonly TemplateKey[] = ['inventory_watcher', 'supplier_chaser', 'store_health_checker']

/** Shopify App Pricing is live (the Plan page links to Shopify's hosted plan page). */
const billingOn = () => (process.env.BILLING_REQUIRED ?? '').trim() === 'true'
const legalGateOn = () => ['draft', 'enforce'].includes((process.env.LEGAL_GATE ?? '').trim().toLowerCase())

/** Library agents that may appear inside Shopify: working and shopifyReady in the pack registry, and in the library. */
export function shopifyLibraryAgentKeys(): string[] {
  return agentsFor('shopify').filter(a => a.status === 'working' && agentByKey(a.key)).map(a => a.key)
}

export const isEmbeddedTemplate = (key: string) => (EMBEDDED_TEMPLATES as readonly string[]).includes(key)
export const isShopifyLibraryAgent = (key: string) => shopifyLibraryAgentKeys().includes(key)

export const EMBEDDED_FEATURES: EmbeddedFeature[] = [
  { key: 'overview', path: '/shopify', label: 'Overview', nav: true, ready: () => true },
  { key: 'agents', path: '/shopify/agents', label: 'Agents', nav: true, ready: () => true },
  { key: 'agents', path: '/shopify/agents/new', label: 'Create agent', nav: false, ready: () => true },
  { key: 'agents', path: '/shopify/agents/[id]', label: 'Agent', nav: false, ready: () => true },
  { key: 'approvals', path: '/shopify/inbox', label: 'Approvals', nav: true, ready: () => true },
  { key: 'issues', path: '/shopify/issues', label: 'Issues', nav: true, ready: () => true },
  { key: 'issues', path: '/shopify/issues/[id]', label: 'Issue', nav: false, ready: () => true },
  { key: 'activity', path: '/shopify/activity', label: 'Activity', nav: true, ready: () => true },
  { key: 'weekly', path: '/shopify/weekly', label: 'Weekly summary', nav: false, ready: () => true },
  { key: 'rules', path: '/shopify/rules', label: 'Rules', nav: true, ready: () => true },
  { key: 'connections', path: '/shopify/connections', label: 'Connections', nav: true, ready: () => true },
  { key: 'connect', path: '/shopify/connect', label: 'Store connection', nav: false, ready: () => true },
  { key: 'privacy', path: '/shopify/privacy', label: 'Privacy requests', nav: true, ready: () => true },
  { key: 'legal', path: '/shopify/legal', label: 'Agreements', nav: true, ready: legalGateOn, hiddenWhy: 'nothing to accept while LEGAL_GATE is off' },
  { key: 'team', path: '/shopify/team', label: 'Team', nav: true, ready: () => shopifyLibraryAgentKeys().length > 0, hiddenWhy: 'no library agent is marked working and shopifyReady in lib/packs/registry.ts (the live store reader is not wired)' },
  { key: 'team', path: '/shopify/team/[key]', label: 'Agent', nav: false, ready: () => shopifyLibraryAgentKeys().length > 0, hiddenWhy: 'as Team' },
  { key: 'plan', path: '/shopify/plan', label: 'Plan', nav: true, ready: billingOn, hiddenWhy: 'the app is free while BILLING_REQUIRED is off; when on, this page sends the merchant to Shopify\'s hosted plan page (App Pricing)' },
]

export const EMBEDDED_HOME = '/shopify'

/** The feature a concrete path belongs to (dynamic segments match one path segment), or null. */
export function embeddedFeatureFor(pathname: string): EmbeddedFeature | null {
  const clean = pathname.split('?')[0].replace(/\/+$/, '') || '/'
  const parts = clean.split('/')
  return EMBEDDED_FEATURES.find(f => {
    const p = f.path.split('/')
    return p.length === parts.length && p.every((seg, i) => (seg.startsWith('[') ? parts[i].length > 0 : seg === parts[i]))
  }) ?? null
}

export const isEmbeddedFeatureReady = (key: EmbeddedFeatureKey) => EMBEDDED_FEATURES.some(f => f.key === key && f.ready())

/** May a merchant inside Shopify open this path? (Team agent pages also need that agent to be ready.) */
export function embeddedPathAllowed(pathname: string): boolean {
  const f = embeddedFeatureFor(pathname)
  if (!f || !f.ready()) return false
  if (f.path === '/shopify/team/[key]') return isShopifyLibraryAgent(decodeURIComponent(pathname.split('/')[3] ?? ''))
  return true
}

/** The App Bridge menu: ready features only, home excluded (App Bridge takes it as rel="home"). */
export function embeddedNav(): { href: string; label: string }[] {
  return EMBEDDED_FEATURES.filter(f => f.nav && f.path !== EMBEDDED_HOME && f.ready()).map(f => ({ href: f.path, label: f.label }))
}

/** First call in every embedded page: a feature that is not ready (or a hidden agent) is a 404. */
export function requireEmbeddedFeature(key: EmbeddedFeatureKey, opts: { libraryAgent?: string } = {}): void {
  if (!isEmbeddedFeatureReady(key)) notFound()
  if (opts.libraryAgent !== undefined && !isShopifyLibraryAgent(opts.libraryAgent)) notFound()
}
