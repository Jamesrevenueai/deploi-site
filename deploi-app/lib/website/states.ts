/**
 * Website Improvement workflow (phase 16). Pure: states, transition table, gates, labor budget,
 * target date and contribution. The server-side enforcement lives in ./transition.ts.
 * No assessment and no credit anywhere in this workflow: it is a standalone $500 one-time service.
 */
import { getPricing } from '../catalog/pricing'

export const STATUSES = [
  'inquiry', 'scope_confirmed', 'accepted', 'payment_confirmed', 'access_received', 'improving',
  'preview_ready', 'customer_approved', 'published', 'completed', 'cancelled',
] as const
export type Status = typeof STATUSES[number]
export const isStatus = (s: unknown): s is Status => typeof s === 'string' && (STATUSES as readonly string[]).includes(s)

export const STATUS_LABEL: Record<Status, string> = {
  inquiry: 'Inquiry', scope_confirmed: 'Scope confirmed', accepted: 'Accepted', payment_confirmed: 'Payment confirmed',
  access_received: 'Access received', improving: 'Improving', preview_ready: 'Preview ready', customer_approved: 'Customer approved',
  published: 'Published', completed: 'Completed', cancelled: 'Cancelled',
}

/** The linear workflow, plus cancel from any open state. */
export const TRANSITIONS: Record<Status, Status[]> = {
  inquiry: ['scope_confirmed', 'cancelled'],
  scope_confirmed: ['accepted', 'cancelled'],
  accepted: ['payment_confirmed', 'cancelled'],
  payment_confirmed: ['access_received', 'cancelled'],
  access_received: ['improving', 'cancelled'],
  improving: ['preview_ready', 'cancelled'],
  preview_ready: ['customer_approved', 'improving', 'cancelled'],   // back to improving = a revision round
  customer_approved: ['published', 'cancelled'],
  published: ['completed'],
  completed: [],
  cancelled: [],
}
export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to)
export const isTerminal = (s: Status) => TRANSITIONS[s].length === 0

export const ACCESS_STATUSES = ['have_login', 'need_to_find', 'agency_managed', 'unknown'] as const
export type AccessStatus = typeof ACCESS_STATUSES[number]
export const ACCESS_LABEL: Record<AccessStatus, string> = { have_login: 'Has editor login', need_to_find: 'Needs to find access', agency_managed: 'Managed by an agency', unknown: 'Unknown' }

export const PAYMENT_STATUSES = ['unpaid', 'mock_paid', 'paid', 'refunded'] as const
export type PaymentStatus = typeof PAYMENT_STATUSES[number]

export const LABOR_KINDS = ['review', 'implementation', 'testing', 'revision', 'handoff'] as const
export type LaborKind = typeof LABOR_KINDS[number]

export const FEASIBILITY = ['unconfirmed', 'feasible', 'not_feasible'] as const
export type Feasibility = typeof FEASIBILITY[number]

export const MAX_PAGES = 3

export type Evidence = Record<string, unknown> | null
export type Engagement = {
  id: string; prospect_id: string | null; agency_id: string | null; status: Status
  website_url: string | null; platform: string | null; goal: string | null; pages: string[]
  requested_changes: string | null; known_issues: string | null
  access_status: AccessStatus; access_arrangement: string | null; approval_contact: string | null
  feasibility: { status?: Feasibility; note?: string; confirmed_at?: string; confirmed_by?: string }
  price_cents: number; payment_status: PaymentStatus; payment_is_mock: boolean; paid_at: string | null
  scope_confirmed_at: string | null; accepted_at: string | null; acceptance_evidence: Evidence
  access_received_at: string | null; content_received_at: string | null
  preview_url: string | null; preview_ready_at: string | null
  customer_approved_at: string | null; customer_approval_evidence: Evidence
  published_at: string | null; publication_verified_at: string | null; publication_verification: Evidence
  backup_plan: string | null; rollback_note: string | null; handoff_summary: string | null
  before_after: { page: string; before_ref: string; after_ref: string; note?: string }[]
  approved_changes: string[]
  revision_round: number; revision_status: string | null; target_date: string | null
  maintenance_requested: boolean; created_at: string; updated_at: string
}

export type Gate = { ok: true } | { ok: false; reason: string }
const blocked = (reason: string): Gate => ({ ok: false, reason })
const has = (v: unknown) => typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined
const nonEmptyObject = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v as object).length > 0

