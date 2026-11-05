/**
 * Pure shaping of Resolution Engine data for the customer screens (Home, Work in Progress, Needs My Approval,
 * Completed Work, the case page). No fetching and no React here, so every rule is unit-tested
 * (tests/cx/work-view.test.ts). Nothing is invented: a value the APIs did not return stays null and the
 * screens show an empty state for it.
 */
import type { CaseStatus, CaseView, Priority } from '@/lib/cases'
import { CASE_VIEWS } from '@/lib/store/nav'

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'info' | 'none'

/** The browser's view of a case row (GET /api/store/cases, /api/store/cases/[id]). */
export type CaseEvidence = { label: string; source: string; observedAt: string; detail?: Record<string, unknown>; ref?: { type: string; id: string } }
export type CaseItem = {
  id: string; ref: string; suite: 'commerce' | 'office'; kind: string; source_app: string
  title: string; problem: string; why_it_matters: string | null; priority: Priority; status: CaseStatus; status_reason: string | null
  agent_kind: 'engine' | 'office' | 'library' | null; agent_ref: string | null; next_action: string | null; approval_required: boolean
  next_check_at: string | null; deadline_at: string | null; verification: { criteria?: string; rule?: Record<string, unknown> }
  outcome: { summary: string; evidence: CaseEvidence[]; verifiedBy: string; verifiedAt: string } | null
  evidence: CaseEvidence[]; records: { type: string; id: string; label?: string }[]; attempts: number; opened_at: string; closed_at: string | null; updated_at: string
}
export type CaseEventItem = { id: string; at: string; actor: string; type: string; from_status: string | null; to_status: string | null; summary: string; detail: Record<string, unknown>; ref_type: string | null; ref_id: string | null }
export type CaseCounts = { in_progress: number; needs_approval: number; completed: number; attention: number; total: number; resolved_30d: number }
export type CasesResponse = { ok: true; cases: CaseItem[]; counts: CaseCounts }
export type CaseResponse = { ok: true; case: CaseItem; events: CaseEventItem[]
  /** set when you may close this case yourself (restock requests, market signals, library work): never a resolution */
  close?: { label: string; needsReason: boolean } | null }

/** An item from the unified approvals API (GET /api/store/approvals). */
export type ApprovalEntry = {
  source: string; id: string; orgId: string; kind: string; title: string; agent: { id: string | null; name: string | null } | null
  createdAt: string; expiresAt: string | null; version: string; decisions: ('approve' | 'reject')[]; why: string | null; content: Record<string, unknown>
}
export type ApprovalsResponse = { ok: true; items: ApprovalEntry[]; errors: { source: string; message: string }[]; sources: { key: string; label: string }[] }

export const STATUS_WORDS: Record<CaseStatus, { label: string; tone: Tone; stage: 'found' | 'working' | 'waiting_you' | 'waiting_others' | 'checking' | 'done' | 'attention' }> = {
  detected: { label: 'Discovered', tone: 'info', stage: 'found' },
  investigating: { label: 'Looking into it', tone: 'info', stage: 'working' },
  proposed: { label: 'Fix proposed', tone: 'info', stage: 'working' },
  awaiting_approval: { label: 'Needs your approval', tone: 'warn', stage: 'waiting_you' },
  executing: { label: 'Being handled', tone: 'info', stage: 'working' },
  waiting_external: { label: 'Waiting on a reply', tone: 'muted', stage: 'waiting_others' },
  verifying: { label: 'Checking the result', tone: 'info', stage: 'checking' },
  resolved: { label: 'Resolved and verified', tone: 'ok', stage: 'done' },
  blocked: { label: 'Blocked', tone: 'danger', stage: 'attention' },
  failed: { label: 'Did not work', tone: 'danger', stage: 'attention' },
  cancelled: { label: 'Cancelled', tone: 'muted', stage: 'done' },
  escalated: { label: 'Needs a person', tone: 'warn', stage: 'attention' },
}
export const PRIORITY_WORDS: Record<Priority, { label: string; tone: Tone }> = {
  urgent: { label: 'Urgent', tone: 'danger' }, high: { label: 'High', tone: 'warn' }, normal: { label: 'Normal', tone: 'muted' }, low: { label: 'Low', tone: 'muted' },
}
const SOURCE_APP: Record<string, string> = {
  shopify: 'Shopify', woocommerce: 'WooCommerce', hubspot: 'HubSpot', google_calendar: 'Google Calendar', quickbooks: 'QuickBooks', deploi_email: 'Deploi Email',
  outlook: 'Outlook', gmail: 'Gmail', import: 'Import', stripe: 'Stripe', public_web: 'Public web pages',
}
export const sourceAppLabel = (s: string) => SOURCE_APP[s] ?? humanize(s)
export const SUITE_LABEL = { commerce: 'Deploi Commerce', office: 'Deploi Office' } as const

