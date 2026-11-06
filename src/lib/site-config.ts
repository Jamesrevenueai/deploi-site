/**
 * The website's commercial facts in one place: the core message, pilot pricing and every integration's honest
 * status. Change prices or statuses here only; every page reads this file.
 *
 * Integration honesty rule (tested in src/__tests__/site.test.tsx): an integration is shown as Available only
 * when it is listed in LIVE_VERIFIED, which means a live workflow was tested against the real service. Until
 * then the best it can be is Pilot.
 */
export const CORE_MESSAGE = 'Your business has unfinished work. Deploi finds it, handles it, and shows you what got done.'
export const CORE_HEADLINE = 'Your business has unfinished work.'
export const CORE_SUBLINE = 'Deploi finds it, handles it, and shows you what got done.'

// ---------------------------------------------------------------- pricing (pilot hypotheses)

export type Plan = { key: string; name: string; price: number; from: boolean; suite: string; summary: string; includes: string[] }
export const PRICING_LABEL = 'Pilot pricing'
export const PRICING_NOTE = 'Final pricing confirmed at pilot start.'
export const PLANS: Plan[] = [
  { key: 'office_starter', name: 'Office Starter', price: 149, from: false, suite: 'Deploi Office', summary: 'Follow-up and scheduling for a small team.',
    includes: ['Lead follow-up from your CRM', 'Meeting scheduling on your calendar', 'CRM notes after each step', 'Approvals inbox and work history'] },
  { key: 'commerce_operations', name: 'Commerce Operations', price: 299, from: false, suite: 'Deploi Commerce', summary: 'Store health, stock and supplier work for one store.',
    includes: ['Store health and stock checks', 'Supplier follow-up on open orders', 'Approved fixes, verified by a fresh read', 'Approvals inbox and work history'] },
  { key: 'business_workforce', name: 'Business Workforce', price: 499, from: true, suite: 'Deploi Office + Deploi Commerce', summary: 'Both suites for a business that runs a store and a sales team.',
    includes: ['Everything in Office Starter and Commerce Operations', 'One team across store, inbox, CRM and calendar', 'Business Insights across both suites', 'Pilot support while you set up'] },
]
export const priceLabel = (p: Plan) => `${p.from ? 'from ' : ''}$${p.price}/mo`
/** "Pilot pricing — Office Starter $149/mo, Commerce Operations $299/mo, Business Workforce from $499/mo — final pricing confirmed at pilot start" */
export const PRICING_LINE = `${PRICING_LABEL} — ${PLANS.map(p => `${p.name} ${priceLabel(p)}`).join(', ')} — final pricing confirmed at pilot start`

// ---------------------------------------------------------------- integrations

export type IntegrationStatus = 'available' | 'pilot' | 'planned'
export type IntegrationEntry = { key: string; name: string; group: 'Commerce' | 'Email' | 'CRM' | 'Calendar' | 'Accounting' | 'Messaging'; status: IntegrationStatus; use: string }

/** Integrations with a live workflow tested against the real service. Empty today: nothing is claimed as Available. */
export const LIVE_VERIFIED: readonly string[] = []

export const INTEGRATIONS: IntegrationEntry[] = [
  { key: 'shopify', name: 'Shopify', group: 'Commerce', status: 'pilot', use: 'Read products, stock and listings; make the fixes you approve.' },
  { key: 'woocommerce', name: 'WooCommerce', group: 'Commerce', status: 'pilot', use: 'Read products and stock; make the fixes you approve.' },
  { key: 'deploi_email', name: 'Deploi Email', group: 'Email', status: 'pilot', use: 'An agent mailbox your team writes from; every message approved or within limits you set.' },
  { key: 'hubspot', name: 'HubSpot', group: 'CRM', status: 'pilot', use: 'Read leads and deals; write the notes and stages you allow.' },
  { key: 'google_calendar', name: 'Google Calendar', group: 'Calendar', status: 'pilot', use: 'Find free times and book the meetings you approve.' },
  { key: 'quickbooks', name: 'QuickBooks', group: 'Accounting', status: 'pilot', use: 'Read open invoices for receivables follow-up.' },
  { key: 'outlook', name: 'Outlook', group: 'Email', status: 'planned', use: 'Mail and calendar for Microsoft 365 businesses.' },
  { key: 'gmail', name: 'Gmail', group: 'Email', status: 'planned', use: 'Read and send from your own Google mailbox.' },
  { key: 'pipedrive', name: 'Pipedrive', group: 'CRM', status: 'planned', use: 'Lead and deal follow-up.' },
  { key: 'salesforce', name: 'Salesforce', group: 'CRM', status: 'planned', use: 'Lead and opportunity follow-up.' },
  { key: 'xero', name: 'Xero', group: 'Accounting', status: 'planned', use: 'Receivables follow-up.' },
  { key: 'slack', name: 'Slack', group: 'Messaging', status: 'planned', use: 'Approvals and alerts where your team already talks.' },
  { key: 'amazon', name: 'Amazon Seller Central', group: 'Commerce', status: 'planned', use: 'Listing and stock checks.' },
]

/** The status the site shows: Available only with a live-verified workflow; anything else claiming Available is shown as Pilot. */
export function shownStatus(i: Pick<IntegrationEntry, 'key' | 'status'>): IntegrationStatus {
  if (i.status === 'available') return LIVE_VERIFIED.includes(i.key) ? 'available' : 'pilot'
  return i.status
}
export const STATUS_WORDS: Record<IntegrationStatus, { label: string; meaning: string }> = {
  available: { label: 'Available', meaning: 'A live workflow was tested against the real service. Anyone can connect it.' },
  pilot: { label: 'Pilot', meaning: 'Built and tested against test accounts. Offered to pilot customers and set up with us.' },
  planned: { label: 'Planned', meaning: 'Not built yet. Listed so you know what is coming.' },
}
export const integrationsBy = (s: IntegrationStatus) => INTEGRATIONS.filter(i => shownStatus(i) === s)
