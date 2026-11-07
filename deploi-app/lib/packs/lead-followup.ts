/**
 * Follow-up for leads that went quiet after the first reply, shared by the lead packs: the same cadence
 * (settings.leadFollowUpDays, days after the reply), the same template, then the lead is marked quiet and the
 * owner is told. A reply from the lead (any status change) stops it.
 */
import type { Db } from '../db'
import type { AgentEvent } from '../events'
import type { LeadRow } from './leads'
import { runPackLoop, PackBlocked, type PackOutcome } from './loop'
import { sendPackMessage, verifySent, policyProof } from './outbound'
import type { PackKey } from './registry'
import type { OrgPacks } from './settings'
import { leadFollowUp } from './templates'
import { days, eventNow, rowProof } from './kit'

export async function sweepLeadFollowUps(db: Db, e: AgentEvent, org: OrgPacks, o: { pack: PackKey; agentKey: string; agentName: string; fair: boolean; path: string }): Promise<PackOutcome[]> {
  const now = eventNow(e)
  const cadence = org.config.leadFollowUpDays
  const max = cadence.length
  const due = await db.query<LeadRow>(`select * from pack_leads where org_id = $1 and pack = $2 and status in ('replied','qualifying','slots_offered') and next_follow_up_at <= $3 order by next_follow_up_at limit 50`, [e.orgId, o.pack, now.toISOString()])
  const out: PackOutcome[] = []
  for (const l of due) {
    const n = l.follow_ups + 1
    if (n > max) {
      out.push(await runPackLoop(db, o.pack, {
        orgId: e.orgId, agentKey: o.agentKey, agentName: o.agentName, actionType: 'update_record', problemKey: `lead:${l.id}:quiet`, detailsPath: o.path,
        detect: async () => l,
        describe: () => ({ title: `${l.name ?? 'A lead'} went quiet`, whatHappened: `No answer after the first reply and ${max} follow-ups.`, whatIDid: ['Stopped following up and marked the lead quiet.'] }),
        act: async d => { await d.query(`update pack_leads set status = 'quiet', next_follow_up_at = null where id = $1`, [l.id]); return {} },
        verify: async d => { const r = await d.one<{ status: string }>('select status from pack_leads where id = $1', [l.id]); return { ok: r?.status === 'quiet', proof: [rowProof('Lead status now', r?.status ?? 'missing')] } },
      }))
      continue
    }
    out.push(await runPackLoop(db, o.pack, {
      orgId: e.orgId, agentKey: o.agentKey, agentName: o.agentName, actionType: 'send_customer_email', problemKey: `lead:${l.id}:followup:${n}`, detailsPath: o.path,
      detect: async () => l,
      describe: () => ({ title: `Followed up with ${l.name ?? 'a lead'} (${n} of ${max})`, whatHappened: `${l.name ?? 'The lead'} has not answered since our reply.`, whatIDid: [`Sent follow-up ${n} of ${max}.`] }),
      act: async (d, p) => {
        if (!l.email) throw new PackBlocked('the lead has no email address')
        const s = await sendPackMessage(d, { orgId: e.orgId, agentKey: o.agentKey, leadId: l.id, to: l.email, ...leadFollowUp({ name: l.name, business: org.config.senderName, n, max, fair: o.fair }), dedupeKey: `${o.pack}:lead:${l.id}:followup:${n}`, policy: o.fair ? 'fair_housing' : 'general', recipientNames: [l.name] })
        if (s.status !== 'sent') throw new PackBlocked(s.status === 'blocked' ? 'the follow-up failed the content check' : s.error)
        const gap = n < max ? cadence[n] - cadence[n - 1] : 7
        await d.query(`update pack_leads set follow_ups = $2, next_follow_up_at = $3 where id = $1`, [l.id, n, new Date(now.getTime() + days(Math.max(1, gap))).toISOString()])
        ;(p as LeadRow & { messageId?: string }).messageId = s.messageId
        return { proof: [policyProof(s.policy)] }
      },
      verify: async (_d, p) => verifySent(e.orgId, (p as LeadRow & { messageId?: string }).messageId!, 'Follow-up'),
    }))
  }
  return out
}
