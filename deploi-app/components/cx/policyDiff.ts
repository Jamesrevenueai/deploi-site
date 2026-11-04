/**
 * Readable preview of what an edit changes in an agent's authorization, for the edit screen. Display only:
 * the server's own comparison (lib/agents/policy.ts expansionReasons) decides whether a new grant is
 * needed, and its answer is shown after saving. This mirrors it closely enough to warn before saving.
 */
import type { AgentPolicy } from '@/components/store/types'

export type PolicyChange = { kind: 'wider' | 'narrower' | 'same'; text: string }

const TIER_RANK: Record<string, number> = { draft: 0, review: 1, send_approved: 1, autonomous: 2, send_autonomous: 2 }
const TIER_NAME: Record<string, string> = { draft: 'Drafts only', review: 'After my approval', send_approved: 'After my approval', autonomous: 'Without asking, within limits', send_autonomous: 'Without asking, within limits' }
const added = <T,>(next: T[] = [], prev: T[] = []) => next.filter(x => !prev.includes(x))

function scopeWords(s: AgentPolicy['productScope']): string {
  return s.mode === 'all' ? 'every product' : s.mode === 'products' ? `${s.productIds.length} selected product${s.productIds.length === 1 ? '' : 's'}` : `products tagged ${s.tags.map(t => `"${t}"`).join(', ')}`
}

export function describePolicyChange(prev: AgentPolicy | null, next: AgentPolicy): PolicyChange[] {
  if (!prev) return [{ kind: 'wider', text: 'First authorization: nothing runs until you grant it.' }]
  const out: PolicyChange[] = []
  const cmpTier = (label: string, a: string | undefined, b: string | undefined) => {
    if (!b || a === b) return
    const up = (TIER_RANK[b] ?? 0) > (TIER_RANK[a ?? 'draft'] ?? 0)
    out.push({ kind: up ? 'wider' : 'narrower', text: `${label}: ${TIER_NAME[a ?? 'draft'] ?? a} → ${TIER_NAME[b] ?? b}` })
  }
  cmpTier('Store permission', prev.approvalMode, next.approvalMode)
  const newTypes = added(next.correctionTypes, prev.correctionTypes), goneTypes = added(prev.correctionTypes, next.correctionTypes)
  if (newTypes.length) out.push({ kind: 'wider', text: `New kinds of correction: ${newTypes.join(', ')}` })
  if (goneTypes.length) out.push({ kind: 'narrower', text: `No longer corrects: ${goneTypes.join(', ')}` })
  const ps = prev.productScope, ns = next.productScope
  if (scopeWords(ps) !== scopeWords(ns)) {
    const wider = (ns.mode === 'all' && ps.mode !== 'all') || (ns.mode === ps.mode && ns.mode === 'products' && added(ns.productIds, ps.productIds).length > 0) || (ns.mode === ps.mode && ns.mode === 'tags' && added(ns.tags, ps.tags).length > 0) || (ns.mode !== ps.mode && ns.mode !== 'all' && ps.mode !== 'all')
    out.push({ kind: wider ? 'wider' : 'narrower', text: `Products: ${scopeWords(ps)} → ${scopeWords(ns)}` })
  }
  const lostExceptions = [...added(prev.exceptions.tags, next.exceptions.tags), ...added(prev.exceptions.productIds, next.exceptions.productIds)]
  if (lostExceptions.length) out.push({ kind: 'wider', text: `Fewer exceptions: ${lostExceptions.length} removed` })
  const newExceptions = [...added(next.exceptions.tags, prev.exceptions.tags), ...added(next.exceptions.productIds, prev.exceptions.productIds)]
  if (newExceptions.length) out.push({ kind: 'narrower', text: `More exceptions: ${newExceptions.length} added` })
  if (next.limits.maxChangesPerRun > prev.limits.maxChangesPerRun || next.limits.maxChangesPerDay > prev.limits.maxChangesPerDay) out.push({ kind: 'wider', text: `Higher limits: ${next.limits.maxChangesPerRun} per run, ${next.limits.maxChangesPerDay} per day` })
  else if (next.limits.maxChangesPerRun < prev.limits.maxChangesPerRun || next.limits.maxChangesPerDay < prev.limits.maxChangesPerDay) out.push({ kind: 'narrower', text: `Lower limits: ${next.limits.maxChangesPerRun} per run, ${next.limits.maxChangesPerDay} per day` })
  if (next.validUntil && (!prev.validUntil || next.validUntil > prev.validUntil)) out.push({ kind: 'wider', text: `Standing authorization ends later: ${next.validUntil.slice(0, 10)}` })
  const pe = prev.email, ne = next.email
  if (ne && !pe) out.push({ kind: 'wider', text: 'Starts using email' })
  if (pe && !ne) out.push({ kind: 'narrower', text: 'Stops using email' })
  if (pe && ne) {
    cmpTier('Email permission', pe.permission, ne.permission)
    const to = [...added(ne.recipients.addresses, pe.recipients.addresses), ...added(ne.recipients.domains, pe.recipients.domains).map(d => `anyone at ${d}`)]
    if (to.length) out.push({ kind: 'wider', text: `New recipients: ${to.join(', ')}` })
    const removed = [...added(pe.recipients.addresses, ne.recipients.addresses), ...added(pe.recipients.domains, ne.recipients.domains)]
    if (removed.length) out.push({ kind: 'narrower', text: `Recipients removed: ${removed.join(', ')}` })
    const tasks = added(ne.tasks, pe.tasks)
    if (tasks.length) out.push({ kind: 'wider', text: `New email tasks: ${tasks.join(', ')}` })
    if (ne.read.enabled && !pe.read.enabled) out.push({ kind: 'wider', text: 'May notice replies in its mailbox' })
    if (ne.limits.perRun > pe.limits.perRun || ne.limits.perDay > pe.limits.perDay) out.push({ kind: 'wider', text: `More email: ${ne.limits.perRun} per run, ${ne.limits.perDay} per day` })
    if (ne.validUntil && (!pe.validUntil || ne.validUntil > pe.validUntil)) out.push({ kind: 'wider', text: `Sending authorization ends later: ${ne.validUntil.slice(0, 10)}` })
  }
  const cs = added((next.competitors?.stores ?? []).map(s => s.url), (prev.competitors?.stores ?? []).map(s => s.url))
  if (cs.length) out.push({ kind: 'wider', text: `New competitor stores: ${cs.join(', ')}` })
  return out.length ? out : [{ kind: 'same', text: 'Nothing that changes what the agent may do.' }]
}

export const needsNewGrant = (changes: PolicyChange[]) => changes.some(c => c.kind === 'wider')
