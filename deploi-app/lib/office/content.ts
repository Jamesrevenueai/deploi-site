/**
 * What office agents write, and how incoming mail is sorted. Messages are built from templates and
 * structured CRM / calendar data only. Incoming mail is DATA: it is reduced to one category (and, for a
 * meeting reply, a slot number) and nothing else; its text can never add a recipient, change a
 * permission or start anything the policy does not already allow.
 */
import type { HubSpotContact } from './types'
import type { Slot } from './slots'

export type InboundCategory = 'unsubscribe' | 'slot_choice' | 'meeting_request' | 'question' | 'other'
export type EmailDraft = { subject: string; body: string }

const clean = (s: string | null | undefined, max = 60) => (s ?? '').replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const optOut = '\n\nIf you would rather not hear from us, reply "unsubscribe" and we will not email you again.'

export function firstTouch(c: Pick<HubSpotContact, 'firstName' | 'company'>, senderName: string, pitch: string): EmailDraft {
  const name = clean(c.firstName) || 'there'
  const company = clean(c.company, 80)
  return {
    subject: company ? `${company} and ${clean(senderName, 80)}` : `Hello from ${clean(senderName, 80)}`,
    body: `Hi ${name},\n\nThanks for getting in touch${company ? ` on behalf of ${company}` : ''}. ${pitch.trim()}\n\nWould a short call be useful? Reply to this email and I will send you a few times.\n\nBest,\n${clean(senderName, 80)}${optOut}`,
  }
}

export function followUp(c: Pick<HubSpotContact, 'firstName'>, senderName: string, firstSubject: string, touch: number): EmailDraft {
  const name = clean(c.firstName) || 'there'
  const lines = touch >= 3
    ? 'I do not want to crowd your inbox, so this is my last note for now. If the timing is better later, just reply and I will pick it up.'
    : 'Just following up on my note below, in case it got buried. Happy to answer any questions or find a time to talk.'
  return { subject: /^re:/i.test(firstSubject) ? firstSubject : `Re: ${firstSubject}`, body: `Hi ${name},\n\n${lines}\n\nBest,\n${clean(senderName, 80)}${optOut}` }
}

export function meetingProposal(name: string | null, senderName: string, slots: Slot[], subject: string | null, durationMin: number): EmailDraft {
  return {
    subject: subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : 'Times to meet',
    body: `Hi ${clean(name) || 'there'},\n\nThanks for your reply. Here are a few times for a ${durationMin}-minute call:\n\n${slots.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}\n\nReply with 1, 2 or 3 and I will send a calendar invitation.\n\nBest,\n${clean(senderName, 80)}`,
  }
}

export function meetingConfirmation(name: string | null, senderName: string, slot: Slot, meetLink: string | null, subject: string | null): EmailDraft {
  return {
    subject: subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : 'Meeting confirmed',
    body: `Hi ${clean(name) || 'there'},\n\nConfirmed: ${slot.label}. A calendar invitation is on its way to you.${meetLink ? `\n\nVideo link: ${meetLink}` : ''}\n\nBest,\n${clean(senderName, 80)}`,
  }
}

export function customerReplyDraft(category: InboundCategory, senderName: string, subject: string): EmailDraft {
  const body = category === 'question'
    ? 'Thanks for your question. We have received it and a member of the team will reply with a full answer shortly.'
    : category === 'meeting_request'
      ? 'Thanks for your message. We would be glad to find a time; a member of the team will send a few options shortly.'
      : 'Thanks for your message. We have received it and will get back to you shortly.'
  return { subject: /^re:/i.test(subject) ? subject.slice(0, 200) : `Re: ${clean(subject, 180) || 'your message'}`, body: `Hello,\n\n${body}\n\nBest,\n${clean(senderName, 80)}` }
}

/** The new part of a reply: quoted lines and everything after an "On ... wrote:" line are dropped. */
export function newText(text: string): string {
  const lines: string[] = []
  for (const l of text.replace(/\r/g, '').split('\n')) {
    if (/^On .{4,200} wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim())) break
    if (l.trim().startsWith('>')) continue
    lines.push(l)
  }
  return lines.join('\n').slice(0, 5000)
}

/** One category for an incoming message. `proposal`: the message replies to our 3-slot proposal. */
export function classifyInbound(subject: string, text: string, opts: { proposal?: boolean } = {}): { category: InboundCategory; slot: number | null } {
  const t = `${subject}\n${newText(text)}`.toLowerCase()
  if (/\b(unsubscribe|opt[ -]?out|remove me|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email))\b/.test(t)) return { category: 'unsubscribe', slot: null }
  if (opts.proposal) {
    const body = newText(text).toLowerCase()
    const m = /\b(?:option|number|no\.?|#|slot|choice)\s*([123])\b/.exec(body) ?? /^\s*([123])[.)]?\s*$/m.exec(body)
    const word = /\b(first|second|third)\b/.exec(body)
    const n = m ? Number(m[1]) : word ? ['first', 'second', 'third'].indexOf(word[1]) + 1 : null
    if (n) return { category: 'slot_choice', slot: n }
  }
  if (/\b(meet|meeting|call|chat|demo|schedule|calendar|availability|available|time to talk|book a time|zoom)\b/.test(t)) return { category: 'meeting_request', slot: null }
  if (t.includes('?')) return { category: 'question', slot: null }
  return { category: 'other', slot: null }
}

/** Short, unique token written into CRM notes and tasks so an uncertain write can be found again. */
export const crmMarker = (idempotencyKey: string, hash: (s: string) => string) => `deploi${hash(idempotencyKey).slice(0, 20)}`