/** "supplier_exception" -> "Supplier exception" */
export function humanize(s: string): string {
  const t = String(s ?? '').replace(/[_.-]+/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

/** The case views each customer page reads (lib/store/nav.ts). */
export const PAGE_VIEWS: Record<'work' | 'approvals' | 'completed', CaseView[]> = CASE_VIEWS

/** Merge several view responses into one list: no duplicates, attention first, then most recently updated. */
export function mergeCases(lists: CaseItem[][]): CaseItem[] {
  const seen = new Map<string, CaseItem>()
  for (const l of lists) for (const c of l) if (!seen.has(c.id)) seen.set(c.id, c)
  const rank = (c: CaseItem) => (STATUS_WORDS[c.status]?.stage === 'attention' ? 0 : c.priority === 'urgent' ? 1 : c.priority === 'high' ? 2 : 3)
  return [...seen.values()].sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at))
}

// ---------------------------------------------------------------- agents

export type AgentDirectory = { engine: Record<string, string>; office: Record<string, string>; library: Record<string, string> }
export const EMPTY_DIRECTORY: AgentDirectory = { engine: {}, office: {}, library: {} }

/** The agent that owns a case, in words; null when unassigned. */
export function agentLabel(dir: AgentDirectory, kind: CaseItem['agent_kind'], ref: string | null): { name: string; href: string | null } | null {
  if (!kind || !ref) return null
  if (kind === 'engine') return { name: dir.engine[ref] ?? 'Store agent', href: `/store/agents/${ref}` }
  if (kind === 'office') return { name: dir.office[ref] ?? 'Office agent', href: '/office/agents' }
  return { name: dir.library[ref] ?? humanize(ref), href: `/store/team/${ref}` }
}

export type TeamMember = { key: string; name: string; group: 'Store agents' | 'Office agents' | 'Agent library'; status: string; tone: Tone; detail: string; href: string }

/** One list of every agent the organization has: store (engine), Office and switched-on or unlocked library agents. */
export function teamMembers(input: {
  engine: { id: string; name: string; status: string; health?: string }[]
  office: { id: string; name: string; status: string; kind?: string }[] | null
  library: { key: string; name: string; enabled: boolean; locked: boolean; permission: string; waiting: number }[] | null
}): TeamMember[] {
  const out: TeamMember[] = []
  const tone = (s: string): Tone => (s === 'active' ? 'ok' : s === 'needs_attention' || s === 'draft' ? 'warn' : 'muted')
  const words: Record<string, string> = { active: 'Working', paused: 'Paused', draft: 'Waiting for your grant', needs_attention: 'Needs attention', revoked: 'Revoked', disabled: 'Off' }
  for (const a of input.engine) out.push({ key: `engine:${a.id}`, name: a.name, group: 'Store agents', status: words[a.health ?? a.status] ?? humanize(a.health ?? a.status), tone: tone(a.health ?? a.status), detail: 'Checks and fixes your store within what you granted', href: `/store/agents/${a.id}` })
  for (const a of input.office ?? []) out.push({ key: `office:${a.id}`, name: a.name, group: 'Office agents', status: words[a.status] ?? humanize(a.status), tone: tone(a.status), detail: a.kind ? humanize(a.kind) : 'Office agent', href: '/office/agents' })
  for (const a of input.library ?? []) {
    if (a.locked && !a.enabled) continue
    out.push({ key: `library:${a.key}`, name: a.name, group: 'Agent library', status: a.enabled ? 'On' : 'Off', tone: a.enabled ? 'ok' : 'muted', detail: `${a.permission === 'draft' ? 'Drafts only' : humanize(a.permission)}${a.waiting ? ` · ${a.waiting} waiting for you` : ''}`, href: `/store/team/${a.key}` })
  }
  return out
}

