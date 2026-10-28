/**
 * Does an agent's email authorization cover this exact message? Enforced in code before a message is
 * queued and again immediately before every send. Nothing in the message, the store or any incoming
 * email can widen these rules: they come only from the granted policy version.
 */
import { permissionRank, recipientAllowed, type AgentPolicy } from '../agents/policy'
import type { EmailAccountRow } from './accounts'

export type EmailQualification = { covered: boolean; reasons: string[]; blockers: string[] }
export type EmailCheckInput = {
  agentStatus: string
  policyStatus: string
  policyVersion: number
  policy: AgentPolicy
  account: Pick<EmailAccountRow, 'id' | 'address' | 'status' | 'can_send'> | null
  message: { from: string; to: string[]; cc: string[]; attachmentCount: number; taskKey: string }
  counts: { run: number | null; day: number }
  now: Date
}

/** Common conditions for any send from this agent (individually approved or not). */
export function sendBlockers(i: Pick<EmailCheckInput, 'agentStatus' | 'policyStatus' | 'policy' | 'account' | 'message'>): string[] {
  const b: string[] = []
  const e = i.policy.email
  if (i.agentStatus !== 'active') b.push(`the agent is ${i.agentStatus}`)
  if (i.policyStatus !== 'active') b.push('the agent has no active authorization')
  if (!e) { b.push('the agent is not authorized to use email'); return b }
  if (permissionRank(e.permission) < permissionRank('send_approved')) b.push('this agent may only create drafts')
  if (!i.account) b.push('the email account is missing')
  else {
    if (i.account.id !== e.accountId) b.push('the message is from an account this agent is not authorized to use')
    if (i.account.status !== 'active' || !i.account.can_send) b.push('the email account is not connected with permission to send')
    if (i.account.address.toLowerCase() !== i.message.from.toLowerCase()) b.push('the sender address changed')
  }
  return b
}

/** Standing authorization: may this message go out without asking? */
export function qualifyEmail(i: EmailCheckInput): EmailQualification {
  const blockers = sendBlockers(i)
  const reasons: string[] = []
  const e = i.policy.email
  if (!e) return { covered: false, reasons, blockers }
  if (e.permission !== 'send_autonomous') blockers.push('this agent sends only messages you approve')
  if (!e.tasks.includes(i.message.taskKey as never)) blockers.push('this email task is not authorized')
  else reasons.push(`task "${i.message.taskKey}" is authorized; purpose: ${e.purpose}`)
  if (e.validUntil && new Date(e.validUntil).getTime() <= i.now.getTime()) blockers.push(`the authorization to send without asking ended on ${e.validUntil.slice(0, 10)}`)
  else if (e.validUntil) reasons.push(`authorized until ${e.validUntil.slice(0, 10)}`)
  const all = [...i.message.to, ...i.message.cc]
  const outside = all.filter(a => !recipientAllowed(e, a))
  if (outside.length) blockers.push(`recipient${outside.length === 1 ? '' : 's'} outside the allowed list: ${outside.join(', ')}`)
  else reasons.push('every recipient is within the allowed recipients')
  if (all.length > e.maxRecipientsPerMessage) blockers.push(`${all.length} recipients exceeds the limit of ${e.maxRecipientsPerMessage}`)
  if (i.message.attachmentCount > 0 && !e.allowAttachments) blockers.push('attachments are not authorized')
  if (i.counts.run !== null && i.counts.run >= e.limits.perRun) blockers.push(`run limit of ${e.limits.perRun} messages reached`)
  if (i.counts.day >= e.limits.perDay) blockers.push(`daily limit of ${e.limits.perDay} messages reached`)
  if (!blockers.length) reasons.push(`within limits (${i.counts.run ?? 'n/a'}/${e.limits.perRun} this run, ${i.counts.day}/${e.limits.perDay} today)`, `authorization version ${i.policyVersion}`)
  return { covered: blockers.length === 0, reasons, blockers }
}
