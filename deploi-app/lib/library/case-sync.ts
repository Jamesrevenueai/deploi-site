/**
 * Case adapter for the agent library (library_actions, lib/library/actions.ts). Same lifecycle as the
 * engine's store agents (lib/engine/case-sync.ts):
 *
 *   a problem reported (late order, oversold, fee anomaly ...) -> case opened, `investigating`
 *   a change or message drafted                             -> `awaiting_approval` (every library draft needs it)
 *   approved message (sending is off in this build)         -> `blocked`: nothing was sent, said plainly
 *   a store write done                                      -> `executing`, the write recorded, then `resolved`
 *                                                              only when a separate fresh read shows the value
 *   a write that failed, or that a fresh read does not show -> `failed`
 *   declined by the owner / agent switched off              -> `cancelled` with the reason
 *   draft expired                                           -> `investigating` (drafted again if still needed)
 *   gone on the agent's next read of the store              -> `resolved`: "no longer present on a fresh read"
 *
 * One open case per organization + agent + action type + record (the action's own dedupe key). Reports
 * with nothing to fix (weekly summaries, health reports, visibility checks) are not cases. For library
 * agents backed by an engine agent, the engine's issues carry the stock cases, so the duplicate library
 * flags open none.
 */
import { admin } from '../db'
import { log } from '../log'
import { caseForRecord, openCase, registerCaseKind, resolveCase, TERMINAL, transitionCase, type CaseRow, type Evidence } from '../cases'
import { registerCaseClose } from '../cases/close'
import { ensureActionRecorded, ensureLink, moveCase, type CaseTarget } from '../office/case-sync'
import { agentByKey } from './config'
import { storeDataFor } from './store-data'
import type { ActionRow } from './actions'

export const LIBRARY_CASE_KIND = 'library_action'
const ACTOR = 'system:agent-library'
const RECHECK_MS = 24 * 3600e3

/** Store writes the library can make (verified afterwards by a separate fresh read). */
const STORE_WRITES = new Set(['draft_title', 'draft_description', 'draft_inventory_policy_fix', 'approve_return', 'create_discount', 'end_discount'])
/** Messages: approved, never sent by this build. */
const MESSAGES = new Set(['draft_customer_update', 'draft_return_reply', 'draft_restock_request', 'draft_supplier_followup', 'draft_customer_reply', 'send_customer_reply', 'draft_campaign_email'])
/** Reports that describe a problem someone has to deal with. */
const PROBLEMS = new Set(['flag_late_order', 'flag_oversold', 'flag_fee_anomaly', 'recommend_visibility_fix', 'reconcile_payout'])
/** Covered by the engine agent of an engine-backed library agent (its issues and restock requests are the cases). */
const ENGINE_COVERED = new Set(['flag_oversold', 'draft_inventory_policy_fix', 'draft_restock_request', 'draft_supplier_followup'])

export function opensCase(a: Pick<ActionRow, 'action_type' | 'payload'>, engineBacked: boolean): boolean {
  if (engineBacked && ENGINE_COVERED.has(a.action_type)) return false
  if (a.action_type === 'reconcile_payout') return String(a.payload?.dedupeKey ?? '').endsWith(':missing')
  return STORE_WRITES.has(a.action_type) || MESSAGES.has(a.action_type) || PROBLEMS.has(a.action_type)
}
export const libraryDedupeKey = (agentKey: string, actionType: string, dedupe: string) => `library:${agentKey}:${actionType}:${dedupe}`.slice(0, 300)

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))