// ---------------------------------------------------------------- the case page

export type TimelineItem = { id: string; at: string; title: string; detail: string | null; tone: Tone; actor: string; type: string }

/** The case history in words, oldest first. Status changes name the new status; actions, evidence and verification keep their own summary. */
export function caseTimeline(events: CaseEventItem[]): TimelineItem[] {
  return events.map(e => {
    const to = e.to_status as CaseStatus | null
    let title = e.summary
    let tone: Tone = 'none'
    let detail: string | null = null
    if (e.type === 'opened') { title = 'Discovered'; detail = e.summary; tone = 'info' }
    else if (e.type === 'status' && to && STATUS_WORDS[to]) { title = STATUS_WORDS[to].label; detail = e.summary; tone = STATUS_WORDS[to].tone === 'none' ? 'info' : STATUS_WORDS[to].tone }
    else if (e.type === 'verification') { title = 'Verified'; detail = e.summary; tone = 'ok' }
    else if (e.type === 'action') { title = 'Action taken'; detail = e.summary; tone = 'info' }
    else if (e.type === 'evidence') { title = 'Evidence recorded'; detail = e.summary }
    else if (e.type === 'redetected') { title = 'Seen again'; detail = null }
    else if (e.type === 'handoff') { title = 'Handed to another agent'; detail = e.summary }
    else if (e.type === 'link') { title = e.summary; detail = null }
    else if (e.type === 'note') { title = 'Note'; detail = e.summary }
    return { id: String(e.id), at: e.at, title, detail, tone, actor: e.actor, type: e.type }
  })
}

/** The actions agents took on the case (timeline entries of type action). */
export const caseActions = (events: CaseEventItem[]) => events.filter(e => e.type === 'action')

/** Approval items that decide this case: the case itself (source `case`), or an item for a record the case links. */
export function pendingDecisionsFor(c: Pick<CaseItem, 'id' | 'records'>, events: Pick<CaseEventItem, 'ref_id'>[], approvals: ApprovalEntry[]): ApprovalEntry[] {
  const ids = new Set<string>([...c.records.map(r => r.id), ...events.map(e => e.ref_id).filter((x): x is string => Boolean(x))])
  return approvals.filter(a => (a.source === 'case' && a.id === c.id) || ids.has(a.id))
}

/** Approval items not tied to any of these cases (shown on their own in Needs My Approval). */
export function approvalsWithoutCase(approvals: ApprovalEntry[], cases: Pick<CaseItem, 'id' | 'records'>[]): ApprovalEntry[] {
  const caseIds = new Set(cases.map(c => c.id))
  const linked = new Set(cases.flatMap(c => c.records.map(r => r.id)))
  return approvals.filter(a => !(a.source === 'case' && caseIds.has(a.id)) && !linked.has(a.id))
}

