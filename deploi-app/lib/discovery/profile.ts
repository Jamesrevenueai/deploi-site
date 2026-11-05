/**
 * The business profile: what an organization has connected and plain counts read from those connections,
 * each with its source and the time it was observed. Built only from data the organization authorized
 * Deploi to read; nothing is estimated or inferred, and no personal or sensitive attribute is derived
 * (contacts are counted, never named). A source that could not be read is listed with the reason instead.
 */
import { admin } from '../db'
import { OfficeHttpError } from '../office/http'
import { hubspotFor } from '../office/providers'
import type { OfficeConnectionRow } from '../office/connections'
import type { DetectorContext, ProfileFact } from './registry'
import { activeStores, lowStock, stockItems, storeLabel, storeSnapshot, LOW_STOCK_THRESHOLD, PLATFORM_LABEL } from './store'
import { DiscoveryTimeout, withTimeout } from './timeout'

export type SourceState = 'read' | 'not_read' | 'failed' | 'timeout'
export type SourceRecord = { app: string; label: string; status: SourceState; reason: string | null; at: string }
export type ProfilePlatform = { app: string; label: string; status: string; synthetic: boolean; connectedAt: string | null }
export type BusinessProfile = { builtAt: string; platforms: ProfilePlatform[]; facts: ProfileFact[]; notRead: { app: string; label: string; reason: string }[] }

const OFFICE_LABEL: Record<string, string> = { hubspot: 'HubSpot', google_calendar: 'Google Calendar' }
const MAIL_LABEL: Record<string, string> = { gmail: 'Gmail', microsoft: 'Microsoft 365', synthetic: 'Test mailbox', deploi: 'Deploi mailbox' }
/** Leads counted per profile build, at most (HubSpot pages of 100). */
export const CRM_COUNT_LIMIT = 500
const DAYS = 30

const why = (e: unknown) => e instanceof DiscoveryTimeout ? e.message
  : e instanceof OfficeHttpError && (e.code === 'auth' || e.code === 'forbidden') ? 'needs reauth' : (e as Error).message.slice(0, 160)