/** A separate fresh read of what a store write changed. */
async function verifyWrite(a: ActionRow, now: Date): Promise<{ ok: boolean; evidence: Evidence; reason?: string }> {
  const src = await storeDataFor(a.org_id, now)
  const d = src.data
  const p = a.payload
  const at = new Date().toISOString()
  const source = 'shopify'
  const res = (ok: boolean, label: string, detail: Record<string, unknown>) => ({ ok, evidence: { label, source, observedAt: at, detail: { ...detail, synthetic: d.synthetic }, ref: { type: 'library_action', id: a.id } }, ...(ok ? {} : { reason: label }) })
  switch (a.action_type) {
    case 'draft_title': case 'draft_description': {
      const field = a.action_type === 'draft_title' ? 'title' : 'description'
      const prod = (await d.products()).find(x => x.id === s(p.productId))
      const value = prod ? (field === 'title' ? prod.title : prod.description) : null
      return res(value === s(p.to), prod ? `A fresh read shows the ${field}${value === s(p.to) ? ' as approved' : ` is "${s(value).slice(0, 60)}", not the approved text`}` : 'The product is no longer in the store', { field, expected: p.to, observed: value })
    }
    case 'draft_inventory_policy_fix': {
      const v = (await d.products()).flatMap(x => x.variants).find(x => x.id === s(p.variantId))
      return res(v?.inventoryPolicy === s(p.to), v ? `A fresh read shows the inventory policy is ${v.inventoryPolicy}` : 'The variant is no longer in the store', { expected: p.to, observed: v?.inventoryPolicy ?? null })
    }
    case 'approve_return': {
      const r = (await d.returns()).find(x => x.id === s(p.returnId))
      return res(r?.status === 'approved', r ? `A fresh read shows the return is ${r.status}` : 'The return is no longer in the store', { observed: r?.status ?? null })
    }
    case 'create_discount': {
      const x = (await d.discounts()).find(y => y.code === s(p.code))
      return res(x?.status === 'active', x ? `A fresh read shows code ${x.code} is ${x.status}` : `A fresh read does not show code ${s(p.code)}`, { code: p.code, observed: x?.status ?? null })
    }
    case 'end_discount': {
      const x = (await d.discounts()).find(y => y.id === s(p.discountId))
      return res(x?.status === 'expired', x ? `A fresh read shows ${x.code} is ${x.status}` : 'The discount is no longer in the store', { observed: x?.status ?? null })
    }
    default: return res(false, 'This action has no store write to verify', {})
  }
}

function targetFor(a: ActionRow, now: Date): CaseTarget | { cancel: string } | null {
  const later = new Date(now.getTime() + RECHECK_MS)
  const step = s(a.payload?.suggestedStep) || null
  switch (a.status) {
    case 'noted': return { status: 'investigating', reason: `Reported: ${a.summary}`.slice(0, 1000), nextAction: step ?? 'Look at it in your store; the agent checks again on its next run.', nextCheckAt: later }
    case 'draft': return { status: 'awaiting_approval', reason: (a.permission_basis ?? 'Waits for your approval').slice(0, 1000), nextAction: 'Approve or decline the exact item in Needs My Approval.', nextCheckAt: later }
    case 'approved': return MESSAGES.has(a.action_type)
      ? { status: 'blocked', reason: 'Approved, but email sending is off in this environment: nothing was sent.', nextAction: 'Copy the text and send it yourself, then close this case with a reason.', nextCheckAt: later }
      : { status: 'executing', reason: 'Approved', nextAction: null, nextCheckAt: later }
    case 'failed': return { status: 'failed', reason: `It did not work: ${a.status_reason ?? 'the store refused'}`.slice(0, 1000), nextAction: 'Run the agent again or make the change yourself.', nextCheckAt: later }
    case 'declined': return { cancel: `Declined by you: ${a.status_reason ?? 'declined'}` }
    case 'expired': return /switched off/i.test(a.status_reason ?? '') ? { cancel: 'The agent was switched off before this was decided' }
      : { status: 'investigating', reason: `The draft expired (${a.status_reason ?? 'not decided in time'}). The agent drafts it again on its next run if it is still needed.`, nextAction: null, nextCheckAt: later }
    default: return null
  }
}