/** What the person sees and decides, flattened to label/value rows. Long text stays whole; objects are shown as key: value lines. */
export function approvalContentRows(content: Record<string, unknown>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const fmt = (v: unknown): string => {
    if (v == null) return '—'
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x ? fmt((x as Record<string, unknown>).label ?? (x as Record<string, unknown>).address ?? JSON.stringify(x)) : fmt(x))).join(', ')
    return Object.entries(v as Record<string, unknown>).filter(([, x]) => x != null && x !== '').map(([k, x]) => `${humanize(k)}: ${fmt(x)}`).join('\n')
  }
  for (const [k, v] of Object.entries(content ?? {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
    rows.push({ label: humanize(k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()), value: fmt(v) })
  }
  return rows
}

// ---------------------------------------------------------------- Home

export type HomeInput = {
  counts: CaseCounts | null
  approvals: number | null
  agents: { running: number; total: number; needsAttention: number } | null
  connectedApps: number | null
  weekly: { minutes: number; formula: string } | null
}
export type HomeMetric = { key: string; label: string; value: number | null; sub: string; href: string; estimate?: boolean; formula?: string }

/** The Home tiles. Every value comes from an API; a missing source gives null (shown as "—" with why), never a guess. */
export function homeMetrics(i: HomeInput): HomeMetric[] {
  const c = i.counts
  return [
    { key: 'discovered', label: 'Work discovered', value: c ? c.total : null, sub: 'Problems found in your connected tools', href: '/store/work' },
    { key: 'resolved', label: 'Issues resolved', value: c ? c.completed : null, sub: c ? `Verified only · ${c.resolved_30d} in the last 30 days` : 'Verified only', href: '/store/completed' },
    { key: 'in_progress', label: 'In progress', value: c ? c.in_progress + c.attention : null, sub: c && c.attention ? `${c.attention} need${c.attention === 1 ? 's' : ''} attention` : 'Being handled by your team', href: '/store/work' },
    { key: 'approvals', label: 'Pending approvals', value: i.approvals ?? (c ? c.needs_approval : null), sub: 'Waiting for your decision', href: '/store/approvals' },
    { key: 'agents', label: 'Agents working', value: i.agents ? i.agents.running : null, sub: i.agents ? `${i.agents.total} on your team${i.agents.needsAttention ? ` · ${i.agents.needsAttention} need attention` : ''}` : 'Your AI team', href: '/store/my-team' },
    { key: 'apps', label: 'Connected apps', value: i.connectedApps, sub: 'Store, email, CRM and calendar', href: '/store/integrations' },
    { key: 'time', label: 'Estimated time saved', value: i.weekly ? i.weekly.minutes : null, sub: 'This week, in minutes', href: '/store/insights', estimate: true, formula: i.weekly?.formula },
  ]
}

/** Short, factual insights from the data (no advice that the data does not support). */
export function homeInsights(i: { counts: CaseCounts | null; approvals: number | null; cases: CaseItem[]; connectedApps: number | null }): { tone: Tone; text: string; href: string }[] {
  const out: { tone: Tone; text: string; href: string }[] = []
  const c = i.counts
  if (c && c.attention) out.push({ tone: 'danger', text: `${c.attention} case${c.attention === 1 ? ' is' : 's are'} blocked, failed or need a person.`, href: '/store/work' })
  if (i.approvals) out.push({ tone: 'warn', text: `${i.approvals} decision${i.approvals === 1 ? ' is' : 's are'} waiting for you. Your team does not act on ${i.approvals === 1 ? 'it' : 'them'} until you decide.`, href: '/store/approvals' })
  const urgent = i.cases.filter(x => (x.priority === 'urgent' || x.priority === 'high') && STATUS_WORDS[x.status]?.stage !== 'done')
  if (urgent.length) out.push({ tone: 'warn', text: `${urgent.length} high-priority case${urgent.length === 1 ? '' : 's'} open, the first: ${urgent[0].title}.`, href: `/store/work/${encodeURIComponent(urgent[0].ref)}` })
  const waiting = i.cases.filter(x => x.status === 'waiting_external')
  if (waiting.length) out.push({ tone: 'muted', text: `${waiting.length} case${waiting.length === 1 ? ' is' : 's are'} waiting on a reply from someone outside your business; Deploi checks again on schedule.`, href: '/store/work' })
  if (i.connectedApps === 0) out.push({ tone: 'info', text: 'Nothing is connected yet. Connect your store or email so Deploi can find work.', href: '/store/integrations' })
  return out
}
