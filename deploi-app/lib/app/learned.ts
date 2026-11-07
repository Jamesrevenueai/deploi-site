/**
 * "What your team learned": the business as Deploi read it the last time it looked (the latest discovery run and the
 * business profile it built, lib/discovery), and the agents it set up by itself from that (discovery_agents created
 * by the autonomy setting, and the packs it turned on). Real records only: when nothing was ever read this says
 * so (null), it never shows sample numbers.
 */
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import type { BusinessProfile } from '../discovery/profile'
import { orgPacks } from '../packs/settings'
import { PACKS } from '../packs/registry'
import { ON_CONNECT_ACTOR } from '../autonomy/on-connect'
import { merchantOrg } from './feeds'

export type Learned = {
  /** when the read finished */
  at: string
  /** how long the read took, in seconds (started → finished) */
  seconds: number
  status: 'completed' | 'partial'
  /** what was read, by app ("Shopify", "QuickBooks", "Mailbox") */
  read: string[]
  /** what could not be read and why */
  notRead: { label: string; reason: string }[]
  /** the facts the read found ("Products: 38", "Unpaid invoices: 4"), as many as it recorded */
  facts: { label: string; value: string }[]
  findings: number
  casesOpened: number
  /** the agents the platform set up by itself (not by the owner) */
  agentsCreated: number
  /** the packs that are on, with whether Deploi inferred the business type itself */
  packs: string[]
  inferred: boolean
}

const fmt = (v: unknown, capped?: boolean) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'number' ? `${capped ? 'at least ' : ''}${v.toLocaleString('en-US')}` : String(v)).slice(0, 80)

export async function learned(actor: Actor): Promise<Learned | null> {
  const orgId = merchantOrg(actor)
  return admin(async db => {
    const run = await db.one<{ started_at: string; finished_at: string; status: 'completed' | 'partial'; findings_count: number; cases_opened: number; sources: { label: string; status: string; reason: string | null }[] }>(
      `select started_at, finished_at, status, findings_count, cases_opened, sources from discovery_runs where org_id = $1 and status in ('completed','partial') order by finished_at desc limit 1`, [orgId])
    if (!run) return null
    const p = (await db.one<{ profile: BusinessProfile }>('select profile from business_profiles where org_id = $1', [orgId]))?.profile
    const created = (await db.one<{ n: number }>(`select count(*)::int as n from discovery_agents where org_id = $1 and agent_id is not null and created_by = $2`, [orgId, ON_CONNECT_ACTOR]))?.n ?? 0
    const packs = await orgPacks(db, orgId)
    const sources = Array.isArray(run.sources) ? run.sources : []
    const seen = new Set<string>()
    const facts = (p?.facts ?? []).filter(f => f && typeof f.label === 'string' && !seen.has(f.label) && seen.add(f.label)).slice(0, 12).map(f => ({ label: f.label.slice(0, 80), value: fmt(f.value, f.capped) }))
    const notRead = [...sources.filter(s => s.status !== 'read').map(s => ({ label: s.label, reason: s.reason ?? s.status })), ...(p?.notRead ?? []).map(n => ({ label: n.label, reason: n.reason }))]
    return {
      at: new Date(run.finished_at).toISOString(),
      seconds: Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)),
      status: run.status,
      read: [...new Set(sources.filter(s => s.status === 'read').map(s => s.label))],
      notRead: notRead.filter((n, i) => notRead.findIndex(x => x.label === n.label) === i).slice(0, 6),
      facts, findings: run.findings_count, casesOpened: run.cases_opened, agentsCreated: created,
      packs: packs.packs.map(k => PACKS[k].name), inferred: packs.source === 'inferred',
    }
  })
}
