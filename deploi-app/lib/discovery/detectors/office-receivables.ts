/**
 * Discovery: overdue invoices in QuickBooks Online (Deploi Office). Reads open invoices through the
 * organization's QuickBooks connection (read only), applies the Accounts Receivable rules (the active AR
 * agent's, or the template defaults: 7 days past due, a billing email on the invoice, not excluded or marked
 * "disputed" / "no reminders" in its private note) and returns one `invoice_overdue` finding per invoice,
 * with the count and the open total per currency. Recommends the Accounts Receivable agent. Never acts.
 */
import { admin, type Db } from '../../db'
import { hasProduct } from '../../products'
import { registerDetector, type Detector, type DetectorResult, type DiscoveryFinding } from '../registry'
import { quickbooksFor } from '../../office/providers'
import { QBO_PAGE } from '../../office/quickbooks'
import { DEFAULT_RULES, formatMoney, overdueFinding, overdueStatus, type Rules, type Skip } from '../../office/receivables'
import { parseOfficePolicy } from '../../office/policy'
import { formatInTimeZone } from 'date-fns-tz'
import type { OfficeConnectionRow } from '../../office/connections'

const MAX_PAGES = 10

async function quickbooks(db: Db, orgId: string) {
  return db.one<OfficeConnectionRow>(`select * from office_connections where org_id = $1 and provider = 'quickbooks' and status = 'active'`, [orgId])
}

export const officeReceivablesDetector: Detector = {
  key: 'office-receivables',
  suite: 'office',
  sourceApp: 'quickbooks',
  async available(db, orgId) { return (await hasProduct(db, orgId, 'office')) && Boolean(await quickbooks(db, orgId)) },
  async detect({ orgId, now }): Promise<DetectorResult> {
    const { conn, agent, mailbox } = await admin(async db => ({
      conn: await quickbooks(db, orgId),
      agent: await db.one<{ policy: unknown }>(`select p.policy from office_agents a join office_agent_policies p on p.id = a.active_policy_id where a.org_id = $1 and a.kind = 'accounts_receivable' and a.status = 'active' order by a.created_at limit 1`, [orgId]),
      mailbox: await db.one(`select id from email_accounts where org_id = $1 and status = 'active' and can_send and (provider <> 'deploi' or office_mailbox) limit 1`, [orgId]),
    }))
    if (!conn) return { findings: [], recommendation: null, sourcesRead: [], notes: ['QuickBooks is not connected'] }
    const policy = agent ? parseOfficePolicy(agent.policy) : null
    const rules: Rules = policy?.receivables ? { overdueDays: policy.receivables.overdueDays, minBalance: policy.receivables.minBalance, excludeCustomerIds: policy.receivables.excludeCustomerIds } : DEFAULT_RULES
    const today = formatInTimeZone(now, policy?.timezone ?? 'UTC', 'yyyy-MM-dd')
    const api = quickbooksFor(conn)
    const findings: DiscoveryFinding[] = [], skipped: Partial<Record<Skip, number>> = {}, totals = new Map<string, number>()
    let start = 1, pages = 0
    for (; pages < MAX_PAGES; pages++) {
      const r = await api.listOpenInvoices({ startPosition: start, maxResults: QBO_PAGE })
      for (const inv of r.invoices) {
        const e = overdueStatus(inv, rules, today)
        if (!e.eligible) { if (e.daysOverdue >= rules.overdueDays) skipped[e.reason] = (skipped[e.reason] ?? 0) + 1; continue }
        const f = overdueFinding(conn.external_account_id, inv, e.daysOverdue)
        findings.push({ kind: f.kind, dedupeKey: f.dedupeKey, title: f.title, problem: f.problem, whyItMatters: f.whyItMatters, priority: f.priority, evidence: f.evidence, records: f.records, verification: f.verification })
        const cur = inv.currency ?? ''
        totals.set(cur, Math.round(((totals.get(cur) ?? 0) + inv.balance) * 100) / 100)
      }
      if (!r.next) break
      start = r.next
    }
    const total = [...totals.entries()].map(([c, v]) => formatMoney(v, c || null)).join(' + ')
    const notes: string[] = []
    if (skipped.no_billing_email) notes.push(`${skipped.no_billing_email} overdue invoice${skipped.no_billing_email === 1 ? ' has' : 's have'} no billing email in QuickBooks; add one to include ${skipped.no_billing_email === 1 ? 'it' : 'them'}`)
    if (skipped.marked_in_quickbooks) notes.push(`${skipped.marked_in_quickbooks} overdue invoice${skipped.marked_in_quickbooks === 1 ? ' is' : 's are'} marked disputed or "no reminders" in QuickBooks and left alone`)
    if (skipped.excluded_customer) notes.push(`${skipped.excluded_customer} overdue invoice${skipped.excluded_customer === 1 ? ' belongs' : 's belong'} to excluded customers`)
    if (pages >= MAX_PAGES) notes.push(`read the first ${MAX_PAGES * QBO_PAGE} open invoices only`)
    const recommendation = findings.length && !agent ? {
      template: 'accounts_receivable', suite: 'office' as const, name: 'Accounts Receivable',
      reason: `${findings.length} invoice${findings.length === 1 ? '' : 's'} in QuickBooks ${findings.length === 1 ? 'is' : 'are'} ${rules.overdueDays}+ days past due, ${total} open in total`,
      needs: [...(mailbox ? [] : ['a mailbox to send reminders from']), 'the name reminders are signed with'],
    } : null
    return { findings, recommendation, sourcesRead: [`quickbooks:${conn.external_account_id}:invoices`], notes }
  },
}

registerDetector(officeReceivablesDetector)
