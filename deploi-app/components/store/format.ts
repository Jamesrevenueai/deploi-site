/** Turn engine values into merchant words. Nothing here prints raw JSON. */
import type { Outcome } from '@/lib/engine/outcomes'

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'none'

export const OUTCOME_TONE: Record<Outcome, Tone> = { verified: 'ok', failed: 'danger', blocked: 'warn', pending: 'muted', closed: 'muted' }
export const SEVERITY_TONE: Record<string, Tone> = { high: 'danger', medium: 'warn', low: 'muted' }
export const SEVERITY_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' }
export const ISSUE_STATUS_LABEL: Record<string, string> = { open: 'Open', needs_review: 'Needs review', resolved: 'Resolved', dismissed: 'Acknowledged' }
export const RESOLUTION_LABEL: Record<string, string> = {
  verified_fix: 'Changed by Deploi and verified', no_longer_detected: 'No longer detected', dismissed_by_merchant: 'Acknowledged by you',
}
export const PLATFORM_LABEL: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', amazon: 'Amazon Seller Central' }
export const PRODUCT_STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived' }
export const CONNECTION_STATUS_LABEL: Record<string, string> = { active: 'Connected', pending: 'Installing', uninstalled: 'Uninstalled', error: 'Connection error', disconnected: 'Disconnected' }

const dtf = () => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dtfYear = () => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return (d.getFullYear() === new Date().getFullYear() ? dtf() : dtfYear()).format(d)
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 0) return fmtTime(iso)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return fmtTime(iso)
}

/** An expiry in the future, in words */
export function fmtUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return `expired ${fmtTime(iso)}`
  const h = Math.floor(ms / 3600e3)
  if (h >= 24) return `${fmtTime(iso)} (in ${Math.floor(h / 24)} d ${h % 24} h)`
  if (h >= 1) return `${fmtTime(iso)} (in ${h} h)`
  return `${fmtTime(iso)} (in ${Math.max(1, Math.round(ms / 60e3))} min)`
}

const FIELD_LABEL: Record<string, string> = {
  inventoryPolicy: 'Continue selling when out of stock',
  tracked: 'Inventory tracked',
  productStatus: 'Product status',
  productId: 'Product',
  published: 'Published on the sales channel',
  price: 'Price',
  compareAtPrice: 'Compare-at price',
  sku: 'SKU',
}

