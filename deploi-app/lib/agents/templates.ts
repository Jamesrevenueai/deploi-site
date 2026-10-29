/**
 * Agent templates. Each is pre-filled with a job description, the tools it needs and the most
 * restrictive permission level for every tool (drafts only). A template grants nothing: creating an
 * agent from one still produces a policy version the merchant reads and grants, and any later edit
 * that widens access (a higher tier, more recipients, more products) needs a new grant.
 */
import { OVERSOLD_WATCH } from './watch'

export type TemplateKey = 'inventory_watcher' | 'supplier_chaser' | 'store_health_checker' | 'competitor_watcher'
/** web: reads other stores' public pages only */
export type TemplateTool = 'shopify' | 'email' | 'web'

export type AgentTemplate = {
  key: TemplateKey
  name: string
  /** the plain-English job description, shown and saved as the agent's task */
  job: string
  tools: TemplateTool[]
  /** the agent gets its own address on Deploi's domain */
  mailbox: boolean
  /** what the merchant still has to supply before granting */
  needs: string[]
  /** estimated minutes of merchant work one finished item replaces (weekly summary estimate) */
  minutesPerItem: number
}

export const TEMPLATES: AgentTemplate[] = [
  {
    key: 'inventory_watcher', name: 'Inventory Watcher',
    job: 'Every day, check my inventory. Tell me about products that are oversold or set to keep selling when they are out of stock, except anything tagged pre-order or backorder. Show me the change you would make, but do not change anything.',
    tools: ['shopify', 'email'], mailbox: true,
    needs: ['who receives the alerts (your email address)'],
    minutesPerItem: 4,
  },
  {
    key: 'supplier_chaser', name: 'Supplier Chaser',
    job: 'Every day, find products with 2 or fewer available and draft a restock request to my supplier from your own address. If the supplier has not replied after 3 days, draft one follow-up in the same thread. Do not send anything without me.',
    tools: ['shopify', 'email'], mailbox: true,
    needs: ["your supplier's email address"],
    minutesPerItem: 10,
  },
  {
    key: 'store_health_checker', name: 'Store Health Checker',
    job: 'Once a week, check the whole store for oversold products and products that keep selling when out of stock, and write me a health report. Do not change anything.',
    tools: ['shopify', 'email'], mailbox: true,
    needs: ['who receives the report (your email address)'],
    minutesPerItem: 3,
  },
  {
    key: 'competitor_watcher', name: 'Competitor & Trend Watcher',
    job: 'Every day, check the public pages of the stores I follow. Tell me what they launch, put on sale, change the price of or feature in their bestseller collections, and point out patterns across several stores. Say what was observed and what is only inferred. Never guess their sales, and do not change anything or contact anyone.',
    tools: ['web', 'email'], mailbox: true,
    needs: ['the stores to watch (their web addresses)', 'optional: keywords or categories you care about', 'optional: your email address for alerts (drafted to you)'],
    minutesPerItem: 6,
  },
]

export const templateByKey = (k: string) => TEMPLATES.find(t => t.key === k) ?? null

const EXEMPT = ['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order']

/**
 * The raw policy a template starts from (validated by the server like any other). Every tool is at
 * drafts only. Empty inputs stay empty, so the server refuses the policy until the merchant fills them.
 */
export type CompetitorTemplateInput = { stores?: { url: string; label?: string; bestsellerCollection?: string | null }[]; keywords?: string[]; categories?: string[]; region?: string | null; currency?: string | null; everyHours?: number | null; alerts?: Record<string, unknown> }

export function templatePolicy(key: TemplateKey, input: { connectionId: string; timezone: string; notify?: string | null; supplierAddress?: string | null; competitor?: CompetitorTemplateInput }): Record<string, unknown> {
  const notify = (input.notify ?? '').trim().toLowerCase()
  const supplier = (input.supplierAddress ?? '').trim().toLowerCase()
  const base = { connectionId: input.connectionId, productScope: { mode: 'all' }, approvalMode: 'draft', validUntil: null, limits: { maxChangesPerRun: 25, maxChangesPerDay: 100 } }
  // the mailbox id is filled in by the server when the agent and its mailbox are created together
  const placeholderAccount = '00000000-0000-0000-0000-000000000000'
  if (key === 'inventory_watcher') return {
    ...base, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: EXEMPT, flagInStockVariants: true } }, watch: [OVERSOLD_WATCH],
    schedule: { kind: 'daily', hour: 7, minute: 0, timezone: input.timezone },
    email: { accountId: placeholderAccount, permission: 'draft', purpose: 'Alert the store owner about inventory problems that need a person', tasks: ['needs_person_alert'],
      recipients: { addresses: notify ? [notify] : [], domains: [] }, notify: notify ? [notify] : [], limits: { perRun: 5, perDay: 10 }, maxRecipientsPerMessage: 3 },
  }
  if (key === 'competitor_watcher') {
    const c = input.competitor ?? {}
    const list = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [])
    return {
      connectionId: input.connectionId, productScope: { mode: 'all' }, approvalMode: 'draft', validUntil: null, correctionTypes: [], rules: {}, watch: [],
      schedule: c.everyHours && c.everyHours >= 6 ? { kind: 'interval', everyHours: Math.min(168, Math.round(c.everyHours)) } : { kind: 'daily', hour: 6, minute: 30, timezone: input.timezone },
      competitor: {
        stores: (Array.isArray(c.stores) ? c.stores : []).map(st => ({ url: String(st?.url ?? ''), label: st?.label ? String(st.label) : undefined, bestsellerCollection: st?.bestsellerCollection ? String(st.bestsellerCollection) : null })),
        keywords: list(c.keywords), categories: list(c.categories), region: c.region || null, currency: c.currency || null,
        ...(c.alerts && typeof c.alerts === 'object' ? { alerts: c.alerts } : {}),
      },
      // alerts are optional; when wanted they start as drafts to the merchant's own address
      ...(notify ? { email: { accountId: placeholderAccount, permission: 'draft', purpose: 'Tell the store owner about meaningful changes at the competitor stores they follow', tasks: ['competitor_alert'],
        recipients: { addresses: [notify], domains: [] }, notify: [notify], limits: { perRun: 1, perDay: 2 }, maxRecipientsPerMessage: 2 } } : {}),
    }
  }
  if (key === 'supplier_chaser') return {
    ...base, correctionTypes: [], rules: {}, watch: [],
    schedule: { kind: 'daily', hour: 8, minute: 0, timezone: input.timezone },
    email: { accountId: placeholderAccount, permission: 'draft', purpose: 'Ask the supplier to confirm restock of low-stock products, and follow up once', tasks: ['supplier_reorder', 'supplier_followup'],
      recipients: { addresses: supplier ? [supplier] : [], domains: [] }, notify: [], limits: { perRun: 5, perDay: 10 }, maxRecipientsPerMessage: 2,
      supplierReorder: supplier ? { supplierAddress: supplier, thresholdAvailable: 2, cooldownDays: 7, followupDays: 3 } : undefined,
      read: { enabled: true, scope: 'replies_to_agent_messages' } },
  }
  return {
    ...base, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: EXEMPT, flagInStockVariants: true } }, watch: [OVERSOLD_WATCH],
    schedule: { kind: 'interval', everyHours: 168 },
    email: { accountId: placeholderAccount, permission: 'draft', purpose: 'Send the store owner a weekly store health report', tasks: ['run_report'],
      recipients: { addresses: notify ? [notify] : [], domains: [] }, notify: notify ? [notify] : [], limits: { perRun: 2, perDay: 2 }, maxRecipientsPerMessage: 3 },
  }
}
