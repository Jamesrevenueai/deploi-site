import { vi } from 'vitest'
import { admin } from '../../lib/db'
import { enableProduct } from '../../lib/products'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB, merchantActor, clearFirstDay } from '../merchant/helpers'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { connectSyntheticMailbox } from '../../lib/office/mailbox'
import { createOfficeAgent, grantOfficePolicy, editOfficeAgent } from '../../lib/office/agents'
import { officeTemplatePolicy } from '../../lib/office/templates'
import { mutateOfficeSynth, synthContact, type SynthContact } from '../../lib/office/synthetic'
import type { OfficeKind } from '../../lib/office/policy'
import type { OfficeActionRow } from '../../lib/office/actions'
import type { LeadRow, MeetingRow } from '../../lib/office/run'
import '../../lib/office/actions'

/** Test views of the rows: payload fields read directly (each test knows which kind it looks at). */
export type TestAction = Omit<OfficeActionRow, 'payload'> & { payload: { to: string; subject: string; body: string; eventId: string; summary: string; meta: Record<string, unknown> } }
export type TestLead = LeadRow & { last_touch_at: string; stop_reason: string | null }
export type TestMeeting = MeetingRow & { status_reason: string | null }
type Draft = Record<string, Record<string, unknown>>

export { NW, HB, merchantActor }

/** Remove every office record (and the org's email rows) for a merchant, and enable Office. */
export async function resetOffice(m: typeof NW, opts: { enable?: boolean } = {}) {
  await admin(async db => {
    await db.query(`delete from jobs where kind = 'case.check' and org_id = $1`, [m.org])
    await db.query(`delete from cases where org_id = $1 and suite = 'office'`, [m.org])
    await db.query('delete from email_suppressions where org_id = $1', [m.org])
    await db.query('delete from email_sender_rules where org_id = $1', [m.org])
    await db.query('delete from org_controls where org_id = $1', [m.org])
    await db.query('update office_agents set active_policy_id = null where org_id = $1', [m.org])
    await db.query('delete from email_messages where org_id = $1', [m.org])
    await db.query('delete from office_inbound_handled where org_id = $1', [m.org])
    await db.query('delete from office_actions where org_id = $1', [m.org])
    await db.query('delete from office_meetings where org_id = $1', [m.org])
    await db.query('delete from office_leads where org_id = $1', [m.org])
    await db.query('delete from office_runs where org_id = $1', [m.org])
    await db.query('delete from office_agent_policies where org_id = $1', [m.org])
    await db.query('delete from office_agents where org_id = $1', [m.org])
    await db.query('delete from office_connections where org_id = $1', [m.org])
    await db.query('delete from office_oauth_states where org_id = $1', [m.org])
    await db.query('delete from office_org_locks where org_id = $1', [m.org])
    await db.query('delete from email_inbound where org_id = $1', [m.org])
    await db.query('delete from email_oauth_states where org_id = $1', [m.org])
    await db.query('delete from email_accounts where org_id = $1', [m.org])
    // every merchant starts with Commerce (migration 20261104000036 backfills it; a freshly seeded test database has no row yet)
    await enableProduct(db, m.org, 'commerce', 'test')
    if (opts.enable !== false) await enableProduct(db, m.org, 'office', 'test')
    else await db.query(`update org_products set status = 'disabled' where org_id = $1 and product = 'office'`, [m.org])
  })
  await clearFirstDay(m.org)
}

/** 14:00 UTC today (outside the default quiet hours), so tests are independent of the wall clock. */
/** The most recent 14:00 UTC (outside the default quiet hours, never in the future), so tests do not depend on the wall clock. */
export function t0(): Date { const d = new Date(); d.setUTCHours(14, 0, 0, 0); if (d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1); return d }

/**
 * Code paths that read the clock themselves (approving an item and sending it, scheduler leases) must see the
 * test's time too, or a run at night lands in quiet hours. Fakes only Date (timers stay real); undo with
 * vi.useRealTimers().
 */
export function pinClock(at: Date) { vi.useFakeTimers({ toFake: ['Date'], now: at, shouldAdvanceTime: true }) }
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5)

export type OfficeSetup = { actor: Actor; hubspotId: string; calendarId: string; mailboxId: string }

export async function setupOffice(m: typeof NW, contacts: SynthContact[] = []): Promise<OfficeSetup> {
  await resetOffice(m)
  const actor = await merchantActor(m)
  const hub = await connectSyntheticOffice(actor, 'hubspot', { demoData: false })
  const cal = await connectSyntheticOffice(actor, 'google_calendar', { timezone: 'UTC' })
  const mb = await connectSyntheticMailbox(actor, `office@${m === NW ? 'northwind' : 'harbor'}-office.example`)
  if (contacts.length) await mutateOfficeSynth(hub.id, s => { s.contacts = contacts })
  return { actor, hubspotId: hub.id, calendarId: cal.id, mailboxId: mb.id }
}

export const lead = (id: string, email: string, at: Date, extra: Partial<SynthContact> = {}) =>
  synthContact(id, email, { firstName: 'Ana', company: 'Acme Studio', createdAt: at.toISOString(), updatedAt: at.toISOString(), ...extra })

type Tier = 'draft' | 'send_approved' | 'send_autonomous'

/** Template policy with the given tiers (autonomous gets an end date 60 days out) and overrides. */
export function policyFor(kind: OfficeKind, s: OfficeSetup, tiers: { email?: Tier; calendar?: Tier; crm?: Tier } = {}, patch: (p: Draft) => void = () => {}) {
  const p = officeTemplatePolicy(kind, { hubspotConnectionId: s.hubspotId, calendarConnectionId: s.calendarId, mailboxAccountId: s.mailboxId, timezone: 'UTC', senderName: 'Sam at Northwind', pitch: 'We make ceramic tableware for cafes.' }) as Draft
  const until = new Date(Date.now() + 60 * 864e5).toISOString()
  for (const t of ['email', 'calendar', 'crm'] as const) if (tiers[t] && p[t]) p[t] = { ...p[t], tier: tiers[t], validUntil: tiers[t] === 'send_autonomous' ? until : null }
  if (kind === 'meeting_scheduler') (p as Record<string, unknown>).hubspotConnectionId = null
  patch(p)
  return p
}

export async function grantedAgent(s: OfficeSetup, kind: OfficeKind, tiers: Parameters<typeof policyFor>[2] = {}, patch?: Parameters<typeof policyFor>[3], name?: string) {
  const r = await createOfficeAgent(s.actor, { kind, name: name ?? kind, policy: policyFor(kind, s, tiers, patch) })
  await grantOfficePolicy(s.actor, r.agentId, r.policyId, r.policyHash)
  return r.agentId
}

export async function widen(s: OfficeSetup, agentId: string, kind: OfficeKind, tiers: Parameters<typeof policyFor>[2], patch?: Parameters<typeof policyFor>[3]) {
  const e = await editOfficeAgent(s.actor, agentId, { policy: policyFor(kind, s, tiers, patch) })
  if (e.requiresGrant) await grantOfficePolicy(s.actor, agentId, e.policyId, e.policyHash)
  return e
}

export const actions = (agentId: string) => admin(db => db.query<TestAction>('select * from office_actions where agent_id = $1 order by created_at', [agentId]))
export const leads = (agentId: string) => admin(db => db.query<TestLead>('select * from office_leads where agent_id = $1 order by created_at', [agentId]))
