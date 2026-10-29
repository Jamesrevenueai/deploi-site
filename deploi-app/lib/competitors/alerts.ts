/**
 * Email built from competitor findings. Deterministic templates: headlines and next actions are Deploi's own
 * sentences; competitor product titles appear only as quoted plain text and can never choose a recipient,
 * add an attachment or change a permission.
 */
import type { EmailPolicy } from '../agents/policy'
import type { DraftMessage } from '../email/tasks'

const clean = (s: unknown, max = 300) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const BASIS: Record<string, string> = { observed: 'Observed', inferred: 'Inferred', unavailable: 'Unavailable' }

/** One alert listing the meaningful findings of a run, to the merchant's own notify list. */
export function competitorAlert(e: EmailPolicy, f: { runId: string; agentId: string; agentName: string; appUrl: string; at: Date; insights: { id: string; headline: string; basis: string; next_action: string }[] }): DraftMessage {
  const lines = [
    'Hello,', '',
    `The Deploi agent "${clean(f.agentName, 80)}" found ${f.insights.length} meaningful change${f.insights.length === 1 ? '' : 's'} at the stores you follow (checked ${f.at.toISOString().slice(0, 16).replace('T', ' ')} UTC).`, '',
    ...f.insights.flatMap(i => [`- [${BASIS[i.basis] ?? i.basis}] ${clean(i.headline)}`, `  Suggested next step: ${clean(i.next_action)}`]),
    '', 'These come from the stores\' public pages. Sales, revenue and units are not visible there, and nothing in this email measures them.',
    '', `Evidence, sources and limitations: ${f.appUrl}/store/agents/${f.agentId}`, '', `Purpose of these emails: ${clean(e.purpose)}`,
  ]
  return { taskKey: 'competitor_alert', dedupeKey: `competitor_alert:${f.runId}`, to: [...e.notify], cc: [], meta: { insight_ids: f.insights.map(i => i.id) },
    content: { subject: clean(`Deploi: ${f.insights.length} change${f.insights.length === 1 ? '' : 's'} at stores you follow`, 180), bodyText: lines.join('\n'), attachments: [] } }
}
