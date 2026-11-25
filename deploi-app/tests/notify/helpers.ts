/** Shared setup for the owner/crew update tests: a fake Resend that records requests, env reset and cleanup. */
import { admin } from '../../lib/db'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { RESEND_EMAILS_URL } from '../../lib/email/system'
import { setChannelAdapter } from '../../lib/notify/channels'

export type Sent = { to: string[]; subject: string; html: string; text: string }
export const sent: Sent[] = []

export function fakeResend(fail = false) {
  sent.length = 0
  setEmailFetch(async (url, init) => {
    if (url !== RESEND_EMAILS_URL || init.method !== 'POST') throw new Error(`unexpected HTTP call in test: ${init.method} ${url}`)
    const b = JSON.parse(String(init.body)) as Sent
    sent.push(b)
    return fail ? new Response(JSON.stringify({ message: 'bad request' }), { status: 422 }) : new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 })
  })
}

const ENV = ['RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS', 'NOTIFY_SMS_PROVIDER', 'CREW_LINK_TTL_HOURS', 'MORNING_HOURLY_USD']
export function resetEnv() {
  setEmailFetch(null)
  setChannelAdapter(null)
  for (const k of ENV) delete process.env[k]
}

export async function cleanNotify(orgs: string[]) {
  await admin(async db => {
    for (const t of ['owner_updates', 'notify_outbox', 'crew_job_links', 'crew_messages', 'crew_jobs', 'crew_members', 'morning_reports', 'notify_preferences']) await db.query(`delete from ${t} where org_id = any($1)`, [orgs])
    await db.query(`delete from system_emails where org_id = any($1) and template in ('agent_update', 'agent_action_needed', 'crew_jobs', 'morning_report')`, [orgs])
    await db.query(`delete from jobs where kind = 'notify.morning' and org_id = any($1)`, [orgs])
  })
}

export const storedEmail = (id: string) => admin(db => db.one<{ status: string; subject: string; body_html: string; body_text: string; to_address: string; template: string }>('select status, subject, body_html, body_text, to_address, template from system_emails where id = $1', [id]))
