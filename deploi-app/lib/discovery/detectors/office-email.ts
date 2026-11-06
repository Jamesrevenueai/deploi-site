/**
 * Office discovery: unanswered inbox messages. Counts accepted inbound mail on the organization's mailboxes
 * (the Deploi office mailbox, synthetic test mailboxes, and connected Gmail / Outlook inboxes once Email Operations reads them)
 * with no reply in its conversation for N business hours, excluding automatic replies, suppressed senders,
 * spam-ish mail and conversations an Office lead or meeting owns — the same rule the Email Operations agent
 * applies (lib/office/email-ops.ts#unansweredInbound). Findings hold sender and time only, never the text.
 */
import { admin, type Db } from '../../db'
import { classifyEmail, emailDedupe, EMAIL_CATEGORY_LABEL, EMAIL_CRITERIA, unansweredInbound, DEFAULT_HOURS } from '../../office/email-ops'
import { inboundContent } from '../../office/case-sync'
import { registerDetector, type DiscoveryFinding } from '../registry'

export const UNANSWERED_HOURS = 4

async function mailboxes(db: Db, orgId: string) {
  return db.query<{ id: string; address: string }>(`select id, address from email_accounts where org_id = $1 and status = 'active' and ((provider = 'deploi' and office_mailbox) or provider = 'synthetic' or (provider in ('gmail', 'microsoft') and exists (select 1 from email_sync_state s where s.account_id = email_accounts.id and s.last_sync_at is not null)))`, [orgId])
}

export const officeEmailDetector = {
  key: 'office.unanswered_email',
  suite: 'office' as const,
  sourceApp: 'deploi_email',
  async available(db: Db, orgId: string) { return (await mailboxes(db, orgId)).length > 0 },
  async detect({ orgId, now }: { orgId: string; now: Date }) {
    const boxes = await admin(db => mailboxes(db, orgId))
    const cal = await admin(db => db.one<{ timezone: string | null }>(`select timezone from office_connections where org_id = $1 and provider = 'google_calendar' and status = 'active'`, [orgId]))
    const bh = { ...DEFAULT_HOURS, timezone: cal?.timezone || 'UTC' }
    const found = await admin(db => unansweredInbound(db, orgId, boxes.map(b => b.id), now, UNANSWERED_HOURS, bh))
    const findings: DiscoveryFinding[] = []
    for (const i of found) {
      const content = inboundContent(i)
      const category = classifyEmail(content.subject, content.text)
      if (category === 'spam_ish') continue
      const hours = Math.floor(i.business_minutes / 60)
      const box = boxes.find(b => b.id === i.account_id)?.address ?? 'the mailbox'
      findings.push({
        kind: 'email_unanswered', dedupeKey: emailDedupe(i), priority: category === 'customer_issue' ? 'high' : 'normal',
        title: `Unanswered ${EMAIL_CATEGORY_LABEL[category]} from ${i.from_address}`.slice(0, 300),
        problem: `A message to ${box} from ${i.from_address}, received ${new Date(i.received_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, has had no reply for ${hours} business hours.`,
        evidence: [{ label: `No reply for ${hours} business hours (message from ${i.from_address})`, source: 'deploi_email', observedAt: now.toISOString(), ref: { type: 'email_inbound', id: i.id }, detail: { category, business_hours: hours } }],
        records: [{ type: 'email_inbound', id: i.id, label: `Message from ${i.from_address}` }],
        verification: { criteria: EMAIL_CRITERIA, rule: { kind: 'email_unanswered' } },
      })
    }
    const agent = await admin(db => db.one(`select id from office_agents where org_id = $1 and kind = 'email_operations' and status = 'active'`, [orgId]))
    const n = findings.length
    return {
      findings, sourcesRead: boxes.map(b => `mailbox:${b.address} (senders and times; text only sorted, never stored in a finding)`),
      recommendation: n && !agent ? { template: 'email_operations', suite: 'office' as const, name: 'Email Operations',
        reason: `${n} message${n === 1 ? '' : 's'} in your mailbox ${n === 1 ? 'has' : 'have'} had no reply for more than ${UNANSWERED_HOURS} business hours`, needs: ['your sender name'] } : null,
    }
  },
}
registerDetector(officeEmailDetector)
