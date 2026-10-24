/**
 * Inbound message classification: opt-out keywords, urgent keywords, everything else.
 * Pure. The Twilio route applies it before any handler runs.
 */
import { createHash } from 'node:crypto'
import { opsConfig } from './config'

export const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'cancel', 'end', 'quit', 'stopall']
export const OPT_IN_WORDS = ['start', 'unstop', 'yes']

export type InboundClass = 'opt_out' | 'urgent' | 'normal'

export function isOptOut(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '')
  return OPT_OUT_WORDS.includes(t)
}

export function isUrgent(text: string, keywords: string[] = opsConfig.urgentKeywords): boolean {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' '
  return keywords.some(k => k && t.includes(' ' + k.toLowerCase() + ' '))
}

export function classifyInbound(text: string, keywords?: string[]): InboundClass {
  if (isOptOut(text)) return 'opt_out'
  if (isUrgent(text, keywords)) return 'urgent'
  return 'normal'
}

/** Short stable token for a phone number so dedupe keys and logs never carry the number itself. */
export function phoneToken(phone: string): string {
  return createHash('sha256').update('deploi:phone:' + phone.replace(/\D/g, '')).digest('hex').slice(0, 12)
}

/** The only automated reply allowed for urgent or unrecognized messages. */
export const PERSON_WILL_FOLLOW_UP = 'Thank you. A person will follow up.'
export const OPT_OUT_CONFIRMATION = 'You are unsubscribed and will not receive further texts from us.'
