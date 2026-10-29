/**
 * The library's part of the weekly summary: actions per agent, and the time and money saved, both
 * labelled estimates with their formula. Money saved counts stockouts avoided (stop-selling-at-zero
 * fixes applied and restock requests approved) and orders recovered (late-order updates approved),
 * each valued at the store's average order value from the week's orders when known, else a stated default.
 */
import type { Db } from '../db'
import { LIBRARY, agentByKey } from './config'

/** Minutes of merchant work one action of each kind replaces. Shown with every estimate. */
export const ACTION_MINUTES: Record<string, number> = {
  flag_late_order: 3, draft_customer_update: 6, draft_return_reply: 8, approve_return: 2, draft_title: 4, draft_description: 12, flag_oversold: 3, draft_inventory_policy_fix: 3,
  draft_restock_request: 10, draft_supplier_followup: 5, draft_customer_reply: 7, send_customer_reply: 7, draft_campaign_email: 45, propose_discount: 10, create_discount: 5, end_discount: 2,
  weekly_summary: 30, reconcile_payout: 15, flag_fee_anomaly: 10, health_report: 20, check_ai_visibility: 2, recommend_visibility_fix: 3,
}
const STOCKOUT_ACTIONS = ['draft_inventory_policy_fix', 'draft_restock_request']
const RECOVERY_ACTIONS = ['draft_customer_update', 'draft_customer_reply']
export const DEFAULT_AOV_USD = 45

export type LibraryAgentWeek = { agentKey: string; name: string; enabled: boolean; noted: number; drafted: number; approved: number; done: number; declined: number; failed: number; minutes: number }
export type LibraryWeek = {
  agents: LibraryAgentWeek[]
  time: { minutes: number; formula: string; label: 'Estimate' }
  money: { stockoutsAvoided: number; ordersRecovered: number; aovUsd: number; aovSource: 'orders this week' | 'default'; usd: number; formula: string; label: 'Estimate' }
  actionsTotal: number
}

export async function libraryWeek(db: Db, orgId: string, weekStart: Date, aovFromOrders: number | null = null): Promise<LibraryWeek> {
  const from = weekStart.toISOString(), to = new Date(weekStart.getTime() + 7 * 864e5).toISOString()
  const rows = await db.query<{ agent_key: string; action_type: string; status: string; n: string }>(
    `select agent_key, action_type, status, count(*)::text as n from library_actions where org_id = $1 and created_at >= $2 and created_at < $3 group by agent_key, action_type, status`, [orgId, from, to])
  const switches = await db.query<{ agent_key: string; enabled: boolean }>('select agent_key, enabled from library_switches where org_id = $1', [orgId])
  const byAgent = new Map<string, LibraryAgentWeek>()
  const ensure = (k: string) => { if (!byAgent.has(k)) byAgent.set(k, { agentKey: k, name: agentByKey(k)?.name ?? (k.startsWith('custom:') ? 'Custom agent' : k), enabled: switches.find(s => s.agent_key === k)?.enabled ?? false, noted: 0, drafted: 0, approved: 0, done: 0, declined: 0, failed: 0, minutes: 0 }); return byAgent.get(k)! }
  for (const a of LIBRARY.agents) if (switches.some(s => s.agent_key === a.key)) ensure(a.key)
  let stockouts = 0, recovered = 0, minutes = 0, total = 0
  const parts: string[] = []
  for (const r of rows) {
    const w = ensure(r.agent_key), n = Number(r.n)
    total += n
    if (r.status === 'noted') w.noted += n; else if (r.status === 'draft') w.drafted += n; else if (r.status === 'approved') w.approved += n; else if (r.status === 'done') w.done += n; else if (r.status === 'declined') w.declined += n; else if (r.status === 'failed') w.failed += n
    // only finished work counts toward time saved: reports read, drafts approved, writes verified
    if (['noted', 'approved', 'done'].includes(r.status)) { const m = (ACTION_MINUTES[r.action_type] ?? 2) * n; w.minutes += m; minutes += m; parts.push(`${n} × ${r.action_type.replace(/_/g, ' ')} × ${ACTION_MINUTES[r.action_type] ?? 2} min`) }
    if (['approved', 'done'].includes(r.status) && STOCKOUT_ACTIONS.includes(r.action_type)) stockouts += n
    if (['approved', 'done'].includes(r.status) && RECOVERY_ACTIONS.includes(r.action_type)) recovered += n
  }
  const aov = aovFromOrders && aovFromOrders > 0 ? Math.round(aovFromOrders * 100) / 100 : DEFAULT_AOV_USD
  const usd = Math.round((stockouts + recovered) * aov * 100) / 100
  return {
    agents: [...byAgent.values()].sort((a, b) => a.name.localeCompare(b.name)),
    time: { minutes, formula: parts.length ? parts.join(' + ') : 'no finished actions this week', label: 'Estimate' },
    money: { stockoutsAvoided: stockouts, ordersRecovered: recovered, aovUsd: aov, aovSource: aovFromOrders && aovFromOrders > 0 ? 'orders this week' : 'default', usd, formula: `(${stockouts} stockout${stockouts === 1 ? '' : 's'} avoided + ${recovered} order${recovered === 1 ? '' : 's'} recovered) × $${aov} average order value`, label: 'Estimate' },
    actionsTotal: total,
  }
}
