/** Office agent templates: pre-filled policies, drafts only for every tool. Granting is still the customer's step. */
import type { OfficeKind } from './policy'

export type OfficeTemplate = { key: OfficeKind; name: string; job: string; needs: ('hubspot' | 'calendar' | 'mailbox' | 'quickbooks')[] }

export const OFFICE_TEMPLATES: OfficeTemplate[] = [
  { key: 'lead_followup', name: 'Lead Follow-up', needs: ['hubspot', 'mailbox'],
    job: 'When a new lead appears in HubSpot, write them a short personal first email, then follow up in the same thread every few days until they reply (at most a few emails). Stop on reply, unsubscribe, opt-out or when they are no longer a lead.' },
  { key: 'meeting_scheduler', name: 'Meeting Scheduler', needs: ['calendar', 'mailbox'],
    job: 'When a lead asks to meet, find three free times in business hours from the calendar, propose them by email, book the one they pick and confirm.' },
  { key: 'crm_updater', name: 'CRM Updater', needs: ['hubspot'],
    job: 'Log every email and meeting as a note on the HubSpot contact, and move lifecycle or deal stages only by the rules you set.' },
  { key: 'customer_reply', name: 'Customer Reply', needs: ['mailbox'],
    job: 'Sort incoming replies and draft an answer to the sender. Sends only what your permission allows.' },
  { key: 'accounts_receivable', name: 'Accounts Receivable', needs: ['quickbooks', 'mailbox'],
    job: 'Find invoices in QuickBooks that are past due, write a polite reminder to the invoice\'s billing address with the exact number, amount and due date, follow up on a cadence, and close the case only when QuickBooks shows the invoice paid. Disputes and anything unclear come to you.' },
]
export const officeTemplate = (k: string) => OFFICE_TEMPLATES.find(t => t.key === k) ?? null

export type TemplateInput = { hubspotConnectionId?: string | null; calendarConnectionId?: string | null; quickbooksConnectionId?: string | null; mailboxAccountId?: string | null; timezone?: string; senderName?: string; pitch?: string }

/** The template's policy at drafts only for every tool. */
export function officeTemplatePolicy(kind: OfficeKind, i: TemplateInput): Record<string, unknown> {
  const base = { kind, timezone: i.timezone || 'UTC', hubspotConnectionId: i.hubspotConnectionId ?? null, calendarConnectionId: i.calendarConnectionId ?? null, mailboxAccountId: i.mailboxAccountId ?? null, schedule: { everyMinutes: 60 } }
  const senderName = (i.senderName || 'The team').slice(0, 80)
  const email = { tier: 'draft', validUntil: null, perDay: 20, quietHours: { start: '19:00', end: '08:00' } }
  if (kind === 'lead_followup') return { ...base, email, leadFollowup: { followupDays: 3, maxTouches: 3, lookbackDays: 2, senderName, pitch: (i.pitch || 'We help teams like yours save time every week.').slice(0, 600) } }
  if (kind === 'meeting_scheduler') return { ...base, hubspotConnectionId: null, email, calendar: { tier: 'draft', validUntil: null, allowMeet: false }, scheduler: { senderName } }
  if (kind === 'accounts_receivable') return { ...base, hubspotConnectionId: null, calendarConnectionId: null, quickbooksConnectionId: i.quickbooksConnectionId ?? null, email,
    receivables: { overdueDays: 7, cadenceDays: 7, maxReminders: 3, minBalance: 0, excludeCustomerIds: [], paidClaimGraceDays: 3, senderName } }
  if (kind === 'crm_updater') return { ...base, calendarConnectionId: null, mailboxAccountId: null, crm: { tier: 'draft', validUntil: null }, crmUpdater: { logEmails: true, logMeetings: true, rules: [] } }
  return { ...base, hubspotConnectionId: null, calendarConnectionId: null, email, customerReply: { senderName, sendCategories: [] } }
}
