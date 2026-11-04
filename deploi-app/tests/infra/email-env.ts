/** Agent mailboxes against a fake Resend (no network): every POST /emails is recorded. */
import { setEmailFetch } from '../../lib/email/adapters/http'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { templatePolicy } from '../../lib/agents/templates'
import type { Actor } from '../../lib/engine/actor'
import type { NW } from '../merchant/helpers'

export const DOMAIN = 'agents.deploi.test'
export const SUPPLIER = 'orders@supplier.example'
export const sent: { body: Record<string, unknown>; headers: Record<string, string> }[] = []

export function fakeResend() {
  process.env.AGENT_MAIL_DOMAIN = DOMAIN
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.EMAIL_LIVE_SENDS = 'allowlist'
  process.env.EMAIL_TEST_RECIPIENTS = '@supplier.example'
  sent.length = 0
  setEmailFetch(async (url, init) => {
    if (url.endsWith('/emails') && init.method === 'POST') {
      sent.push({ body: JSON.parse(String(init.body)), headers: Object.fromEntries(new Headers(init.headers).entries()) })
      return new Response(JSON.stringify({ id: `re_${sent.length}_${Math.random().toString(16).slice(2, 8)}` }), { status: 200 })
    }
    throw new Error(`unexpected HTTP call in test: ${init.method} ${url}`)
  })
}
export function restoreEmail() {
  setEmailFetch(null)
  for (const k of ['AGENT_MAIL_DOMAIN', 'RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS', 'EMAIL_ORG_DAILY_CAP']) delete process.env[k]
}

/** A granted Supplier Chaser with its own mailbox that sends what the merchant approves. */
export async function chaser(actor: Actor, m: typeof NW, name = 'Chaser') {
  const raw = templatePolicy('supplier_chaser', { connectionId: m.conn, timezone: 'UTC', supplierAddress: SUPPLIER })
  const c = await createAgent(actor, { name, taskText: '', policy: { ...raw, email: { ...(raw.email as Record<string, unknown>), permission: 'send_approved' } }, mailbox: true })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return { agentId: c.agentId, mailbox: c.mailbox!.address }
}
