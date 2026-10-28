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
