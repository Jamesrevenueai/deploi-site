/** Provider contracts for Deploi Office. Real clients (HubSpot, Google Calendar) and synthetic ones implement them. */

export type HubSpotContact = {
  id: string
  email: string | null
  firstName: string | null
  lastName: string | null
  company: string | null
  lifecycleStage: string | null
  /** HubSpot "Unsubscribed from all email" (hs_email_optout) */
  optedOut: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface HubSpotApi {
  /** contacts in lifecycle stage "lead" created or updated since `since`, oldest first; `next` pages on */
  searchLeads(opts: { since: Date; after?: string | null; limit: number }): Promise<{ contacts: HubSpotContact[]; next: string | null }>
  getContact(id: string): Promise<HubSpotContact | null>
  updateContact(id: string, properties: Record<string, string>): Promise<HubSpotContact>
  createNote(input: { contactId: string; body: string; timestamp: Date }): Promise<{ id: string }>
  getNote(id: string): Promise<{ id: string; body: string } | null>
  /** notes whose body contains this exact token (the action marker), for reconciliation after an uncertain write */
  findNoteByMarker(marker: string): Promise<{ id: string } | null>
  createTask(input: { contactId: string; subject: string; body: string; dueAt: Date }): Promise<{ id: string }>
  getTask(id: string): Promise<{ id: string; body: string } | null>
  findTaskByMarker(marker: string): Promise<{ id: string } | null>
  listContactDeals(contactId: string): Promise<string[]>
  getDeal(id: string): Promise<{ id: string; stage: string | null } | null>
  updateDealStage(id: string, stage: string): Promise<{ id: string; stage: string | null }>
}

export type BusyInterval = { start: string; end: string }
export type CalendarEvent = {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary: string
  start: string
  end: string
  attendees: string[]
  meetLink: string | null
  htmlLink: string | null
}
export type NewEvent = { id: string; summary: string; description: string; start: string; end: string; timeZone: string; attendees: string[]; meet: boolean; requestId: string }

export interface CalendarApi {
  freeBusy(input: { timeMin: string; timeMax: string; timeZone: string }): Promise<BusyInterval[]>
  /** idempotent: the event id is deterministic, so a repeat insert finds the existing event */
  insertEvent(e: NewEvent): Promise<CalendarEvent>
  getEvent(id: string): Promise<CalendarEvent | null>
  patchEvent(id: string, patch: { start: string; end: string; timeZone: string }): Promise<CalendarEvent>
  deleteEvent(id: string): Promise<'deleted' | 'already_gone'>
}