/** Server-side gate for a transition. Pure so it is unit-testable; the table check comes first. */
export function gateFor(e: Engagement, to: Status): Gate {
  if (!canTransition(e.status, to)) return blocked(`Cannot move from ${STATUS_LABEL[e.status]} to ${STATUS_LABEL[to]}.`)
  switch (to) {
    case 'scope_confirmed':
      if (!e.pages?.length) return blocked('Add at least one page (up to three) before confirming scope.')
      if (!has(e.requested_changes)) return blocked('Record the requested changes before confirming scope.')
      return { ok: true }
    case 'accepted':
      if (!e.scope_confirmed_at) return blocked('Scope must be confirmed first.')
      if (!nonEmptyObject(e.acceptance_evidence)) return blocked('Record acceptance evidence (who accepted, how, when).')
      return { ok: true }
    case 'payment_confirmed':
      if (e.feasibility?.status !== 'feasible') return blocked('Confirm feasibility before accepting payment.')
      if (e.payment_status === 'mock_paid' || e.payment_is_mock) return blocked('Only a real payment satisfies this gate. The mock payment (simulated) is visible but never counts.')
      if (e.payment_status !== 'paid') return blocked('Record the payment first (payment status must be paid).')
      return { ok: true }
    case 'access_received':
      if (e.access_status !== 'have_login' && e.access_status !== 'agency_managed') return blocked('Access status must be "has editor login" or "managed by an agency".')
      if (!has(e.access_arrangement)) return blocked('Describe the approved access arrangement (e.g. "invited as editor"); never a password.')
      return { ok: true }
    case 'improving':
      if (!has(e.backup_plan)) return blocked('Record the backup or rollback plan before changing anything.')
      return { ok: true }
    case 'preview_ready':
      if (!has(e.preview_url) && !has(e.rollback_note)) return blocked('Add a preview URL, or a note that the platform has no staging (direct edit with rollback note).')
      return { ok: true }
    case 'customer_approved':
      if (!nonEmptyObject(e.customer_approval_evidence)) return blocked('Record customer approval evidence (method, reference, approved by, when).')
      return { ok: true }
    case 'published':
      if (!e.customer_approved_at || !nonEmptyObject(e.customer_approval_evidence)) return blocked('Publication without customer approval evidence is refused.')
      return { ok: true }
    case 'completed':
      if (!nonEmptyObject(e.publication_verification)) return blocked('Record the publication verification (checked URLs) first.')
      if (!has(e.handoff_summary)) return blocked('Write the handoff summary first.')
      return { ok: true }
    case 'cancelled':
    default:
      return { ok: true }
  }
}

/** Legal next steps with their gate result, for the page's transition buttons. */
export function nextSteps(e: Engagement) {
  return TRANSITIONS[e.status].map(to => ({ to, label: STATUS_LABEL[to], gate: gateFor(e, to) }))
}

// ---------------------------------------------------------------- labor budget
export const BUDGET_BLOCK_TEXT = 'Budget reached: agree a smaller scope or quote additional work before proceeding.'
export const BUDGET_WARN_TEXT = 'Approaching the five-hour budget.'
export type BudgetLevel = 'ok' | 'warn' | 'blocked'
export type Budget = { hours: number; budget: number; pct: number; level: BudgetLevel; message: string | null }

/** Warning at 80%, blocker note at 100%. Never reduces scope silently. */
export function laborBudget(hours: number, budget = getPricing().website.hoursBudget): Budget {
  const pct = budget > 0 ? Math.round((hours / budget) * 100) : 0
  const level: BudgetLevel = pct >= 100 ? 'blocked' : pct >= 80 ? 'warn' : 'ok'
  return { hours, budget, pct, level, message: level === 'blocked' ? BUDGET_BLOCK_TEXT : level === 'warn' ? BUDGET_WARN_TEXT : null }
}
export const sumHours = (rows: { hours: number | string }[]) => Math.round(rows.reduce((a, r) => a + Number(r.hours), 0) * 100) / 100

// ---------------------------------------------------------------- target date
const toDate = (v: string | Date | null | undefined) => (v ? new Date(v) : null)
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/** Adds n business days (Mon–Fri) to a date, counting from the next business day; UTC calendar. */
export function addBusinessDays(start: Date, n: number): Date {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
  let left = n
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) left--
  }
  return d
}

/** Target = N business days after the later of paid_at / access_received_at / content_received_at. Null until all three exist. A target, not a guarantee. */
export function targetDate(e: Pick<Engagement, 'paid_at' | 'access_received_at' | 'content_received_at'>, businessDays = getPricing().website.targetBusinessDays): string | null {
  const parts = [toDate(e.paid_at), toDate(e.access_received_at), toDate(e.content_received_at)]
  if (parts.some(p => !p)) return null
  const latest = new Date(Math.max(...parts.map(p => p!.getTime())))
  return ymd(addBusinessDays(latest, businessDays))
}

// ---------------------------------------------------------------- economics (internal only; never shown to clients)
export type Contribution = { price_cents: number; hours: number; rate_cents: number | null; cost_cents: number | null; contribution_cents: number | null }
export function contribution(priceCents: number, hours: number, rateCents: number | null): Contribution {
  if (rateCents === null) return { price_cents: priceCents, hours, rate_cents: null, cost_cents: null, contribution_cents: null }
  const cost = Math.round(hours * rateCents)
  return { price_cents: priceCents, hours, rate_cents: rateCents, cost_cents: cost, contribution_cents: priceCents - cost }
}

export const websitePriceCents = () => Math.round(getPricing().website.price * 100)
export const moneyCents = (c: number) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: c % 100 ? 2 : 0 })
export const NO_CREDIT_TEXT = 'Website Improvement is a standalone one-time service. Its fee is never credited toward an assessment, a build or monthly management.'
export const MAINTENANCE_TEXT = 'Maintenance requested is a note only: nothing is created automatically. Ongoing maintenance needs a separate scope and quote.'
export const TARGET_TEXT = 'Target completion is five business days after payment, access and content are all in hand. It is a target, not a guarantee.'
