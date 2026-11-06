/**
 * General office pack. The Office engine's agents (lib/office: receivables, lead follow-up, inbox handling,
 * the meeting scheduler) are reused as they are, with their policies, grants and case lifecycle; this module
 * wires them to events and to the shared loop: an event (or a due sweep) runs the organization's active
 * agents of the matching kind, and the run is verified by reading its office_runs record back.
 * Quote follow-ups, review requests and crew updates reuse the home-services agents on office work orders.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { onEvent, type AgentEvent } from '../events'
import { runOfficeAgent } from '../office/run'
import { acquireOrgLock, releaseOrgLock } from '../office/scheduler'
import { registerPackAgents, type PackAgent } from './registry'
import { runPackLoop, type PackOutcome } from './loop'
import { orgPacks } from './settings'
import { sweepDispatch, sweepPayments, sweepQuotes, sweepReviews } from './home-services'
import { eventNow, rowProof } from './kit'

const PACK = 'office' as const
const PATH = '/store/packs/office'
export const OFFICE_AGENTS: PackAgent[] = [
  { key: 'office_overdue_invoices', name: 'Overdue invoices', pack: PACK, job: 'Chases overdue QuickBooks invoices and confirms payment from a fresh QuickBooks read.', triggers: ['quickbooks.invoice', 'quickbooks.payment', 'sweep'], actions: ['send_customer_email'], status: 'working', shopifyReady: true },
  { key: 'office_lead_followup', name: 'Lead follow-up', pack: PACK, job: 'Follows up new CRM leads on a cadence until they reply.', triggers: ['crm.lead.created', 'sweep'], actions: ['send_customer_email', 'update_crm'], status: 'working', shopifyReady: false },
  { key: 'office_inbox_triage', name: 'Inbox triage', pack: PACK, job: 'Sorts incoming mail, answers what it can and flags what needs you.', triggers: ['mail.received', 'sweep'], actions: ['send_customer_email'], status: 'working', shopifyReady: true },
  { key: 'office_scheduling', name: 'Scheduling', pack: PACK, job: 'Offers meeting times from your calendar and books the one picked.', triggers: ['mail.received', 'calendar.changed', 'sweep'], actions: ['book_appointment', 'send_customer_email'], status: 'working', shopifyReady: false },
  { key: 'office_quote_followup', name: 'Quote follow-up', pack: PACK, job: 'Follows up quotes that went quiet and records a yes or no.', triggers: ['sweep', 'mail.received'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'office_review_request', name: 'Review requests', pack: PACK, job: 'Thanks customers after a paid job and asks for a review.', triggers: ['sweep'], actions: ['send_customer_email'], status: 'synthetic_only', shopifyReady: false },
  { key: 'office_crew_updates', name: 'Crew updates', pack: PACK, job: 'Sends a job to the crew member or packer doing it, chases a confirmation, and invoices on DONE.', triggers: ['sweep', 'crew.done', 'crew.confirmed'], actions: ['notify_crew', 'invoice_send'], status: 'synthetic_only', shopifyReady: true },
]
registerPackAgents(OFFICE_AGENTS)

/** Which Office engine agent kinds each pack agent runs. */
export const OFFICE_KINDS: Record<string, string[]> = {
  office_overdue_invoices: ['accounts_receivable'],
  office_lead_followup: ['lead_followup', 'crm_updater'],
  office_inbox_triage: ['email_operations', 'customer_reply'],
  office_scheduling: ['meeting_scheduler'],
}
const EVENT_AGENTS: Record<string, string[]> = {
  'quickbooks.invoice': ['office_overdue_invoices'], 'quickbooks.payment': ['office_overdue_invoices'],
  'crm.lead.created': ['office_lead_followup'], 'mail.received': ['office_inbox_triage', 'office_scheduling'], 'calendar.changed': ['office_scheduling'],
}

/** Run the organization's active Office engine agents for one pack agent, through the loop. */
export async function runOfficeKind(db: Db, e: AgentEvent, packAgent: string, opts: { dueOnly?: boolean } = {}): Promise<PackOutcome[]> {
  const now = eventNow(e)
  const agents = await db.query<{ id: string; kind: string; name: string }>(`select id, kind, name from office_agents where org_id = $1 and status = 'active' and kind = any($2::text[])
    ${opts.dueOnly ? 'and (next_run_at is null or next_run_at <= $3)' : 'and $3::timestamptz is not null'} order by created_at limit 10`, [e.orgId, OFFICE_KINDS[packAgent], now.toISOString()])
  const name = OFFICE_AGENTS.find(a => a.key === packAgent)!.name
  const out: PackOutcome[] = []
  for (const a of agents) {
    out.push(await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: packAgent, agentName: name, actionType: packAgent === 'office_scheduling' ? 'book_appointment' : 'send_customer_email', problemKey: `office:${a.id}:${e.type}:${e.externalId}`, detailsPath: PATH,
      detect: async () => a,
      describe: () => ({ title: `${a.name} ran (${e.type === 'sweep' ? 'scheduled check' : e.type})`, whatHappened: e.type === 'sweep' ? `${a.name} was due.` : `Something changed (${e.type}).`, whatIDid: [`Ran ${a.name} under the authorization you granted it.`] }),
      act: async (_d, p) => {
        const holder = `pack:${randomUUID()}`
        if (!(await acquireOrgLock(e.orgId, holder, now))) return { proof: [rowProof('Skipped', 'another run of your Office agents is in progress')] }
        try {
          const r = await runOfficeAgent(a.id, { trigger: 'schedule', now })
          Object.assign(p, { run: r })
          return { proof: [rowProof('Run', `${r.status}${r.reason ? `: ${r.reason}` : ''}`), ...Object.entries(r.counts ?? {}).slice(0, 8).map(([k, v]) => rowProof(k.replace(/_/g, ' '), String(v)))] }
        } finally { await releaseOrgLock(e.orgId, holder) }
      },
      verify: async (d, p) => {
        const run = (p as typeof p & { run?: { runId?: string; status: string } }).run
        if (!run?.runId) return { ok: false, proof: [rowProof('Run record', 'no run was recorded (the agent was busy or not active)')] }
        const r = await d.one<{ status: string; finished_at: string | null }>('select status, finished_at from office_runs where id = $1', [run.runId])
        return { ok: r?.status === 'completed' && Boolean(r.finished_at), proof: [rowProof('Run record on a fresh read', r ? `${r.status}` : 'missing')] }
      },
    }))
  }
  return out
}

export async function onOfficeEvent(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const keys = EVENT_AGENTS[e.type] ?? []
  const out: PackOutcome[] = []
  for (const k of keys) out.push(...await runOfficeKind(db, e, k))
  return out
}

export async function officeSweep(db: Db, e: AgentEvent) {
  const org = await orgPacks(db, e.orgId)
  if (!org.packs.includes(PACK)) return null
  const out: Record<string, PackOutcome[]> = {}
  for (const k of Object.keys(OFFICE_KINDS)) out[k] = await runOfficeKind(db, e, k, { dueOnly: true })
  out.office_quote_followup = await sweepQuotes(db, e, org, 'office')
  out.office_crew_updates = await sweepDispatch(db, e, org, 'office')
  out.office_payments = await sweepPayments(db, e, org, 'office')
  out.office_review_request = await sweepReviews(db, e, org, 'office')
  return out
}

export function registerOffice() {
  for (const t of Object.keys(EVENT_AGENTS)) onEvent(t, `office_pack:${t}`, async (db, e) => { await onOfficeEvent(db, e) })
  onEvent('sweep', 'office_sweep', async (db, e) => { await officeSweep(db, e) })
}
