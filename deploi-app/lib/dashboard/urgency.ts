/**
 * Urgency rules for the client dashboard's action items. Ordered: the first matching rule wins.
 * Thresholds are explicit so a reader can see why an item is ranked where it is.
 */
export type UrgencyLevel = 'urgent' | 'high' | 'medium' | 'low'
export const LEVEL_ORDER: Record<UrgencyLevel, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
export const LEVEL_TONE: Record<UrgencyLevel, 'danger' | 'warn' | 'none' | 'muted'> = { urgent: 'danger', high: 'warn', medium: 'none', low: 'muted' }

export type ActionKind = 'exception' | 'shift' | 'authorization' | 'referral' | 'credential' | 'approval' | 'freshness'

/** What the rules look at. Only the signals that apply to a kind need to be set. */
export type ActionSignal = {
  kind: ActionKind
  /** days until a deadline (exception window, credential expiry, authorization end) */
  daysLeft?: number | null
  /** hours until a shift starts */
  hoursUntil?: number | null
  /** percent of authorization units left */
  pctLeft?: number | null
  /** how many items are waiting (referrals, approvals) */
  count?: number | null
  /** age of the newest import in days */
  staleDays?: number | null
}

export type UrgencyRule = { id: string; kind: ActionKind; level: UrgencyLevel; description: string; test: (s: ActionSignal) => boolean }

const lte = (v: number | null | undefined, n: number) => typeof v === 'number' && v <= n
const gte = (v: number | null | undefined, n: number) => typeof v === 'number' && v >= n

/** Ordered. First match wins; an item with no match is 'low'. */
export const URGENCY_RULES: UrgencyRule[] = [
  { id: 'exception_window_2d', kind: 'exception', level: 'urgent', description: 'EVV correction window closes within 2 days', test: s => lte(s.daysLeft, 2) },
  { id: 'shift_starts_12h', kind: 'shift', level: 'urgent', description: 'Open shift starts within 12 hours', test: s => lte(s.hoursUntil, 12) },
  { id: 'authorization_5pct', kind: 'authorization', level: 'urgent', description: 'Authorization has 5% or fewer units left', test: s => lte(s.pctLeft, 5) },
  { id: 'exception_window_7d', kind: 'exception', level: 'high', description: 'EVV correction window closes within 7 days', test: s => lte(s.daysLeft, 7) },
  { id: 'shift_starts_48h', kind: 'shift', level: 'high', description: 'Open shift starts within 48 hours', test: s => lte(s.hoursUntil, 48) },
  { id: 'authorization_15pct', kind: 'authorization', level: 'high', description: 'Authorization has 15% or fewer units left', test: s => lte(s.pctLeft, 15) },
  { id: 'credential_7d', kind: 'credential', level: 'high', description: 'Credential expires within 7 days', test: s => lte(s.daysLeft, 7) },
  { id: 'import_stale_14d', kind: 'freshness', level: 'high', description: 'Newest import is older than 14 days', test: s => gte(s.staleDays, 14) },
  { id: 'referral_waiting', kind: 'referral', level: 'medium', description: 'A referral has no first response', test: s => gte(s.count, 1) },
  { id: 'approvals_waiting', kind: 'approval', level: 'medium', description: 'Proposed actions wait for the agency’s approval owner', test: s => gte(s.count, 1) },
  { id: 'import_stale_7d', kind: 'freshness', level: 'medium', description: 'Newest import is older than 7 days', test: s => gte(s.staleDays, 7) },
  { id: 'exception_open', kind: 'exception', level: 'medium', description: 'EVV exception open with more than 7 days left', test: () => true },
  { id: 'shift_open', kind: 'shift', level: 'medium', description: 'Open shift with no aide yet', test: () => true },
  { id: 'credential_30d', kind: 'credential', level: 'low', description: 'Credential expires within 30 days', test: s => lte(s.daysLeft, 30) },
]

export function matchRule(s: ActionSignal): UrgencyRule | null {
  return URGENCY_RULES.find(r => r.kind === s.kind && r.test(s)) ?? null
}
export function levelFor(s: ActionSignal): UrgencyLevel {
  return matchRule(s)?.level ?? 'low'
}

export type ActionItem = { kind: ActionKind; title: string; detail: string; href: string | null; signal: ActionSignal }
export type RankedActionItem = ActionItem & { level: UrgencyLevel; rule: string | null }

/** Stable sort by level, then by rule order, then by the tightest deadline / largest count. Input order breaks ties. */
export function rankActionItems(items: ActionItem[]): RankedActionItem[] {
  const ranked = items.map((it, i) => {
    const rule = matchRule(it.signal)
    return { ...it, level: rule?.level ?? ('low' as UrgencyLevel), rule: rule?.id ?? null, _i: i, _r: rule ? URGENCY_RULES.indexOf(rule) : URGENCY_RULES.length }
  })
  ranked.sort((a, b) =>
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a._r - b._r ||
    tightness(a.signal) - tightness(b.signal) || a._i - b._i)
  return ranked.map(r => ({ kind: r.kind, title: r.title, detail: r.detail, href: r.href, signal: r.signal, level: r.level, rule: r.rule }))
}

/** Lower is more pressing: fewest days/hours/percent left, or (negated) largest count. */
function tightness(s: ActionSignal): number {
  if (typeof s.daysLeft === 'number') return s.daysLeft
  if (typeof s.hoursUntil === 'number') return s.hoursUntil / 24
  if (typeof s.pctLeft === 'number') return s.pctLeft
  if (typeof s.staleDays === 'number') return -s.staleDays
  if (typeof s.count === 'number') return -s.count
  return Number.MAX_SAFE_INTEGER
}