/** A single value from a record, in merchant words for the field it belongs to */
export function fmtValue(field: string, v: unknown): string {
  if (field === 'inventoryPolicy') return v === 'CONTINUE' ? 'On' : v === 'DENY' ? 'Off' : v == null ? 'unknown' : String(v)
  if (field === 'productStatus' && typeof v === 'string') return PRODUCT_STATUS_LABEL[v] ?? v
  if (field === 'productId' && typeof v === 'string') return shortId(v)
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (v === null || v === undefined) return 'none'
  if (Array.isArray(v)) return v.length ? v.map(x => String(x)).join(', ') : 'none'
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${fmtValue(k, x)}`).join(', ')
  return String(v)
}

export function fieldLabel(field: string): string { return FIELD_LABEL[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()) }

/** "Continue selling when out of stock: On → Off" */
export function changeInWords(change: { field: string; from: unknown; to: unknown }): { label: string; from: string; to: string } {
  return { label: fieldLabel(change.field), from: fmtValue(change.field, change.from), to: fmtValue(change.field, change.to) }
}

/** gid://shopify/ProductVariant/2001 → Variant 2001 */
export function shortId(gid: string): string {
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(gid)
  if (!m) return gid
  const kind = m[1] === 'ProductVariant' ? 'Variant' : m[1] === 'InventoryItem' ? 'Inventory item' : m[1]
  return `${kind} ${m[2]}`
}

export const INVENTORY_POLICY_WORDS: Record<string, string> = { CONTINUE: 'Continue selling when out of stock', DENY: 'Stop selling when out of stock' }

export function planLabel(s: { provider: string; plan_key: string; status: string; is_test: boolean }): string {
  const plan = s.plan_key === 'early_access' ? 'Early access' : s.plan_key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
  const provider = s.provider === 'early_access' ? 'Deploi' : s.provider === 'shopify' ? 'Shopify billing' : s.provider.replace(/_/g, ' ')
  const status = s.status === 'active' ? 'active' : s.status.replace(/_/g, ' ')
  return `${plan} · ${provider} · ${status}${s.is_test ? ' · test' : ''}`
}

/** Audit event names in words */
export function eventLabel(event: string): string {
  const map: Record<string, string> = {
    'issue.detected': 'Issue detected', 'issue.resolved': 'Issue resolved', 'issue.dismissed': 'Acknowledged', 'issue.exempted': 'Product exempted',
    'issue.loop_guard': 'Changed back after a verified change; waiting for review', 'issue.guard_cleared': 'You allowed a new proposal',
    'proposal.created': 'Change proposed', 'proposal.superseded': 'Proposal replaced', 'proposal.stale': 'Proposal no longer valid', 'proposal.expired': 'Proposal expired',
    'proposal.dismissed': 'Proposal withdrawn', 'proposal.blocked': 'Proposal blocked',
    'approval.granted': 'Approved', 'approval.refused': 'Approval refused',
    'execution.started': 'Run started', 'execution.retry': 'Retry started', 'execution.applied': 'Store accepted the write', 'execution.unknown': 'No definite answer from the store',
    'execution.verified': 'Verified by a fresh read', 'execution.failed': 'Failed', 'execution.verification_failed': 'Fresh read does not show the change',
    'execution.blocked': 'Blocked before writing', 'execution.stale': 'Not run: records changed',
  }
  return map[event] ?? event.replace(/[._]/g, ' ')
}

/** user:owner@x.example → owner@x.example; shopify:shop:user:1 → Shopify staff user 1 */
export function actorLabel(a: string | null | undefined): string {
  if (!a) return '—'
  if (a.startsWith('user:')) return a.slice(5)
  if (a.startsWith('staff:')) return `Deploi staff (${a.slice(6)})`
  const m = /^shopify:([^:]+):user:(.+)$/.exec(a)
  if (m) return `Shopify user ${m[2]}`
  if (a.startsWith('system:')) return 'Deploi (automatic)'
  if (a.startsWith('seed:')) return 'Setup'
  return a
}

// ---------------------------------------------------------------- agents

/**
 * Merchant-facing labels for an agent's work. Only "Verified" means done: a fresh read of the store
 * shows the change. Anything the store accepted but Deploi has not confirmed is "Unconfirmed".
 */
export type StatusWords = { label: string; tone: Tone; hint: string }

export const EXECUTION_STATUS_WORDS: Record<string, StatusWords> = {
  queued: { label: 'Queued', tone: 'muted', hint: 'Approved and waiting to run. Pausing or revoking the agent cancels it.' },
  prechecking: { label: 'Running', tone: 'muted', hint: 'Re-reading the record before writing.' },
  executing: { label: 'Running', tone: 'muted', hint: 'Writing the change.' },
  applied: { label: 'Unconfirmed (checking)', tone: 'warn', hint: 'The store accepted the write; Deploi has not confirmed it with a fresh read yet.' },
  unknown: { label: 'Unconfirmed (checking)', tone: 'warn', hint: 'No definite answer from the store; Deploi checks the record before trying again.' },
  verified: { label: 'Verified', tone: 'ok', hint: 'A fresh read of the store shows the change.' },
  failed: { label: 'Failed', tone: 'danger', hint: 'The store refused the change.' },
  verification_failed: { label: 'Failed', tone: 'danger', hint: 'The store accepted the write, but a fresh read does not show the change.' },
  blocked: { label: 'Blocked', tone: 'warn', hint: 'Not attempted: something made it unsafe or not allowed. Nothing was written.' },
  stale: { label: 'Stale (records changed)', tone: 'warn', hint: 'Not run: the record changed after the change was proposed. Nothing was written.' },
}

export const PROPOSAL_STATUS_WORDS: Record<string, StatusWords> = {
  pending_approval: { label: 'Awaiting approval', tone: 'none', hint: 'Waiting for you to approve this exact change.' },
  approved: { label: 'Queued', tone: 'muted', hint: 'Approved and waiting to run.' },
  executing: EXECUTION_STATUS_WORDS.executing,
  applied: EXECUTION_STATUS_WORDS.applied,
  verified: EXECUTION_STATUS_WORDS.verified,
  failed: EXECUTION_STATUS_WORDS.failed,
  blocked: EXECUTION_STATUS_WORDS.blocked,
  stale: EXECUTION_STATUS_WORDS.stale,
  expired: { label: 'Expired', tone: 'muted', hint: 'Not approved in time. The next run proposes it again if it is still needed.' },
  dismissed: { label: 'Withdrawn', tone: 'muted', hint: 'Withdrawn without changing the store.' },
  superseded: { label: 'Replaced', tone: 'muted', hint: 'Replaced by a newer proposal.' },
}

const unknownWords = (s: string): StatusWords => ({ label: s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), tone: 'muted', hint: '' })
export const executionWords = (status: string): StatusWords => EXECUTION_STATUS_WORDS[status] ?? unknownWords(status)
export const proposalWords = (status: string): StatusWords => PROPOSAL_STATUS_WORDS[status] ?? unknownWords(status)

export const AGENT_STATUS_WORDS: Record<string, StatusWords> = {
  draft: { label: 'Draft', tone: 'muted', hint: 'Not authorized yet. It cannot read or change anything until you grant its authorization.' },
  active: { label: 'Active', tone: 'ok', hint: 'Authorized. It runs on its schedule or when you press Run now.' },
  paused: { label: 'Paused', tone: 'warn', hint: 'Paused. It does not run or write anything, including changes already queued.' },
  revoked: { label: 'Revoked', tone: 'danger', hint: 'Authorization revoked. It writes nothing until you review and grant a new authorization.' },
  deleted: { label: 'Deleted', tone: 'muted', hint: '' },
}
export const agentWords = (status: string): StatusWords => AGENT_STATUS_WORDS[status] ?? unknownWords(status)

export const RUN_STATUS_WORDS: Record<string, StatusWords> = {
  running: { label: 'Running', tone: 'muted', hint: '' },
  completed: { label: 'Completed', tone: 'none', hint: 'The run finished. Each change has its own outcome below.' },
  failed: { label: 'Failed', tone: 'danger', hint: '' },
  blocked: { label: 'Blocked', tone: 'warn', hint: '' },
}
export const runWords = (status: string): StatusWords => RUN_STATUS_WORDS[status] ?? unknownWords(status)

/** Kept in step with CORRECTION_TYPES / CORRECTION_LABEL in lib/agents/policy.ts (that module is server-only). */
export const AGENT_CORRECTION_TYPES = ['oversell_policy', 'publication', 'price', 'sku'] as const
export type AgentCorrectionType = typeof AGENT_CORRECTION_TYPES[number]
export const AGENT_CORRECTION_LABEL: Record<string, string> = {
  oversell_policy: 'Overselling configuration',
  publication: 'Product publication',
  price: 'Prices',
  sku: 'SKUs',
}
export const AGENT_CORRECTION_HELP: Record<AgentCorrectionType, string> = {
  oversell_policy: 'Turns "Continue selling when out of stock" off on tracked variants that should stop selling at zero. Pre-order and backorder products are skipped.',
  publication: 'Publishes (and, if you allow it, unpublishes) active products on one sales channel to match your list or tag rule. Draft and archived products are reported, never changed.',
  price: 'Sets variant prices to match your price list, within the change limit you set. Never invents a price.',
  sku: 'Fills in (and, if you allow it, corrects) SKUs from your mapping when the match is unambiguous. Never generates a SKU.',
}

export const APPROVAL_MODE_LABEL: Record<string, string> = { draft: 'Drafts only', review: 'After my approval', autonomous: 'Without asking, within limits' }

/** Per-tool permission level in a few words, for badges ("Shopify: drafts only", "Email: after my approval"). */
export const EMAIL_PERMISSION_SHORT: Record<string, string> = { draft: 'drafts only', send_approved: 'after my approval', send_autonomous: 'without asking, within limits' }
export function toolBadges(p: { approvalMode?: string | null; correctionTypes?: string[]; emailPermission?: string | null }): string[] {
  const out: string[] = []
  if (p.approvalMode && p.correctionTypes?.length) out.push(`Shopify: ${(APPROVAL_MODE_LABEL[p.approvalMode] ?? p.approvalMode).toLowerCase()}`)
  if (p.emailPermission) out.push(`Email: ${EMAIL_PERMISSION_SHORT[p.emailPermission] ?? p.emailPermission}`)
  return out
}

export const TRIGGER_LABEL: Record<string, string> = { manual: 'Run now', schedule: 'Schedule', webhook: 'Store update', test: 'Test' }

type ScheduleLike = { kind: 'manual' } | { kind: 'interval'; everyHours: number } | { kind: 'daily'; hour: number; minute: number; timezone?: string }
const pad2 = (n: number) => String(n).padStart(2, '0')
export function scheduleLabel(s: unknown): string {
  const x = s as ScheduleLike | null
  if (!x || typeof x !== 'object') return 'Run manually'
  if (x.kind === 'interval') return `Every ${x.everyHours} hour${x.everyHours === 1 ? '' : 's'}`
  if (x.kind === 'daily') return `Daily at ${pad2(x.hour)}:${pad2(x.minute)}${x.timezone ? ` (${x.timezone})` : ''}`
  return 'Run manually'
}

export function referenceKindLabel(kind: string): string {
  return kind === 'price_list' ? 'Price list' : kind === 'sku_mapping' ? 'SKU mapping' : kind === 'publication_list' ? 'Publication list' : kind
}

// ---------------------------------------------------------------- email

/**
 * Merchant-facing labels for agent email. Providers only report that they accepted a message for
 * delivery, so "Accepted by provider" is the strongest status and the only one shown as success.
 * Nothing here says "Delivered" or "Sent successfully".
 */
export const EMAIL_ACCEPTED_EXPLAINER = 'The provider accepted it for delivery. Deploi cannot confirm it reached the inbox.'

export const EMAIL_STATUS_WORDS: Record<string, StatusWords> = {
  draft: { label: 'Draft', tone: 'muted', hint: 'A draft kept in Deploi. This agent may only draft: copy the text and send it yourself if you want to.' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'none', hint: 'Waiting for you to approve this exact message. Nothing is sent until you do.' },
  queued: { label: 'Queued', tone: 'muted', hint: 'Approved and waiting to be handed to the provider. Pausing or revoking the agent, or disconnecting the account, cancels it.' },
  sending: { label: 'Sending', tone: 'muted', hint: 'Being handed to the provider now.' },
  accepted: { label: 'Accepted by provider', tone: 'ok', hint: EMAIL_ACCEPTED_EXPLAINER },
  failed: { label: 'Failed', tone: 'danger', hint: 'The provider refused it or it could not be sent. Nothing was sent.' },
  delivery_unknown: { label: 'Delivery unknown', tone: 'warn', hint: 'The provider gave no definite answer, so this message may or may not have gone out. Deploi will not send it again on its own.' },
  cancelled: { label: 'Cancelled', tone: 'muted', hint: 'Not sent: declined, or cancelled because the agent was paused or revoked or the account was disconnected.' },
}
export const emailWords = (status: string): StatusWords => EMAIL_STATUS_WORDS[status] ?? unknownWords(status)

/** Kept in step with EMAIL_TASKS / EMAIL_TASK_LABEL / EMAIL_PERMISSIONS / EMAIL_PERMISSION_LABEL in lib/agents/policy.ts (server-only). */
export const AGENT_EMAIL_TASKS = ['run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup'] as const
export type AgentEmailTask = typeof AGENT_EMAIL_TASKS[number]
export const AGENT_EMAIL_TASK_LABEL: Record<AgentEmailTask, string> = {
  run_report: 'Send a summary of each run',
  needs_person_alert: 'Alert people about problems that need a person',
  supplier_reorder: 'Ask a supplier to confirm restock for low-stock products',
  supplier_followup: 'Follow up once, in the same thread, when a supplier has not replied',
}
export const AGENT_EMAIL_TASK_HELP: Record<AgentEmailTask, string> = {
  run_report: 'After each run, a short summary of what the agent found, changed and left for you goes to the people on the notify list.',
  needs_person_alert: 'When the agent finds a problem it cannot correct safely, the people on the notify list get one alert per problem.',
  supplier_reorder: 'Lists products in scope at or below your threshold and asks your supplier to confirm a restock. It never changes stock quantities and never places an order.',
  supplier_followup: 'One polite reminder in the same email thread when the supplier has not replied after the days you choose. Needs the restock task and permission to notice replies; never more than one follow-up per request.',
}
/** Short names for a message's task, in lists */
export const EMAIL_TASK_SHORT: Record<string, string> = { run_report: 'Run summary', needs_person_alert: 'Needs-a-person alert', supplier_reorder: 'Supplier restock request', supplier_followup: 'Supplier follow-up' }

export const AGENT_EMAIL_PERMISSIONS = ['draft', 'send_approved', 'send_autonomous'] as const
export type AgentEmailPermission = typeof AGENT_EMAIL_PERMISSIONS[number]
export const AGENT_EMAIL_PERMISSION_LABEL: Record<AgentEmailPermission, string> = {
  draft: 'Create drafts for review (never sends)',
  send_approved: 'Send messages you approve one by one',
  send_autonomous: 'Send without asking, within the recipients, purpose, limits and dates below',
}
export const AGENT_EMAIL_PERMISSION_HELP: Record<AgentEmailPermission, string> = {
  draft: 'Messages are written and kept in Deploi. Nothing is ever sent from your account; you can copy the text.',
  send_approved: 'Each message waits until you have read the exact sender, recipients, subject, body and attachments and approved it.',
  send_autonomous: 'Messages to allowed recipients, within the limits and before the end date, are sent without asking. Anything outside those boundaries waits for your approval.',
}

/** Health of a connected email account */
export const EMAIL_ACCOUNT_STATUS_WORDS: Record<string, StatusWords> = {
  active: { label: 'Connected', tone: 'ok', hint: 'The provider accepted the last check.' },
  needs_reauth: { label: 'Needs reconnect', tone: 'warn', hint: 'The provider no longer accepts this connection. Reconnect to keep sending.' },
  error: { label: 'Error', tone: 'danger', hint: 'The account cannot send right now.' },
  disconnected: { label: 'Disconnected', tone: 'muted', hint: 'Disconnected. Its tokens were deleted.' },
}
export const emailAccountWords = (status: string): StatusWords => EMAIL_ACCOUNT_STATUS_WORDS[status] ?? unknownWords(status)

/** Provider availability, labelled honestly */
export const EMAIL_PROVIDER_STATUS_WORDS: Record<string, StatusWords> = {
  configured_unverified: { label: 'Available', tone: 'warn', hint: 'Available: not yet verified by the provider for public use' },
  not_configured: { label: 'Not available yet', tone: 'muted', hint: 'Not available yet (needs setup)' },
  test_only: { label: 'Test only', tone: 'warn', hint: 'Synthetic mailbox: test only, nothing is ever emailed' },
}

/** Plain-language task statuses: honest, and "Done" only with a finished run as proof */
export const TASK_STATUS_WORDS: Record<string, StatusWords> = {
  queued: { label: 'Queued', tone: 'muted', hint: 'Within the rules; it runs when the agent is active.' },
  running: { label: 'Running', tone: 'muted', hint: 'Running now.' },
  done: { label: 'Done', tone: 'ok', hint: 'Finished, with the run as proof.' },
  waiting_on_you: { label: 'Waiting on you', tone: 'warn', hint: 'The run finished, and items wait for you.' },
  needs_approval: { label: 'Needs your approval', tone: 'warn', hint: "Outside the agent's rules: widening them needs a new grant." },
  refused: { label: 'Refused', tone: 'danger', hint: 'Nothing will run.' },
  failed: { label: 'Failed', tone: 'danger', hint: 'The run did not finish cleanly.' },
  cancelled: { label: 'Cancelled', tone: 'muted', hint: 'Cancelled before it ran.' },
}
export const taskWords = (s: string): StatusWords => TASK_STATUS_WORDS[s] ?? unknownWords(s)
export const INBOUND_CLASS_LABEL: Record<string, string> = { reply: 'Reply', merchant_forward: 'Forwarded by you', merchant_cc: 'Copied by you', other: 'Other sender' }