/** Open or update the case of one library action. Idempotent. */
export async function syncLibraryAction(actionId: string, opts: { now?: Date; engineBacked?: boolean } = {}): Promise<CaseRow | null> {
  const now = opts.now ?? new Date()
  const a = await admin(db => db.one<ActionRow>('select * from library_actions where id = $1', [actionId]))
  if (!a) return null
  const engineBacked = opts.engineBacked ?? Boolean(await admin(db => db.one(`select 1 from library_switches where org_id = $1 and agent_key = $2 and engine_agent_id is not null`, [a.org_id, a.agent_key])))
  if (!opensCase(a, engineBacked)) return null
  const dedupe = s(a.payload?.dedupeKey) || a.id
  let c = await admin(db => caseForRecord(db, a.org_id, 'library_action', a.id))
  if (c && TERMINAL.includes(c.status)) return c
  if (!c) {
    // a decided action never opens a case on its own (only open work does)
    if (['declined', 'expired'].includes(a.status)) return null
    const cfg = agentByKey(a.agent_key.startsWith('custom:') ? '' : a.agent_key)
    c = (await admin(db => openCase(db, {
      orgId: a.org_id, suite: 'commerce', kind: LIBRARY_CASE_KIND, sourceApp: 'shopify', dedupeKey: libraryDedupeKey(a.agent_key, a.action_type, dedupe),
      title: a.title.length >= 3 ? a.title.slice(0, 300) : `${a.title} (library)`, problem: a.summary.slice(0, 4000) || a.title,
      whyItMatters: cfg ? `${cfg.name} found this while reading your store.` : null, priority: PROBLEMS.has(a.action_type) && a.action_type !== 'recommend_visibility_fix' ? 'high' : 'normal',
      agent: a.agent_key.startsWith('custom:') ? null : { kind: 'library', ref: a.agent_key },
      evidence: [{ label: a.title.slice(0, 300), source: 'shopify', observedAt: new Date(a.created_at).toISOString(), detail: { actionType: a.action_type }, ref: { type: 'library_action', id: a.id } }],
      records: [{ type: 'library_action', id: a.id, label: a.title.slice(0, 200) }],
      verification: { criteria: STORE_WRITES.has(a.action_type) ? 'A separate fresh read of the store shows the change' : 'A fresh read of the store no longer shows the problem (or you close it with a reason)',
        rule: { type: 'library', agentKey: a.agent_key, actionType: a.action_type, dedupeKey: dedupe } },
      nextCheckAt: new Date(now.getTime() + RECHECK_MS), actor: ACTOR,
    }))).case
    if (TERMINAL.includes(c.status)) return c
  }
  await ensureLink(c.id, { type: 'library_action', id: a.id, label: a.title.slice(0, 200) }, ACTOR)
  // the newest action linked to the case decides its status (older ones are history)
  const newest = await admin(db => db.one<{ id: string }>(`select x.id from library_actions x join case_links l on l.ref_type = 'library_action' and l.ref_id = x.id::text and l.case_id = $1 order by x.created_at desc limit 1`, [c!.id]))
  if (newest && newest.id !== a.id) return c
  try {
    if (a.status === 'done') {
      await ensureActionRecorded(c.id, { summary: `${a.title}: done${a.mode === 'auto' ? ' (auto-run you granted)' : ''}`, ref: { type: 'library_write', id: a.id }, detail: { mode: a.mode, decided_by: a.decided_by } }, ACTOR)
      if (!['executing', 'verifying'].includes(c.status)) c = (await moveCase(c.id, { status: 'executing', reason: 'The change was made', ref: { type: 'library_action', id: a.id } }, ACTOR)) ?? c
      if (c.status === 'executing') c = (await moveCase(c.id, { status: 'verifying', reason: 'Checking the change with a fresh read of the store' }, ACTOR)) ?? c
      const v = await verifyWrite(a, now)
      if (v.ok) return await admin(db => resolveCase(db, c!.id, { actor: ACTOR, summary: 'Done and confirmed by a fresh read of the store', verifiedBy: 'store read after the change', evidence: [v.evidence] }))
      return await moveCase(c.id, { status: 'failed', reason: `The change was made but a fresh read does not confirm it: ${v.reason}`.slice(0, 1000), evidence: [v.evidence], nextAction: 'Check the record in your store.' }, ACTOR)
    }
    const t = targetFor(a, now)
    if (!t) return c
    if ('cancel' in t) return await admin(db => transitionCase(db, c!.id, { to: 'cancelled', actor: ACTOR, reason: t.cancel, nextCheckAt: null, nextAction: null }))
    if (c.status === t.status && c.status_reason === t.reason) return c
    return await moveCase(c.id, t, ACTOR)
  } catch (e) {
    log.error('library.case_sync_failed', { action_id: a.id, error: (e as Error).message })
    return c
  }
}

