/**
 * Email step of an agent run: build this run's messages from the authorized tasks, decide each one
 * (draft, awaiting approval or queued under the standing authorization), send what is queued, and
 * note replies when the agent may read them. Called by runAgent after the corrections.
 */
import { admin } from '../db'
import { env } from '../env'
import { inScope, type AgentPolicy } from '../agents/policy'
import type { ResourceRecord } from '../engine/types'
import { checkReplies, createAgentMessages, processQueue } from './engine'
import { needsPersonAlert, reorderCandidates, runReport, supplierReorder, type DraftMessage, type PersonItem } from './tasks'

export type EmailRunCounts = { emailDrafted: number; emailAwaiting: number; emailAccepted: number; emailFailed: number; emailUnknown: number; emailSkipped: number }

export async function runEmailStep(input: {
  agentId: string; agentName: string; runId: string; policy: AgentPolicy; storeName: string; records: ResourceRecord[] | null; actor: string; now: Date
  run: { verified: number; awaitingApproval: number; needsPerson: number; failed: number; blocked: number }
}): Promise<EmailRunCounts> {
  const e = input.policy.email!
  const out: EmailRunCounts = { emailDrafted: 0, emailAwaiting: 0, emailAccepted: 0, emailFailed: 0, emailUnknown: 0, emailSkipped: 0 }
  const appUrl = (env.appUrl || 'http://localhost:3000').replace(/\/$/, '')
  const drafts: DraftMessage[] = []

  if (e.tasks.includes('needs_person_alert')) {
    // only items not already included in an earlier alert from this agent
    const items = await admin(db => db.query<PersonItem>(
      `select i.id, coalesce(i.resource_label, i.resource_id) as label, i.evidence->>'summary' as summary, i.evidence->>'humanAction' as "humanAction" from issues i
       where i.agent_id = $1 and i.kind = 'needs_person' and i.status in ('open','needs_review')
         and not exists (select 1 from email_messages m where m.agent_id = $1 and m.task_key = 'needs_person_alert' and m.status not in ('cancelled','failed') and m.meta->'issue_ids' ? i.id::text)
       order by i.severity = 'high' desc, i.first_detected_at`, [input.agentId]))
    const d = needsPersonAlert(e, { runId: input.runId, agentId: input.agentId, agentName: input.agentName, storeName: input.storeName, appUrl, items })
    if (d) drafts.push(d)
  }
  const sr = e.supplierReorder
  if (e.tasks.includes('supplier_reorder') && sr && input.records) {
    const recent = await admin(db => db.query<{ v: string }>(
      `select jsonb_array_elements_text(meta->'variant_ids') as v from email_messages where agent_id = $1 and task_key = 'supplier_reorder'
       and status not in ('cancelled','failed') and created_at > $2`, [input.agentId, new Date(input.now.getTime() - sr.cooldownDays * 864e5).toISOString()]))
    const skip = new Set(recent.map(r => r.v))
    const items = reorderCandidates(input.records, sr.thresholdAvailable, r => inScope(input.policy, String(r.productId ?? ''), Array.isArray(r.productTags) ? (r.productTags as string[]) : []))
      .filter(i => !skip.has(i.variantId))
    const d = supplierReorder(e, { runId: input.runId, agentName: input.agentName, storeName: input.storeName, at: input.now, items })
    if (d) drafts.push(d)
  }

  // the run summary comes last: it reports on everything above
  if (e.tasks.includes('run_report')) {
    const verified = await admin(db => db.query<{ target_label: string; change: { field: string; from: unknown; to: unknown } }>(
      `select p.target_label, p.change from executions e join proposals p on p.id = e.proposal_id where e.agent_id = $1 and e.status = 'verified' and e.finished_at >= $2`, [input.agentId, input.now.toISOString()]))
    drafts.push(runReport(e, { runId: input.runId, agentId: input.agentId, agentName: input.agentName, storeName: input.storeName, at: input.now, appUrl, counts: input.run,
      verified: verified.map(v => ({ label: v.target_label, field: v.change.field, from: v.change.from, to: v.change.to })) }))
  }
  const created = await createAgentMessages({ agentId: input.agentId, runId: input.runId, drafts, actor: input.actor, now: input.now })
  out.emailSkipped = created.skipped
  for (const c of created.created) {
    if (c.status === 'draft') out.emailDrafted++
    else if (c.status === 'awaiting_approval') out.emailAwaiting++
  }
  for (const r of await processQueue({ agentId: input.agentId, actor: input.actor, now: input.now })) {
    if (r.status === 'accepted') out.emailAccepted++
    else if (r.status === 'failed') out.emailFailed++
    else if (r.status === 'delivery_unknown') out.emailUnknown++
    else if (r.status === 'awaiting_approval') out.emailAwaiting++
  }
  if (e.read.enabled) await checkReplies(input.agentId, { actor: input.actor })
  return out
}
