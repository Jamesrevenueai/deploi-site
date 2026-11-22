/**
 * Every message a pack agent writes, as a template filled from structured data only (the lead's name, the
 * business, the stated criteria, the calendar slots, the job or invoice record). Nothing is generated: the
 * same inputs always produce the same message. Incoming mail is never quoted back.
 */
import type { Slot } from '../office/slots'
import { formatDate, formatMoney } from '../office/receivables'
import type { Trade } from './settings'

export type Draft = { subject: string; body: string }
const clean = (s: string | null | undefined, n = 60) => (s ?? '').replace(/[\r\n<>{}]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
/** The name a message greets: the first word of the name the lead gave, or "there". */
export const greetName = (name: string | null | undefined) => clean(name, 60).split(' ')[0] || 'there'
const sign = (business: string) => `\n\nBest regards,\n${clean(business, 80)}`
const slotList = (slots: Slot[]) => slots.map((s, i) => `${i + 1}. ${s.label}`).join('\n')

// ---------------------------------------------------------------- home services

const TRADE_LINE: Record<Trade, { job: string; line: string }> = {
  construction: { job: 'your project', line: 'We would like to see the space, take measurements and talk through what you have in mind before we price it.' },
  hvac: { job: 'your heating or cooling', line: 'If you have no heat or no cooling right now, reply with the word URGENT and we will call you first.' },
  roofing: { job: 'your roof', line: 'If water is coming in right now, reply with the word URGENT and we will get someone out as soon as we can.' },
  landscaping: { job: 'your yard', line: 'We will walk the property with you, note what you want done and give you a written quote.' },
  cleaning: { job: 'your cleaning', line: 'We will look at the space, agree what is included and give you a fixed price.' },
  general: { job: 'your request', line: 'We will take a look and give you a written quote.' },
}
export const tradeJob = (t: Trade) => TRADE_LINE[t].job

export function homeLeadReply(o: { name: string | null; business: string; trade: Trade; slots: Slot[]; horizonDays: number }): Draft {
  const t = TRADE_LINE[o.trade]
  const times = o.slots.length
    ? `We can come out for a free quote at any of these times:\n\n${slotList(o.slots)}\n\nReply with 1, 2 or 3 and we will confirm. If none of these suit you, reply with a day and time that does.`
    : `Our calendar is full for the next ${o.horizonDays} days. Reply with a few days and times that suit you and we will fit you in as soon as we can.`
  return { subject: `Your quote request with ${clean(o.business, 80)}`, body: `Hi ${greetName(o.name)},\n\nThanks for contacting ${clean(o.business, 80)} about ${t.job}. ${t.line}\n\n${times}${sign(o.business)}` }
}

export function bookingConfirmation(o: { name: string | null; business: string; what: string; slot: Slot; address?: string | null; extra?: string | null }): Draft {
  return { subject: `Confirmed: ${o.what} on ${o.slot.label}`, body: `Hi ${greetName(o.name)},\n\nYou are booked: ${o.what} on ${o.slot.label}.${o.address ? `\nAddress: ${clean(o.address, 200)}` : ''}${o.extra ? `\n\n${o.extra}` : ''}\n\nIf you need to change the time, just reply to this email.${sign(o.business)}` }
}

export function slotsAgain(o: { name: string | null; business: string; slots: Slot[] }): Draft {
  return { subject: `Times that are still open`, body: `Hi ${greetName(o.name)},\n\nThat time is no longer free. These times are open:\n\n${slotList(o.slots)}\n\nReply with 1, 2 or 3 and we will confirm.${sign(o.business)}` }
}

export function quoteFollowUp(o: { name: string | null; business: string; ref: string; amount: string; n: number; max: number }): Draft {
  const line = o.n >= o.max
    ? 'This is our last note about it. If the timing is better later, reply any time and we will pick it up.'
    : 'We wanted to check whether you had any questions about the quote. Reply YES to go ahead, or tell us what you would like changed.'
  return { subject: `Your quote ${clean(o.ref, 40)} from ${clean(o.business, 80)}`, body: `Hi ${greetName(o.name)},\n\nWe sent you quote ${clean(o.ref, 40)} for ${o.amount}. ${line}${sign(o.business)}` }
}

export function crewDispatch(o: { crewName: string; ref: string; when: string; address: string | null; customer: string | null; phone: string | null; description: string }): { subject: string; body: string } {
  return {
    subject: `Job ${clean(o.ref, 40)}: ${o.when}`,
    body: `Hi ${greetName(o.crewName)},\n\nYou are on job ${clean(o.ref, 40)}.\nWhen: ${o.when}\nWhere: ${clean(o.address, 200) || 'see the job notes'}\nCustomer: ${clean(o.customer, 80) || 'on file'}${o.phone ? ` (${clean(o.phone, 40)})` : ''}\nWork: ${clean(o.description, 500) || 'see the job notes'}\n\nReply CONFIRM when you have it, and DONE when the job is finished.`,
  }
}

export function paymentThanksReview(o: { name: string | null; business: string; reviewUrl: string }): Draft {
  return { subject: `Thank you from ${clean(o.business, 80)}`, body: `Hi ${greetName(o.name)},\n\nThank you for your payment, and for choosing us. If you were happy with the work, a short review helps other customers find us:\n${o.reviewUrl}\n\nIf anything was not right, reply to this email and we will make it right.${sign(o.business)}` }
}

export function invoiceNotice(o: { name: string | null; business: string; number: string; amount: string; due: string; ref: string }): Draft {
  return { subject: `Invoice ${clean(o.number, 40)} for job ${clean(o.ref, 40)}`, body: `Hi ${greetName(o.name)},\n\nThanks for having us out. Invoice ${clean(o.number, 40)} for ${o.amount} is attached in the email from our accounting system, due ${o.due}.${sign(o.business)}` }
}

// ---------------------------------------------------------------- leasing (fair housing: identical for everyone)

export type LeasingCriteria = { budget?: number | null; moveIn?: string | null; bedrooms?: number | null; pets?: boolean | null }
export type ListingView = { unit: string; property: string; bedrooms: number; rent: number; availableFrom: string | null; petsAllowed: boolean; applicationUrl: string | null }
export const QUALIFYING_QUESTIONS: { key: keyof LeasingCriteria; question: string }[] = [
  { key: 'budget', question: 'What is your monthly budget for rent?' },
  { key: 'moveIn', question: 'What date would you like to move in?' },
  { key: 'bedrooms', question: 'How many bedrooms do you need?' },
  { key: 'pets', question: 'Will any pets live with you? (Assistance animals are not pets.)' },
]
export const missingCriteria = (c: LeasingCriteria) => QUALIFYING_QUESTIONS.filter(q => c[q.key] === undefined || c[q.key] === null)
const FAIR = 'We ask every renter the same questions and apply the same written criteria to every application.'
const bedLabel = (n: number) => (n === 0 ? 'studio' : `${n} bedroom${n === 1 ? '' : 's'}`)

export function criteriaLine(c: LeasingCriteria, currency: string): string {
  return `budget up to ${formatMoney(c.budget ?? 0, currency)} a month, move-in ${formatDate(c.moveIn ?? null)}, ${bedLabel(c.bedrooms ?? 0)}, pets: ${c.pets ? 'yes' : 'no'}`
}

export function leasingReply(o: { name: string | null; business: string; criteria: LeasingCriteria; listings: ListingView[]; slots: Slot[]; currency: string; applicationUrl: string | null }): Draft {
  const missing = missingCriteria(o.criteria)
  const subject = `Your rental inquiry with ${clean(o.business, 80)}`
  if (missing.length) {
    return { subject, body: `Hi ${greetName(o.name)},\n\nThanks for your interest. To match you with available apartments, please answer these questions:\n\n${missing.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n\n${FAIR}${sign(o.business)}` }
  }
  const listed = o.listings.length
    ? `These apartments match what you told us (${criteriaLine(o.criteria, o.currency)}):\n\n${o.listings.map(l => `- ${clean(l.property, 80)}, unit ${clean(l.unit, 20)}: ${bedLabel(l.bedrooms)}, ${formatMoney(l.rent, o.currency)} a month, available ${l.availableFrom ? formatDate(l.availableFrom) : 'now'}${l.applicationUrl ? `. Apply: ${l.applicationUrl}` : ''}`).join('\n')}`
    : `No apartment we list matches all of what you told us (${criteriaLine(o.criteria, o.currency)}) right now. We will email you as soon as one does.`
  const tours = o.listings.length && o.slots.length ? `\n\nWe can show you around at any of these times:\n\n${slotList(o.slots)}\n\nReply with 1, 2 or 3 to book a tour.` : ''
  const apply = o.listings.length && o.applicationUrl ? `\n\nYou can apply online at any time: ${o.applicationUrl}` : ''
  return { subject, body: `Hi ${greetName(o.name)},\n\nThanks for your interest. ${listed}${tours}${apply}\n\n${FAIR}${sign(o.business)}` }
}

export function tourReminder(o: { name: string | null; business: string; when: string; applicationUrl: string | null }): Draft {
  return { subject: `Reminder: your tour on ${o.when}`, body: `Hi ${greetName(o.name)},\n\nA reminder that your tour is on ${o.when}.${o.applicationUrl ? `\n\nYou can apply online at any time: ${o.applicationUrl}` : ''}\n\nIf you need to change the time, just reply to this email.\n\n${FAIR}${sign(o.business)}` }
}

export function leadFollowUp(o: { name: string | null; business: string; n: number; max: number; fair: boolean }): Draft {
  const line = o.n >= o.max ? 'This is our last note for now. Reply any time and we will pick it up.' : 'We wanted to check whether you are still looking and whether you have any questions.'
  return { subject: `Following up from ${clean(o.business, 80)}`, body: `Hi ${greetName(o.name)},\n\n${line}${o.fair ? `\n\n${FAIR}` : ''}${sign(o.business)}` }
}

export type CommissionLine = { tenant: string; unit: string; moveIn: string; rent: number; rule: string; commission: number }
export function commissionInvoice(o: { business: string; property: string; contact: string | null; number: string; issued: string; due: string; lines: CommissionLine[]; total: number; currency: string }): Draft {
  const rows = o.lines.map(l => `- ${clean(l.tenant, 80)}, unit ${clean(l.unit, 20)}, moved in ${formatDate(l.moveIn)}, rent ${formatMoney(l.rent, o.currency)}, ${l.rule}: ${formatMoney(l.commission, o.currency)}`).join('\n')
  return {
    subject: `Invoice ${o.number}: leasing commission for ${clean(o.property, 80)}`,
    body: `Hello ${greetName(o.contact)},\n\nPlease find our commission invoice ${o.number} for ${clean(o.property, 80)}, issued ${formatDate(o.issued)} and due ${formatDate(o.due)}.\n\n${rows}\n\nTotal due: ${formatMoney(o.total, o.currency)}\n\nPlease reply if anything on it is not right.${sign(o.business)}`,
  }
}

// ---------------------------------------------------------------- real estate (fair housing applies too)

export function buyerReply(o: { name: string | null; business: string; slots: Slot[] }): Draft {
  return {
    subject: `Your home search with ${clean(o.business, 80)}`,
    body: `Hi ${greetName(o.name)},\n\nThanks for reaching out. To send you homes that fit, we ask every buyer the same questions:\n\n1. What price range are you looking in?\n2. How many bedrooms do you need?\n3. When would you like to move?\n4. Are you pre-approved for a mortgage, or paying cash?\n\n${o.slots.length ? `If you would like to see a home or talk it through, these times are open:\n\n${slotList(o.slots)}\n\nReply with 1, 2 or 3 and we will confirm.` : 'Reply with a few times that suit you and we will set up a call.'}\n\n${FAIR.replace('renter', 'buyer').replace('every application', 'every buyer')}${sign(o.business)}`,
  }
}
export function sellerReply(o: { name: string | null; business: string; slots: Slot[] }): Draft {
  return {
    subject: `Selling your home with ${clean(o.business, 80)}`,
    body: `Hi ${greetName(o.name)},\n\nThanks for reaching out about selling. We would like to see the property and give you a free market valuation.\n\n1. What is the property address?\n2. When would you like to sell?\n\n${o.slots.length ? `We can meet at any of these times:\n\n${slotList(o.slots)}\n\nReply with 1, 2 or 3 and we will confirm.` : 'Reply with a few times that suit you and we will set up a visit.'}${sign(o.business)}`,
  }
}

// ---------------------------------------------------------------- property management

export function maintenanceAck(o: { name: string | null; business: string; category: string; emergency: boolean }): Draft {
  return {
    subject: `We received your maintenance request`,
    body: `Hi ${greetName(o.name)},\n\nWe received your ${o.category} request and are arranging a vendor now.${o.emergency ? ' Because it sounds urgent, we have marked it as an emergency.' : ''} We will email you as soon as a visit is booked.\n\nIf there is a fire, gas smell or flooding, call 911 or your local emergency number first.${sign(o.business)}`,
  }
}
export function vendorDispatch(o: { vendor: string; business: string; ref: string; property: string | null; unit: string | null; category: string; description: string; emergency: boolean; tenant: string | null; tenantPhone: string | null }): Draft {
  return {
    subject: `${o.emergency ? 'EMERGENCY ' : ''}Work order ${clean(o.ref, 40)}: ${o.category} at ${clean(o.property, 80) || 'the property'}${o.unit ? `, unit ${clean(o.unit, 20)}` : ''}`,
    body: `Hello ${greetName(o.vendor)},\n\nPlease take work order ${clean(o.ref, 40)}.\nProperty: ${clean(o.property, 120) || 'on file'}${o.unit ? `, unit ${clean(o.unit, 20)}` : ''}\nIssue: ${o.category}: ${clean(o.description, 500)}\nTenant: ${clean(o.tenant, 80) || 'on file'}${o.tenantPhone ? ` (${clean(o.tenantPhone, 40)})` : ''}\n\nReply ACCEPT with the day you can go, or DECLINE if you cannot take it. Reply FIXED when the work is done.${sign(o.business)}`,
  }
}
export function tenantUpdate(o: { name: string | null; business: string; line: string }): Draft {
  return { subject: `Update on your maintenance request`, body: `Hi ${greetName(o.name)},\n\n${o.line}${sign(o.business)}` }
}
export function fixConfirmRequest(o: { name: string | null; business: string; category: string }): Draft {
  return { subject: `Is your ${o.category} issue fixed?`, body: `Hi ${greetName(o.name)},\n\nOur vendor tells us the ${o.category} issue is fixed. Reply YES if it is, or NO and tell us what is still wrong, and we will send them back.${sign(o.business)}` }
}
export function rentReminder(o: { name: string | null; business: string; amount: string; due: string; unit: string | null }): Draft {
  return { subject: `Rent reminder${o.unit ? ` for unit ${clean(o.unit, 20)}` : ''}`, body: `Hi ${greetName(o.name)},\n\nThis is a friendly reminder that rent of ${o.amount} was due on ${o.due}. If you have already paid, thank you, and please ignore this note.${sign(o.business)}` }
}
