/**
 * Office discovery: neglected leads. Reads the organization's connected HubSpot (contacts in lifecycle stage
 * "lead" only, through the same client Office agents use) and finds leads with no activity in N days that no
 * Office agent is following up. Findings carry the lead_followup case dedupe key the Lead Follow-up agent
 * uses, so a detected case and the agent's case are the same case. Reads only; never writes to HubSpot.
 */
import { admin, type Db } from '../../db'
import { hubspotFor } from '../../office/providers'
import type { OfficeConnectionRow } from '../../office/connections'
import { registerDetector, type DiscoveryFinding } from '../registry'

export const NEGLECTED_LEAD_DAYS = 7
const LOOKBACK_DAYS = 90
const isEmail = (a: string) => /^[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(a)

async function hubspot(db: Db, orgId: string) {
  return db.one<OfficeConnectionRow>(`select * from office_connections where org_id = $1 and provider = 'hubspot' and status = 'active'`, [orgId])
}

export const officeCrmDetector = {
  key: 'office.neglected_leads',
  suite: 'office' as const,
  sourceApp: 'hubspot',
  async available(db: Db, orgId: string) { return Boolean(await hubspot(db, orgId)) },
  async detect({ orgId, now }: { orgId: string; now: Date }) {
    const hc = await admin(db => hubspot(db, orgId))
    if (!hc) return { findings: [], recommendation: null, sourcesRead: [], notes: ['HubSpot is not connected'] }
    const hs = hubspotFor(hc)
    const cutoff = now.getTime() - NEGLECTED_LEAD_DAYS * 864e5
    const followed = new Set((await admin(db => db.query<{ hubspot_contact_id: string }>(`select hubspot_contact_id from office_leads where org_id = $1 and status = 'active'`, [orgId]))).map(r => r.hubspot_contact_id))
    const findings: DiscoveryFinding[] = []
    let after: string | null = null
    for (let page = 0; page < 5; page++) {
      const r = await hs.searchLeads({ since: new Date(now.getTime() - LOOKBACK_DAYS * 864e5), after, limit: 100 })
      for (const c of r.contacts) {
        if (c.lifecycleStage !== 'lead' || c.optedOut || !c.email || !isEmail(c.email) || followed.has(c.id)) continue
        const last = new Date(c.updatedAt ?? c.createdAt ?? 0).getTime()
        if (!last || last > cutoff) continue
        const days = Math.floor((now.getTime() - last) / 864e5)
        findings.push({
          kind: 'lead_followup', dedupeKey: `lead_followup:hubspot:${c.id}`,
          title: `Follow up ${[c.firstName, c.company && `(${c.company})`].filter(Boolean).join(' ') || c.email}`.slice(0, 300),
          problem: `${c.email} is a lead in HubSpot with no activity for ${days} days and nobody following up.`,
          whyItMatters: 'A lead nobody follows up is a lost opportunity.',
          evidence: [{ label: `HubSpot contact ${c.id}: lifecycle stage "lead", last updated ${new Date(last).toISOString().slice(0, 10)} (${days} days ago)`, source: 'hubspot', observedAt: now.toISOString(), ref: { type: 'hubspot_contact', id: c.id } }],
          records: [{ type: 'hubspot_contact', id: c.id, label: c.email }],
          verification: { criteria: 'Resolved only when a meeting is read back from Google Calendar with the lead as a guest, the lead\'s reply ("not interested" or opt-out) is recorded and read back in HubSpot, or a stage change is read back from HubSpot.', rule: { kind: 'lead_followup' } },
        })
      }
      after = r.next
      if (!after) break
    }
    const agent = await admin(db => db.one(`select id from office_agents where org_id = $1 and kind = 'lead_followup' and status = 'active'`, [orgId]))
    const mailbox = await admin(db => db.one(`select id from email_accounts where org_id = $1 and status = 'active' and can_send and (provider <> 'deploi' or office_mailbox)`, [orgId]))
    const n = findings.length
    return {
      findings, sourcesRead: ['hubspot:contacts (lifecycle stage lead)'],
      recommendation: n && !agent ? { template: 'lead_followup', suite: 'office' as const, name: 'Lead Follow-up',
        reason: `${n} lead${n === 1 ? '' : 's'} in HubSpot ${n === 1 ? 'has' : 'have'} had no activity for ${NEGLECTED_LEAD_DAYS}+ days and nobody is following ${n === 1 ? 'it' : 'them'} up`,
        needs: [...(mailbox ? [] : ['a mailbox to send from (the Deploi office mailbox or a connected account)']), 'your sender name', 'one or two sentences on what you offer'] } : null,
    }
  },
}
registerDetector(officeCrmDetector)
