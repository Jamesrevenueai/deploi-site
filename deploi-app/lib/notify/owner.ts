/**
 * notifyOwner: tell the organization's owners and admins what an agent did (or that it needs their decision).
 *
 *  - One update per (organization, dedupeKey): the first call claims it under a lock and records one
 *    owner_updates row per recipient and channel; a repeat returns the first outcome and sends nothing.
 *  - Email (on by default) goes through the system mailer (template agent_update, or agent_action_needed for
 *    severity 'action'), so it is held unless EMAIL_LIVE_SENDS allows the recipient. The Undo link is a
 *    secret param: the stored copy of the email never holds it.
 *  - Text and voice note (off by default) go through the channel adapter (simulated unless a provider is set).
 *  - digest 'daily': a routine (info) update is recorded as queued for the morning report instead of emailed.
 *  - digest: true on the update (an agent the owner set to autonomous): the same, whatever the person's preference.
 */
import { admin } from '../db'
import { env } from '../env'
import { log } from '../log'
import { sendSystemEmail } from '../email/system'
import type { NotifyResult, OwnerUpdate } from './index'
import { channelAdapter, clipText, OWNER_TEXT_LIMIT } from './channels'
import { updateRecipients } from './preferences'
import { appLink, safePath, type UpdateData } from './templates'

type Channel = 'email' | 'text' | 'voice' | 'digest'
type Planned = { channel: Channel; profileId: string | null; to: string | null; rowId?: string }
type Outcome = { status: 'sent' | 'held' | 'failed' | 'queued' | 'skipped'; reason: string | null; systemEmailId?: string | null; outboxId?: string | null }

/** The id that names an update: its first email delivery (else its first delivery), the same on every call. */
const updateId = (rows: { id?: string | null; channel: string }[]) => rows.filter(r => r.id).map(r => ({ id: r.id!, c: r.channel === 'email' ? 0 : 1 })).sort((a, b) => a.c - b.c || a.id.localeCompare(b.id))[0]?.id ?? null
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n)

function clean(u: OwnerUpdate): OwnerUpdate & { severity: 'info' | 'action' | 'warning' } {
  return {
    ...u,
    agentName: clip(u.agentName, 120) || 'Your agent', agentKey: clip(u.agentKey, 80) || 'agent', headline: clip(u.headline, 300) || 'An update',
    whatHappened: clip(u.whatHappened, 4000), whatIDid: (u.whatIDid ?? []).slice(0, 20).map(x => clip(x, 600)),
    proof: (u.proof ?? []).slice(0, 30).map(p => ({ label: clip(p.label, 120), value: clip(p.value, 600), url: p.url ? clip(p.url, 2000) : null })),
    detailsPath: safePath(u.detailsPath), caseRef: u.caseRef ? clip(u.caseRef, 40) : null,
    severity: u.severity === 'action' || u.severity === 'warning' ? u.severity : 'info',
  }
}

export const undoPath = (token: string) => `/undo/${encodeURIComponent(token)}`

/** The plain words a text message or voice note carries. */
export function shortUpdate(u: Pick<OwnerUpdate, 'agentName' | 'headline' | 'whatHappened' | 'severity'>, detailsUrl: string): string {
  const lead = u.severity === 'action' ? `${u.agentName} needs your OK: ${u.headline}.` : u.severity === 'warning' ? `${u.agentName} - please check: ${u.headline}.` : `${u.agentName}: ${u.headline}.`
  return `${clipText(`Deploi - ${lead} ${clipText(u.whatHappened, 200)}`, OWNER_TEXT_LIMIT - detailsUrl.length - 10)} Details: ${detailsUrl}`
}

