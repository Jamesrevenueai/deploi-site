/**
 * Twilio inbound SMS. Order: opt-out keywords (STOP…) -> urgent keywords -> aide YES/NO on a shift offer ->
 * applicant screening answer -> aide reply to a retention check-in -> unrecognized (admin task).
 * Every outbound reply beyond the TwiML acknowledgement is still a proposal. Urgent or unrecognized
 * messages get exactly one automated line ("A person will follow up") and a task for the admin.
 * Fails closed in production when TWILIO_AUTH_TOKEN is missing (503); verifies the signature whenever it is set.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { verifyTwilio } from '@/lib/workers/webhooks'
import { webhookSecretGuard, guardResponse } from '@/lib/workers/webhook-guard'
import { classifyInbound, phoneToken, PERSON_WILL_FOLLOW_UP, OPT_OUT_CONFIRMATION } from '@/lib/workers/inbound'
import { recordOptOut, suppressApplicantFollowups } from '@/lib/workers/suppress'
import { opsConfig } from '@/lib/workers/config'
import '@/workers'
import { handleAideReply } from '@/workers/open_shift_fill'
import { handleApplicantReply, type ApplicantRow } from '@/workers/applicant_screening'
import { handleCheckinReply } from '@/workers/retention_checkins'
import { loadAgency, insertProposal, sendProposedAction } from '@/lib/workers/runtime'
import type { Proposal } from '@/lib/workers/types'

const twiml = (msg?: string) => new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg}</Message>` : ''}</Response>`, { headers: { 'content-type': 'text/xml' } })

type Matched = { kind: 'aide' | 'applicant' | 'checkin'; agency: NonNullable<Awaited<ReturnType<typeof loadAgency>>>; proposals: Proposal[]; filled: boolean }

/** Any agency that has this number on file (aide, applicant or family) — used to file the admin task. */
async function agencyForPhone(db: Parameters<typeof loadAgency>[0], phone: string) {
  const r = await db.one<{ agency_id: string }>(
    `select agency_id from aides where phone = $1 union all select agency_id from applicants where phone = $1 union all select agency_id from clients where family_phone = $1 limit 1`, [phone])
  return r ? loadAgency(db, r.agency_id) : null
}

export async function POST(req: Request) {
  const refused = guardResponse('twilio', webhookSecretGuard('twilio', env.twilio.token, opsConfig.isProd))
  if (refused) return refused
  const raw = await req.text()
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>
  if (env.twilio.token) {
    const url = `${env.appUrl}/api/webhooks/twilio`
    if (!verifyTwilio(env.twilio.token, url, params, req.headers.get('x-twilio-signature'))) {
      log.warn('twilio.signature.invalid', {})
      return NextResponse.json({ ok: false }, { status: 403 })
    }
  }
  const from = (params.From ?? '').trim()
  const text = params.Body ?? ''
  if (!from) return twiml()

  const cls = classifyInbound(text)
  if (cls === 'opt_out') {
    const r = await admin(db => recordOptOut(db, from))
    log.info('twilio.opt_out', { matched: r.matched, suppressed: r.suppressed })
    return twiml(OPT_OUT_CONFIRMATION)
  }
  if (cls === 'urgent') {
    await admin(async db => {
      const agency = await agencyForPhone(db, from)
      if (!agency) return
      await insertProposal(db, agency, 'inbound_triage', {
        kind: 'task', to_ref: 'admin', subject: 'Urgent inbound text: a person must follow up now',
        body: `An inbound text matched an urgent keyword. Message: "${text.trim().slice(0, 300)}". Call the sender back; no automated reply was sent beyond "A person will follow up".`,
        payload: { to_label: 'Admin', reason: 'urgent_keyword', phone_token: phoneToken(from) },
        dedupe_key: `inbound:urgent:${phoneToken(from)}:${new Date().toISOString().slice(0, 13)}`,
      })
    })
    log.warn('twilio.urgent', { phone_token: phoneToken(from) })
    return twiml(PERSON_WILL_FOLLOW_UP)
  }

  const receivedAt = new Date()
  const result = await admin(async (db): Promise<Matched | null> => {
    const aide = await db.one<{ id: string; agency_id: string; first_name: string; last_name: string }>('select id, agency_id, first_name, last_name from aides where phone = $1 limit 1', [from])
    if (aide) {
      const agency = await loadAgency(db, aide.agency_id)
      if (agency) {
        const r = await handleAideReply(db, aide, text, agency.timezone ?? 'America/New_York')
        if (r.handled) return { kind: 'aide', agency, proposals: r.proposals, filled: Boolean(r.filled) }
        const c = await handleCheckinReply(db, aide, text)
        if (c.handled) return { kind: 'checkin', agency, proposals: c.proposals, filled: false }
      }
    }
    const applicant = await db.one<ApplicantRow & { agency_id: string }>("select id, agency_id, first_name, last_name, phone, status, screen_state, screen_answers, screen_score, interview_at from applicants where phone = $1 and screen_state in ('q1','q2','q3','q4') order by applied_at desc limit 1", [from])
    if (applicant) {
      const agency = await loadAgency(db, applicant.agency_id)
      if (agency) {
        const r = await handleApplicantReply(db, applicant, text, agency.capacity_rules?.counties ?? [])
        if (r.handled) {
          // the applicant replied: earlier pending screening texts are obsolete; the next question is proposed below
          await suppressApplicantFollowups(db, agency.id, applicant.id, receivedAt)
          return { kind: 'applicant', agency, proposals: r.proposals, filled: false }
        }
      }
    }
    return null
  })

  if (!result) {
    // Out of scope for every handler: a task for the admin, one fixed line back, never a generated answer.
    await admin(async db => {
      const agency = await agencyForPhone(db, from)
      if (!agency) return
      await insertProposal(db, agency, 'inbound_triage', {
        kind: 'task', to_ref: 'admin', subject: 'Inbound text needs a person',
        body: `A text arrived that no workflow recognizes. Message: "${text.trim().slice(0, 300)}". Reply from the office.`,
        payload: { to_label: 'Admin', reason: 'unrecognized', phone_token: phoneToken(from) },
        dedupe_key: `inbound:unrecognized:${phoneToken(from)}:${new Date().toISOString().slice(0, 13)}`,
      })
    })
    log.info('twilio.unmatched', {})
    return twiml(PERSON_WILL_FOLLOW_UP)
  }

  // Materialize follow-up proposals; auto-send them only if the agency toggle is on.
  const worker = result.kind === 'aide' ? 'open_shift_fill' : result.kind === 'checkin' ? 'retention_checkins' : 'applicant_screening'
  const autoSend = result.agency.auto_send?.[worker] === true
  await admin(async db => {
    for (const p of result.proposals) {
      const id = await insertProposal(db, result.agency, worker, p)
      if (id && autoSend && p.kind !== 'task') await sendProposedAction(db, id, { actorId: null })
    }
  })
  log.info('twilio.handled', { kind: result.kind, filled: result.filled, proposals: result.proposals.length })
  // Immediate TwiML reply is allowed for the person who just texted us (it is a reply, not an outbound campaign).
  if (result.kind === 'aide') return twiml(result.filled ? 'Got it, you are confirmed. Thank you!' : 'Thanks, noted.')
  if (result.kind === 'checkin') return twiml(PERSON_WILL_FOLLOW_UP)
  const next = result.proposals[0]
  return twiml(next && autoSend ? undefined : next?.body)
}