/**
 * After a successful run: every action of the run is synced, and every open case of this agent whose work
 * the run no longer produced (its fresh read of the store does not show the problem) is resolved with that
 * read as the evidence; a still-waiting draft for it is withdrawn.
 */
export async function syncLibraryRun(orgId: string, agentKey: string, runId: string, produced: Set<string>, opts: { now?: Date; engineBacked: boolean }) {
  const now = opts.now ?? new Date()
  const acts = await admin(db => db.query<{ id: string }>('select id from library_actions where org_id = $1 and agent_key = $2 and run_id = $3 order by created_at', [orgId, agentKey, runId]))
  for (const a of acts) await syncLibraryAction(a.id, { now, engineBacked: opts.engineBacked })
  const open = await admin(db => db.query<CaseRow>(`select * from cases where org_id = $1 and kind = $2 and status not in ('resolved','cancelled') and verification->'rule'->>'agentKey' = $3`, [orgId, LIBRARY_CASE_KIND, agentKey]))
  for (const c of open) {
    const rule = (c.verification as { rule?: { actionType?: string; dedupeKey?: string } }).rule
    if (!rule?.actionType || !rule.dedupeKey || produced.has(`${rule.actionType}|${rule.dedupeKey}`)) continue
    // messages approved but unsent and store writes already done are not "gone": they keep their own status
    if (c.status === 'blocked' || c.status === 'verifying' || c.status === 'failed') continue
    try {
      await admin(async db => {
        await db.query(`update library_actions set status = 'expired', status_reason = 'no longer needed: a fresh read of the store no longer shows the problem' where org_id = $1 and agent_key = $2 and action_type = $3 and payload->>'dedupeKey' = $4 and status = 'draft'`, [orgId, agentKey, rule.actionType, rule.dedupeKey])
        await resolveCase(db, c.id, { actor: ACTOR, summary: 'No longer present on a fresh read of the store', verifiedBy: 'store read by the agent',
          evidence: [{ label: 'The agent read the store again and no longer finds this', source: 'shopify', observedAt: now.toISOString(), detail: { run_id: runId, agentKey }, ref: { type: 'library_run', id: runId } }] })
      })
    } catch (e) { log.error('library.case_resolve_failed', { case_id: c.id, error: (e as Error).message }) }
  }
}

/** Checker: re-reads the newest linked action (decisions, expiry, switching off) and moves the case. */
export async function checkLibraryCase(c: CaseRow, now: Date): Promise<void> {
  const a = await admin(db => db.one<{ id: string }>(`select x.id from library_actions x join case_links l on l.ref_type = 'library_action' and l.ref_id = x.id::text and l.case_id = $1 order by x.created_at desc limit 1`, [c.id]))
  const after = a ? await syncLibraryAction(a.id, { now }) : null
  if (!after || (!TERMINAL.includes(after.status) && (!after.next_check_at || new Date(after.next_check_at) <= now)))
    await admin(db => db.query('update cases set next_check_at = $2 where id = $1', [c.id, new Date(now.getTime() + RECHECK_MS).toISOString()]))
}

registerCaseKind(LIBRARY_CASE_KIND, checkLibraryCase)
registerCaseClose(LIBRARY_CASE_KIND, {
  label: 'Close with a reason', needsReason: true,
  // a draft still waiting for this case is withdrawn with it, so nothing can be approved after the owner closed it
  async onClose(db, c) {
    const ids = (await db.query<{ ref_id: string }>(`select ref_id from case_links where case_id = $1 and ref_type = 'library_action'`, [c.id])).map(r => r.ref_id)
    if (ids.length) await db.query(`update library_actions set status = 'expired', status_reason = 'closed by you on the case' where org_id = $1 and id = any($2::uuid[]) and status = 'draft'`, [c.org_id, ids])
  },
})
