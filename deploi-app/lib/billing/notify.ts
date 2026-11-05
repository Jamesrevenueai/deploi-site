/**
 * Billing notices to the organization's owner: trial ending, payment failed, payment recovered, cancellation
 * scheduled, subscription ended, plan changed, read-only.
 *
 * Outbox: a notice is queued inside the transaction that learned about it (a webhook or the reminder job),
 * keyed by a dedupe key, so a redelivered or replayed event queues nothing new. deliverNotices() sends the
 * pending ones after that transaction commits (the webhook route, and the hourly cron for anything left).
 *
 * Sending goes through a small local interface (BillingNotifier). The default implementation is the system
 * mailer (lib/email/system.ts, `sendSystemEmail`) once integration wires it in `systemMailer` below; until
 * then a notice is recorded as skipped and logged, never sent from here. EMAIL_LIVE_SENDS gating stays in
 * the system mailer. Tests use recordingNotifier().
 */
import { admin, type Db } from '../db'
import { env } from '../env'
import { log } from '../log'

export type BillingNoticeKind = 'trial_ending' | 'payment_failed' | 'payment_recovered' | 'subscription_canceled' | 'cancel_scheduled' | 'plan_changed' | 'read_only'

export type BillingNotice = { id: string; orgId: string; kind: BillingNoticeKind; to: string; subject: string; body: string; link: string | null }
export type NoticeResult = { ok: true } | { ok: false; skipped?: boolean; error: string }

/** What billing needs from a mailer. */
export interface BillingNotifier { send(notice: BillingNotice): Promise<NoticeResult> }

/**
 * Integration point: when lib/email/system.ts exists, replace this body with
 *   return sendSystemEmail({ to: n.to, subject: n.subject, text: n.body, link: n.link, category: `billing.${n.kind}`, orgId: n.orgId })
 * (mapped to that function's own signature and result).
 */
async function systemMailer(n: BillingNotice): Promise<NoticeResult> {
  log.info('billing.notice.not_sent', { kind: n.kind, org: n.orgId, reason: 'system mailer not wired' })
  return { ok: false, skipped: true, error: 'the system mailer is not wired in this build' }
}

let current: BillingNotifier = { send: systemMailer }

/** Replace the notifier (integration, tests); null restores the default. */
export function setBillingNotifier(n: BillingNotifier | null) { current = n ?? { send: systemMailer } }

/** The recording fake: keeps every notice it is asked to send, sends nothing. */
export function recordingNotifier(opts: { fail?: boolean } = {}): BillingNotifier & { sent: BillingNotice[] } {
  const sent: BillingNotice[] = []
  return { sent, async send(n) { if (opts.fail) return { ok: false, error: 'recording notifier set to fail' }; sent.push(n); return { ok: true } } }
}

/** Where the owner updates the payment method: Stripe's customer-portal login link when configured, else the billing page (which opens the portal). */
export function portalLink(e: Record<string, string | undefined> = process.env): string {
  const login = (e.STRIPE_PORTAL_LOGIN_URL ?? '').trim()
  if (/^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9_]+$/.test(login)) return login
  return `${env.appUrl.replace(/\/$/, '')}/store/billing?portal=1`
}
export const billingPageLink = () => `${env.appUrl.replace(/\/$/, '')}/store/billing`

/** The organization's owner (the person who receives billing notices). */
export async function ownerEmail(db: Db, orgId: string): Promise<string | null> {
  const r = await db.one<{ email: string }>(`select email from profiles where agency_id = $1 and org_role = 'owner' and email is not null order by created_at, id limit 1`, [orgId])
  return r?.email ?? null
}

/** Queue a notice in the caller's transaction. Returns its id, or null when the dedupe key was already used. */
export async function queueNotice(db: Db, n: { orgId: string; kind: BillingNoticeKind; dedupeKey: string; subject: string; body: string; link?: string | null }): Promise<string | null> {
  const to = await ownerEmail(db, n.orgId)
  const r = await db.one<{ id: string }>(
    `insert into billing_notices (org_id, kind, dedupe_key, recipient, subject, body, link, status) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (dedupe_key) do nothing returning id`,
    [n.orgId, n.kind, n.dedupeKey.slice(0, 200), to, n.subject.slice(0, 200), n.body.slice(0, 4000), n.link ?? null, to ? 'pending' : 'skipped'])
  if (r && !to) await db.query(`update billing_notices set error = 'the organization has no owner with an e-mail address' where id = $1`, [r.id])
  return r?.id ?? null
}

/** Send pending notices (optionally for one organization). Each is claimed before sending, so two runs never send one twice. */
export async function deliverNotices(opts: { orgId?: string; limit?: number; notifier?: BillingNotifier } = {}): Promise<{ sent: number; skipped: number; failed: number }> {
  const notifier = opts.notifier ?? current
  const out = { sent: 0, skipped: 0, failed: 0 }
  const due = await admin(db => db.query<{ id: string; org_id: string; kind: BillingNoticeKind; recipient: string; subject: string; body: string; link: string | null }>(
    `update billing_notices set attempts = attempts + 1 where id in (
       select id from billing_notices where status = 'pending' and attempts < 5 and ($1::uuid is null or org_id = $1) order by created_at limit $2 for update skip locked)
     returning id, org_id, kind, recipient, subject, body, link`, [opts.orgId ?? null, opts.limit ?? 50]))
  for (const n of due) {
    let r: NoticeResult
    try { r = await notifier.send({ id: n.id, orgId: n.org_id, kind: n.kind, to: n.recipient, subject: n.subject, body: n.body, link: n.link }) }
    catch (e) { r = { ok: false, error: (e as Error).message } }
    const status = r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed'
    // a failed send stays pending for the next run (up to 5 attempts)
    await admin(db => db.query(`update billing_notices set status = case when $2 = 'failed' and attempts < 5 then 'pending' else $2 end, sent_at = case when $2 = 'sent' then now() else sent_at end, error = $3 where id = $1`,
      [n.id, status, r.ok ? null : r.error.slice(0, 300)]))
    out[status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'failed']++
  }
  return out
}
