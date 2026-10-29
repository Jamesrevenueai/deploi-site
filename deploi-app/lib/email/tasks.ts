/**
 * Email tasks: deterministic templates, filled with store data treated as plain text. Recipients come
 * only from the agent's policy. Store content can appear in a message body but can never choose a
 * recipient, add an attachment the policy does not allow, or change any permission.
 */
import type { EmailPolicy } from '../agents/policy'
import type { ResourceRecord } from '../engine/types'
import type { MessageContent } from './types'

export type DraftMessage = { taskKey: 'run_report' | 'needs_person_alert' | 'supplier_reorder' | 'supplier_followup' | 'competitor_alert' | 'sourcing_request'; dedupeKey: string; to: string[]; cc: string[]; content: MessageContent; meta: Record<string, unknown>; inReplyTo?: string | null }

 
const clean = (s: unknown, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const stamp = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

export type RunFacts = {
  runId: string; agentId: string; agentName: string; storeName: string; at: Date; appUrl: string
  counts: { verified: number; awaitingApproval: number; needsPerson: number; failed: number; blocked: number }
  verified: { label: string; field: string; from: unknown; to: unknown }[]
}

export function runReport(e: EmailPolicy, f: RunFacts): DraftMessage {
  const c = f.counts
  const lines = [
    'Hello,', '',
    `This is an automatic summary from the Deploi agent "${clean(f.agentName, 80)}" for ${clean(f.storeName, 120)}, run at ${stamp(f.at)}.`, '',
    `Changes verified: ${c.verified}`, `Waiting for approval: ${c.awaitingApproval}`, `Need a person: ${c.needsPerson}`, `Failed: ${c.failed} · Blocked: ${c.blocked}`,
    ...(f.verified.length ? ['', 'Verified in this run:', ...f.verified.slice(0, 50).map(v => `- ${clean(v.label)}: ${clean(v.field, 40)} ${clean(v.from, 60)} -> ${clean(v.to, 60)}`), ...(f.verified.length > 50 ? [`- and ${f.verified.length - 50} more`] : [])] : []),
    '', `Details: ${f.appUrl}/store/agents/${f.agentId}`, '',
    `Purpose of these emails: ${clean(e.purpose, 300)}`,
  ]
  return { taskKey: 'run_report', dedupeKey: `run_report:${f.runId}`, to: [...e.notify], cc: [], meta: { run_id: f.runId },
    content: { subject: clean(`Deploi: ${f.agentName}: ${c.verified} verified, ${c.awaitingApproval} waiting, ${c.needsPerson} for a person`, 180), bodyText: lines.join('\n'), attachments: [] } }
}

export type PersonItem = { id: string; label: string; summary: string; humanAction: string | null }
export function needsPersonAlert(e: EmailPolicy, f: { runId: string; agentId: string; agentName: string; storeName: string; appUrl: string; items: PersonItem[] }): DraftMessage | null {
  if (!f.items.length) return null
  const lines = [
    'Hello,', '',
    `The Deploi agent "${clean(f.agentName, 80)}" found ${f.items.length} problem${f.items.length === 1 ? '' : 's'} in ${clean(f.storeName, 120)} that need a person. It will not change these itself.`, '',
    ...f.items.slice(0, 40).flatMap(i => [`- ${clean(i.label)}: ${clean(i.summary, 300)}`, ...(i.humanAction ? [`  What to do: ${clean(i.humanAction, 300)}`] : [])]),
    ...(f.items.length > 40 ? [`- and ${f.items.length - 40} more`] : []),
    '', `Details: ${f.appUrl}/store/agents/${f.agentId}`, '', `Purpose of these emails: ${clean(e.purpose, 300)}`,
  ]
  return { taskKey: 'needs_person_alert', dedupeKey: `needs_person:${f.runId}`, to: [...e.notify], cc: [], meta: { issue_ids: f.items.map(i => i.id) },
    content: { subject: clean(`Deploi: ${f.items.length} ${f.items.length === 1 ? 'item needs' : 'items need'} a person in ${f.storeName}`, 180), bodyText: lines.join('\n'), attachments: [] } }
}

export type ReorderItem = { variantId: string; sku: string | null; label: string; available: number }
/** Variants at or below the threshold, in scope, tracked and active. Quantities to order are never guessed. */
export function reorderCandidates(records: ResourceRecord[], threshold: number, inScope: (r: ResourceRecord) => boolean): ReorderItem[] {
  return records.filter(r => r.resourceType === 'variant' && r.productStatus === 'ACTIVE' && r.tracked === true && r.isGiftCard !== true && typeof r.totalAvailable === 'number' && (r.totalAvailable as number) <= threshold && inScope(r))
    .map(r => ({ variantId: String(r.variantId), sku: (r.sku as string | null) ?? null, available: r.totalAvailable as number,
      label: `${clean(r.productTitle, 120)}${r.variantTitle && r.variantTitle !== 'Default Title' ? ` / ${clean(r.variantTitle, 60)}` : ''}` }))
}

export function supplierReorder(e: EmailPolicy, f: { runId: string; agentName: string; storeName: string; at: Date; items: ReorderItem[] }): DraftMessage | null {
  const s = e.supplierReorder
  if (!s || !f.items.length) return null
  const lines = [
    'Hello,', '',
    `${clean(f.storeName, 120)} would like to restock the products below. Available quantities are as recorded in the store at ${stamp(f.at)}. Please confirm availability and lead time; the store will confirm quantities with you.`, '',
    ...f.items.slice(0, 100).map(i => `- ${i.sku ? clean(i.sku, 60) + ' · ' : ''}${i.label} · available: ${i.available}`),
    ...(f.items.length > 100 ? [`- and ${f.items.length - 100} more`] : []),
    '', `This message was prepared by the store's Deploi agent "${clean(f.agentName, 80)}".`,
  ]
  // the subject (counts only, no product data) is kept in meta so a follow-up can reply in the same thread
  const subject = clean(`Restock request from ${f.storeName}: ${f.items.length} product${f.items.length === 1 ? '' : 's'}`, 180)
  const csv = ['sku,product,available', ...f.items.map(i => [i.sku ?? '', i.label, String(i.available)].map(v => `"${v.replace(/"/g, '""')}"`).join(','))].join('\r\n') + '\r\n'
  return {
    taskKey: 'supplier_reorder', dedupeKey: `supplier_reorder:${f.runId}`, to: [s.supplierAddress], cc: [], meta: { variant_ids: f.items.map(i => i.variantId), subject },
    content: { subject, bodyText: lines.join('\n'),
      attachments: e.allowAttachments ? [{ filename: 'restock-request.csv', contentType: 'text/csv', contentBase64: Buffer.from(csv, 'utf8').toString('base64') }] : [] },
  }
}

export type FollowupTarget = { messageId: string; internetMessageId: string; to: string[]; subject: string; sentAt: string; variantIds: string[] }
/** One follow-up in the same thread when a supplier request has had no reply. Never more than one per request (dedupe key). */
export function supplierFollowup(e: EmailPolicy, f: { agentName: string; storeName: string; target: FollowupTarget }): DraftMessage | null {
  const s = e.supplierReorder
  if (!s || !f.target.to.length) return null
  const subject = /^re:/i.test(f.target.subject) ? f.target.subject : `Re: ${f.target.subject}`
  const lines = [
    'Hello,', '',
    `Following up on the restock request ${clean(f.storeName, 120)} sent on ${stamp(new Date(f.target.sentAt))}. Could you confirm availability and lead time for the products listed there?`, '',
    'If you have already replied, please ignore this message.', '',
    `This message was prepared by the store's Deploi agent "${clean(f.agentName, 80)}".`,
  ]
  return { taskKey: 'supplier_followup', dedupeKey: `supplier_followup:${f.target.messageId}`, to: [...f.target.to], cc: [], inReplyTo: f.target.internetMessageId,
    meta: { follows_message_id: f.target.messageId, variant_ids: f.target.variantIds }, content: { subject: clean(subject, 180), bodyText: lines.join('\n'), attachments: [] } }
}