export async function notifyOwnerImpl(input: OwnerUpdate): Promise<NotifyResult> {
  if (!input?.orgId || !/^[0-9a-f-]{36}$/i.test(input.orgId)) return { status: 'failed', id: null, reason: 'an organization id is required' }
  if (!input.dedupeKey || input.dedupeKey.length > 200) return { status: 'failed', id: null, reason: 'a dedupe key of 1 to 200 characters is required' }
  const u = clean(input)
  const kind = u.severity === 'action' ? 'action_needed' : 'update'
  const content = { whatHappened: u.whatHappened, whatIDid: u.whatIDid, proof: u.proof, detailsPath: u.detailsPath, hasUndo: Boolean(u.undoToken) }

  // claim the update (one per organization and dedupe key) and plan its deliveries
  const claim = await admin(async db => {
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 5959))`, [`owner-update:${u.orgId}:${u.dedupeKey}`])
    const prior = await db.query<{ id: string; channel: string; status: Outcome['status']; status_reason: string | null }>(
      `select id, channel, status, status_reason from owner_updates where org_id = $1 and dedupe_key = $2 order by created_at, id`, [u.orgId, u.dedupeKey])
    if (prior.length) return { duplicate: true as const, prior }
    const org = await db.one<{ name: string }>('select name from agencies where id = $1', [u.orgId])
    const people = await updateRecipients(db, u.orgId)
    const plan: Planned[] = []
    const urgent = u.severity !== 'info'
    // an autonomous agent's routine update goes to the morning report only
    const summaryOnly = !urgent && u.digest === true
    for (const p of people) {
      if (p.prefs.email) plan.push({ channel: !urgent && (p.prefs.digest === 'daily' || summaryOnly) ? 'digest' : 'email', profileId: p.profileId, to: p.email })
      if (p.prefs.text && p.prefs.phone && !summaryOnly) plan.push({ channel: 'text', profileId: p.profileId, to: p.prefs.phone })
      if (p.prefs.voice && p.prefs.phone && !summaryOnly && (urgent || p.prefs.digest !== 'daily')) plan.push({ channel: 'voice', profileId: p.profileId, to: p.prefs.phone })
    }
    const insert = (pl: Planned, status: Outcome['status'], reason: string | null) => db.one<{ id: string }>(
      `insert into owner_updates (org_id, dedupe_key, kind, agent_key, agent_name, case_ref, headline, severity, content, recipient_profile_id, recipient, channel, status, status_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [u.orgId, u.dedupeKey, kind, u.agentKey, u.agentName, u.caseRef, u.headline, u.severity, JSON.stringify(content), pl.profileId, pl.to, pl.channel, status, reason])
    if (!plan.length) {
      const r = await insert({ channel: 'email', profileId: null, to: null }, 'skipped', people.length ? 'every owner and admin has turned updates off' : 'no owner or admin to tell')
      return { duplicate: false as const, orgName: org?.name ?? null, plan: [] as Planned[], skippedId: r!.id }
    }
    for (const pl of plan) pl.rowId = (await insert(pl, 'queued', pl.channel === 'digest' ? 'kept for the morning report (daily digest)' : null))!.id
    return { duplicate: false as const, orgName: org?.name ?? null, plan, skippedId: null }
  })

  if (claim.duplicate) {
    const best = claim.prior.find(r => r.status === 'sent') ?? claim.prior.find(r => r.status === 'held') ?? claim.prior[0]
    return { status: best.status, id: updateId(claim.prior), reason: 'duplicate: this update was already handled' }
  }
  if (!claim.plan.length) return { status: 'skipped', id: claim.skippedId, reason: 'no owner or admin receives updates' }

  const detailsUrl = appLink(env.appUrl, u.detailsPath)
  const data: UpdateData = { agentName: u.agentName, headline: u.headline, whatHappened: u.whatHappened, whatIDid: u.whatIDid, proof: u.proof, caseRef: u.caseRef, severity: u.severity, detailsPath: u.detailsPath, orgName: claim.orgName }
  const undoUrl = u.undoToken && u.severity !== 'action' ? appLink(env.appUrl, undoPath(u.undoToken)) : ''
  const outcomes: Outcome[] = []
  for (const pl of claim.plan) {
    let o: Outcome
    try {
      if (pl.channel === 'digest') o = { status: 'queued', reason: 'kept for the morning report (daily digest)' }
      else if (pl.channel === 'email') {
        const r = await sendSystemEmail({
          key: `owner-update:${u.orgId}:${u.dedupeKey}:${pl.profileId}`.slice(0, 200),
          template: u.severity === 'action' ? 'agent_action_needed' : 'agent_update',
          to: pl.to!, orgId: u.orgId, params: { data: JSON.stringify(data), appUrl: env.appUrl, undoUrl }, secretParams: ['undoUrl'],
          related: { owner_update: pl.rowId, agent: u.agentKey, case_ref: u.caseRef },
        })
        o = { status: r.status === 'sent' ? 'sent' : r.status === 'held' ? 'held' : 'failed', reason: r.reason, systemEmailId: r.id }
      } else {
        const a = channelAdapter()
        const msg = { orgId: u.orgId, audience: 'owner' as const, recipientRef: pl.profileId, toPhone: pl.to!, dedupeKey: `owner-update:${u.dedupeKey}:${pl.profileId}`, body: shortUpdate(u, detailsUrl) }
        const r = await admin(db => (pl.channel === 'text' ? a.sendText(db, msg) : a.sendVoiceNote(db, msg)))
        // a simulated message is recorded as held: it was prepared, and nothing reached the person
        o = { status: r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : 'held', reason: r.reason, outboxId: r.id }
      }
    } catch (e) {
      o = { status: 'failed', reason: (e as Error).message.slice(0, 300) }
    }
    outcomes.push(o)
    await admin(db => db.query(`update owner_updates set status = $2, status_reason = $3, system_email_id = $4, outbox_id = $5 where id = $1`,
      [pl.rowId, o.status, o.reason?.slice(0, 500) ?? null, o.systemEmailId ?? null, o.outboxId ?? null]))
  }
  log.info('notify.owner', { org: u.orgId, agent: u.agentKey, deliveries: outcomes.length, statuses: outcomes.map(o => o.status).join(',') })
  const status: NotifyResult['status'] = outcomes.some(o => o.status === 'sent') ? 'sent' : outcomes.some(o => o.status === 'held') ? 'held' : outcomes.some(o => o.status === 'queued') ? 'queued' : 'failed'
  return { status, id: updateId(claim.plan.map(p => ({ id: p.rowId, channel: p.channel }))), ...(status === 'sent' ? {} : { reason: outcomes.map(o => o.reason).filter(Boolean)[0] ?? undefined }) }
}

/** The organization's recent owner updates (one entry per update, with how each delivery went). */
export async function recentOwnerUpdates(orgId: string, limit = 50) {
  return admin(db => db.query<{ dedupe_key: string; agent_name: string; headline: string; severity: string; kind: string; created_at: string; deliveries: { channel: string; status: string }[] }>(
    `select dedupe_key, min(agent_name) as agent_name, min(headline) as headline, min(severity) as severity, min(kind) as kind, min(created_at)::text as created_at,
       jsonb_agg(jsonb_build_object('channel', channel, 'status', status) order by channel) as deliveries
     from owner_updates where org_id = $1 group by dedupe_key order by min(created_at) desc limit $2`, [orgId, limit]))
}
