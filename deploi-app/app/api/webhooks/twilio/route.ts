/**
 * Twilio inbound SMS. Routes "YES"/"NO" from aides (open-shift offers) and
 * screen answers from applicants. Every outbound reply is still a proposal.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { verifyTwilio } from '@/lib/workers/webhooks'
import '@/workers'
import { handleAideReply } from '@/workers/open_shift_fill'
import { handleApplicantReply, type ApplicantRow } from '@/workers/applicant_screening'
import { loadAgency, sendProposedAction } from '@/lib/workers/runtime'
import type { Proposal } from '@/lib/workers/types'

const twiml = (msg?: string) => new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg}</Message>` : ''}</Response>`, { headers: { 'content-type': 'text/xml' } })

export async function POST(req: Request) {
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

  const result = await admin(async db => {
    const aide = await db.one<{ id: string; agency_id: string; first_name: string; last_name: string }>('select id, agency_id, first_name, last_name from aides where phone = $1 limit 1', [from])
    if (aide) {
      const agency = await loadAgency(db, aide.agency_id)
      const r = await handleAideReply(db, aide, text, agency?.timezone ?? 'America/New_York')
      if (r.handled) return { kind: 'aide', agency, proposals: r.proposals, filled: r.filled }
    }
    const applicant = await db.one<ApplicantRow & { agency_id: string }>("select id, agency_id, first_name, last_name, phone, status, screen_state, screen_answers, screen_score, interview_at from applicants where phone = $1 and screen_state in ('q1','q2','q3','q4') order by applied_at desc limit 1", [from])
    if (applicant) {
      const agency = await loadAgency(db, applicant.agency_id)
      const r = await handleApplicantReply(db, applicant, text, agency?.capacity_rules?.counties ?? [])
      if (r.handled) return { kind: 'applicant', agency, proposals: r.proposals, filled: false }
    }
    return null
  })
  if (!result) { log.info('twilio.unmatched', {}); return twiml() }

  // Materialize follow-up proposals; auto-send them only if the agency toggle is on.
  const worker = result.kind === 'aide' ? 'open_shift_fill' : 'applicant_screening'
  const autoSend = result.agency?.auto_send?.[worker] === true
  await admin(async db => {
    for (const p of result.proposals as Proposal[]) {
      const row = await db.one<{ id: string }>(
        `insert into proposed_actions (agency_id, agency_name, worker, kind, to_ref, subject, body, payload, status, dedupe_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9) on conflict (dedupe_key) do nothing returning id`,
        [result.agency!.id, result.agency!.name, worker, p.kind, p.to_ref, p.subject ?? null, p.body, JSON.stringify(p.payload ?? {}), p.dedupe_key])
      if (row && autoSend) await sendProposedAction(db, row.id, { actorId: null })
    }
  })
  log.info('twilio.handled', { kind: result.kind, filled: result.filled, proposals: result.proposals.length })
  // Immediate TwiML reply is allowed for the person who just texted us (it is a reply, not an outbound campaign).
  if (result.kind === 'aide') return twiml(result.filled ? 'Got it, you are confirmed. Thank you!' : 'Thanks, noted.')
  const next = (result.proposals as Proposal[])[0]
  return twiml(next && autoSend ? undefined : next?.body)
}