export async function buildProfile(ctx: DetectorContext, opts: { timeoutMs?: number } = {}): Promise<{ profile: BusinessProfile; sources: SourceRecord[] }> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const now = ctx.now
  const at = () => new Date().toISOString()
  const facts: ProfileFact[] = []
  const sources: SourceRecord[] = []
  const notRead: BusinessProfile['notRead'] = []
  const skip = (app: string, label: string, status: SourceState, reason: string) => { sources.push({ app, label, status, reason, at: at() }); notRead.push({ app, label, reason: `${label} not read: ${reason}` }) }

  const { stores, office, mail } = await admin(async db => ({
    stores: await db.query<{ id: string; platform: string; display_name: string | null; external_id: string; status: string; status_reason: string | null; is_synthetic: boolean; installed_at: string | null }>(
      `select id, platform, display_name, external_id, status, status_reason, is_synthetic, installed_at from store_connections where org_id = $1 and status not in ('uninstalled','disconnected') order by created_at`, [ctx.orgId]),
    office: await db.query<OfficeConnectionRow & { connected_at: string }>(`select * from office_connections where org_id = $1 and status <> 'disconnected' order by connected_at`, [ctx.orgId]),
    mail: await db.query<{ id: string; provider: string; status: string; status_reason: string | null; is_synthetic: boolean; can_read: boolean; connected_at: string; agent_id: string | null }>(
      `select id, provider, status, status_reason, is_synthetic, can_read, connected_at, agent_id from email_accounts where org_id = $1 and status <> 'disconnected' order by connected_at`, [ctx.orgId]),
  }))
  const platforms: ProfilePlatform[] = [
    ...stores.map(s => ({ app: s.platform, label: storeLabel(s), status: s.status, synthetic: s.is_synthetic, connectedAt: s.installed_at })),
    ...office.map(o => ({ app: o.provider, label: OFFICE_LABEL[o.provider] ?? o.provider, status: o.status, synthetic: o.is_synthetic, connectedAt: o.connected_at })),
    ...(mail.length ? [{ app: 'deploi_email', label: `Mailboxes (${mail.length})`, status: mail.some(m => m.status === 'active') ? 'active' : mail[0].status, synthetic: mail.every(m => m.is_synthetic), connectedAt: mail[0].connected_at }] : []),
  ]

  // ---- stores: the catalog read once per run (shared with the store detectors)
  for (const s of stores.filter(x => x.status !== 'active')) skip(s.platform, storeLabel(s), 'not_read', s.status === 'error' ? (s.status_reason ?? 'needs reauth') : (s.status_reason ?? s.status))
  const active = await admin(db => activeStores(db, ctx.orgId))
  for (const conn of active) {
    const label = storeLabel(conn)
    let snap
    try { snap = await withTimeout(storeSnapshot(ctx, conn), timeoutMs) } catch (e) { skip(conn.platform, label, 'timeout', why(e)); continue }
    if (snap.error) { skip(conn.platform, label, 'failed', snap.error); continue }
    sources.push({ app: conn.platform, label, status: 'read', reason: null, at: snap.readAt })
    const items = stockItems(snap)
    const tracked = items.filter(i => i.tracked && i.available !== null)
    const src = conn.platform, t = snap.readAt, p = `store.${conn.id}`
    facts.push(
      { key: `${p}.products`, label: `Products in ${label}`, value: new Set(items.map(i => i.productId)).size, source: src, observedAt: t },
      { key: `${p}.items`, label: `Items (variants) in ${label}`, value: items.length, source: src, observedAt: t },
      { key: `${p}.tracked`, label: 'Items with stock tracked', value: tracked.length, source: src, observedAt: t },
      { key: `${p}.out_of_stock`, label: 'Items out of stock (0 available)', value: tracked.filter(i => i.available === 0).length, source: src, observedAt: t },
      { key: `${p}.oversold`, label: 'Items oversold (below 0 available)', value: tracked.filter(i => i.available! < 0).length, source: src, observedAt: t },
      { key: `${p}.low_stock`, label: `Items on sale with ${LOW_STOCK_THRESHOLD} or fewer available`, value: lowStock(items).length, source: src, observedAt: t },
    )
    if (snap.scan) facts.push({ key: `${p}.open_problems`, label: 'Store problems open after the read', value: (await admin(db => db.one<{ n: number }>(`select count(*)::int as n from issues where connection_id = $1 and status in ('open','needs_review')`, [conn.id])))?.n ?? 0, source: src, observedAt: t })
    // orders are not part of what Deploi reads from a store: say so rather than show a number
    notRead.push({ app: conn.platform, label: `${PLATFORM_LABEL[conn.platform] ?? conn.platform} orders`, reason: 'Orders not read: Deploi reads products and inventory, not orders' })
  }

  // ---- CRM: leads active in the last 30 days (counted, never named), and the leads Deploi follows up
  for (const o of office) {
    const label = OFFICE_LABEL[o.provider] ?? o.provider
    if (o.status !== 'active') { skip(o.provider, label, 'not_read', o.status === 'needs_reauth' ? 'needs reauth' : (o.status_reason ?? o.status)); continue }
    if (o.provider !== 'hubspot') continue // a calendar is listed as connected; discovery does not read its events
    try {
      const api = hubspotFor(o)
      const since = new Date(now.getTime() - DAYS * 864e5)
      const count = await withTimeout((async () => {
        let n = 0, after: string | null = null
        do {
          const page = await api.searchLeads({ since, after, limit: 100 })
          n += page.contacts.length
          after = page.next
        } while (after && n < CRM_COUNT_LIMIT)
        return { n: Math.min(n, CRM_COUNT_LIMIT), capped: Boolean(after) || n > CRM_COUNT_LIMIT }
      })(), timeoutMs)
      const t = at()
      sources.push({ app: 'hubspot', label, status: 'read', reason: null, at: t })
      facts.push({ key: 'crm.leads_30d', label: `Leads created or updated in the last ${DAYS} days`, value: count.n, source: 'hubspot', observedAt: t, ...(count.capped ? { capped: true } : {}) })
    } catch (e) { skip('hubspot', label, e instanceof DiscoveryTimeout ? 'timeout' : 'failed', why(e)) }
  }
  if (office.length) {
    const r = await admin(db => db.one<{ followed: number; replied: number }>(`select count(*)::int as followed, count(*) filter (where status = 'replied')::int as replied from office_leads where org_id = $1`, [ctx.orgId]))
    facts.push({ key: 'crm.leads_followed', label: 'Leads Deploi has followed up', value: r?.followed ?? 0, source: 'deploi', observedAt: at() },
      { key: 'crm.leads_replied', label: 'Leads that replied', value: r?.replied ?? 0, source: 'deploi', observedAt: at() })
  }

  // ---- mailboxes: message volume Deploi itself received and sent (counts only, never content)
  const live = mail.filter(m => m.status === 'active')
  for (const m of mail.filter(x => x.status !== 'active')) skip('deploi_email', MAIL_LABEL[m.provider] ?? m.provider, 'not_read', m.status === 'needs_reauth' ? 'needs reauth' : (m.status_reason ?? m.status))
  if (live.length) {
    const ids = live.map(m => m.id)
    const since = new Date(now.getTime() - DAYS * 864e5).toISOString()
    const r = await admin(db => db.one<{ received: number; sent: number }>(
      `select (select count(*)::int from email_inbound where account_id = any($1::uuid[]) and received_at >= $2) as received,
              (select count(*)::int from email_messages where account_id = any($1::uuid[]) and status = 'accepted' and accepted_at >= $2) as sent`, [ids, since]))
    const t = at()
    sources.push({ app: 'deploi_email', label: `Mailboxes (${live.length})`, status: 'read', reason: null, at: t })
    facts.push({ key: 'mail.mailboxes', label: 'Connected mailboxes', value: live.length, source: 'deploi_email', observedAt: t },
      { key: 'mail.received_30d', label: `Messages received in the last ${DAYS} days`, value: r?.received ?? 0, source: 'deploi_email', observedAt: t },
      { key: 'mail.sent_30d', label: `Messages sent in the last ${DAYS} days`, value: r?.sent ?? 0, source: 'deploi_email', observedAt: t })
  }

  return { profile: { builtAt: at(), platforms, facts, notRead }, sources }
}
