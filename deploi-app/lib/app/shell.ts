/**
 * What the logged-in shell (components/app/AppShell.tsx) and the Command center read on the server, once per
 * request (React cache: the layout and the page share one read). Server-only; the shapes are plain data.
 */
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { admin } from '../db'
import { requireRole } from '../auth'
import type { Actor } from '../engine/actor'
import type { Session } from '../session'
import { commandCenter, getWorkspace } from './contract'
import { orgStopReason } from '../engine/kill-switch'
import { orgPacks } from '../packs/settings'
import { PACKS } from '../packs/registry'
import type { Allowance, CommandCenter, Workspace } from './contract'

export type ShellData = {
  workspace: Workspace
  /** the connected store's name on the Store side, the organization's name on the Office side */
  workspaceName: string
  /** the connected sources of this side ("Shopify", "HubSpot", ...); empty when nothing is connected */
  sources: string[]
  needsYouCount: number
  agentCount: number
  allowance: Allowance
  /** the business's own sections: one per agent pack that is on (Commerce, Home services, Leasing ...), each its pack page */
  sections: { href: string; label: string }[]
}

const PLATFORM: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', amazon: 'Amazon' }
const PROVIDER: Record<string, string> = { hubspot: 'HubSpot', google_calendar: 'Google Calendar' }

/**
 * The signed-in merchant of this request and their actor, read once (the layout and the page share it). Staff are
 * sent to their console by requireRole; an account without a store organization to /no-store or /start.
 */
export const merchantSession = cache(async (): Promise<{ session: Session; actor: Extract<Actor, { kind: 'profile' }> }> => {
  const session = await requireRole('client')
  if (session.orgType !== 'merchant' || !session.agencyId) redirect(session.agencyId ? '/no-store' : '/start')
  return { session, actor: { kind: 'profile', session, orgId: session.agencyId, label: `user:${session.email}` } }
})

/** The workspace this person sees (their own choice, else the organization's default). */
export const loadWorkspace = cache(async (actor: Actor): Promise<Workspace> => (await getWorkspace(actor)).workspace)

/** The whole Command center for one side; the shell's counts and the page share one read per request. */
export const loadCommandCenter = cache((actor: Actor, workspace: Workspace): Promise<CommandCenter> => commandCenter(actor, workspace))

/** Names of the workspace and its connected sources (store connections on the Store side, Office connections on the Office side). */
export async function workspaceSources(orgId: string, workspace: Workspace): Promise<{ name: string; sources: string[] }> {
  return admin(async db => {
    const org = await db.one<{ name: string }>('select name from agencies where id = $1', [orgId])
    if (workspace === 'store') {
      const rows = await db.query<{ platform: string; display_name: string | null; external_id: string }>(
        `select platform, display_name, external_id from store_connections where org_id = $1 and status = 'active' order by installed_at nulls last, created_at`, [orgId])
      const first = rows[0]
      return { name: first ? (first.display_name || first.external_id) : (org?.name ?? 'Your store'), sources: [...new Set(rows.map(r => PLATFORM[r.platform] ?? r.platform))] }
    }
    const rows = await db.query<{ provider: string }>(`select provider from office_connections where org_id = $1 and status = 'active' order by connected_at`, [orgId])
    return { name: org?.name ?? 'Your office', sources: [...new Set(rows.map(r => PROVIDER[r.provider] ?? r.provider))] }
  })
}

export async function loadShell(actor: Extract<Actor, { kind: 'profile' }>): Promise<ShellData> {
  const workspace = await loadWorkspace(actor)
  const [cc, ws, packs] = await Promise.all([loadCommandCenter(actor, workspace), workspaceSources(actor.orgId, workspace), admin(db => orgPacks(db, actor.orgId))])
  const sections = packs.packs.map(k => ({ href: `/store/packs/${k}`, label: k === 'office' ? 'Office' : PACKS[k].name }))
  return { workspace, workspaceName: ws.name, sources: ws.sources, needsYouCount: cc.needsYou.length, agentCount: cc.team.length, allowance: cc.allowance, sections }
}

/** The organization's own time zone (agencies.timezone), for the greeting and dates. */
export async function orgTimeZone(orgId: string): Promise<string> {
  const r = await admin(db => db.one<{ timezone: string | null }>('select timezone from agencies where id = $1', [orgId]))
  return r?.timezone || 'UTC'
}

/** The organization stop (lib/engine/kill-switch.ts), or null while agents may run. */
export function orgStopped(orgId: string): Promise<string | null> {
  return admin(db => orgStopReason(db, orgId))
}
