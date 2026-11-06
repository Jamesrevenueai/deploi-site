/**
 * Autonomy model (owner setting per action type). SHARED INTERFACE — owned by workstream W1.
 *   'act_and_tell' (default): the agent acts on its own, verifies, logs proof and tells the owner after.
 *   'ask_first': the agent prepares the exact action and waits for the owner's approval.
 * MONEY GUARD: an action that moves money (MONEY_ACTIONS: refunds, discounts, payout disputes, invoices, credit notes,
 * payments, purchase orders and reorders) ALWAYS waits for the owner's approval, whatever the organization's mode
 * and whatever autonomy level the owner gave the agent (lib/app). The agent loop enforces it (lib/events/loop.ts:
 * effectiveMode), so no caller can act on money by itself; setMode refuses act_and_tell for a money action.
 * Hard limits (amount caps, daily caps, allowed recipients) still apply in both modes.
 *
 * Stored in org_action_modes (one row per organization and action type; no row = the default). Only owners and
 * admins change it (assertCan 'settings'); every change is audited. Packs add their action types with
 * registerActionTypes so the Settings page lists them.
 */
import type { Db } from '../db'

export type ActionMode = 'act_and_tell' | 'ask_first'
export const DEFAULT_MODE: ActionMode = 'act_and_tell'
/** action types that move money: they always wait for the owner's approval (the money guard); listed separately in settings */
export const MONEY_ACTIONS = ['refund', 'discount', 'payout_dispute', 'invoice_send', 'credit_note', 'payment', 'purchase_order', 'reorder'] as const

export const isActionMode = (v: unknown): v is ActionMode => v === 'act_and_tell' || v === 'ask_first'
export const ACTION_TYPE = /^[a-z][a-z0-9_.]{1,63}$/
export const isMoneyAction = (t: string) => (MONEY_ACTIONS as readonly string[]).includes(t)

/** The owner's mode for one action type in one organization (default act_and_tell; a money action is always ask_first). */
export async function modeFor(db: Db, orgId: string, actionType: string): Promise<ActionMode> {
  if (isMoneyAction(actionType)) return 'ask_first'
  if (!ACTION_TYPE.test(actionType)) return DEFAULT_MODE
  const r = await db.one<{ mode: string }>('select mode from org_action_modes where org_id = $1 and action_type = $2', [orgId, actionType])
  return isActionMode(r?.mode) ? r.mode : DEFAULT_MODE
}

// ---------------------------------------------------------------- the action types an owner can set

export type ActionTypeInfo = { key: string; label: string; money: boolean }

const MONEY_LABELS: Record<(typeof MONEY_ACTIONS)[number], string> = {
  refund: 'Refund a customer',
  discount: 'Create or change a discount',
  payout_dispute: 'Answer a payout dispute or chargeback',
  invoice_send: 'Send an invoice',
  credit_note: 'Issue a credit note',
  payment: 'Pay a bill, a vendor or a supplier',
  purchase_order: 'Place a purchase order',
  reorder: 'Reorder stock from a supplier',
}
const known = new Map<string, string>([
  ['send_customer_email', 'Email a customer'],
  ['update_listing', 'Fix a product listing'],
  ['update_inventory_policy', 'Stop or allow selling when out of stock'],
  ['tag_order', 'Tag or note an order'],
  ['fulfillment_followup', 'Chase a late shipment with the carrier or warehouse'],
  ['approve_return', 'Approve a return'],
  ['notify_crew', 'Message a packer or crew member'],
  ['schedule_appointment', 'Book or move an appointment'],
  ['send_reminder', 'Send a reminder'],
  ['reply_to_lead', 'Reply to a new lead'],
  ['update_crm', 'Update the CRM'],
  ...Object.entries(MONEY_LABELS),
])

/** Packs register the action types their agents take (label in plain words). */
export function registerActionTypes(list: { key: string; label: string }[]) {
  for (const a of list) if (ACTION_TYPE.test(a.key) && !known.has(a.key)) known.set(a.key, a.label.slice(0, 120))
}

/** Every known action type: the built-in list, those registered by packs and those named by pack agents. */
export async function knownActionTypes(): Promise<ActionTypeInfo[]> {
  const { PACK_AGENTS } = await import('../packs/registry')
  const keys = new Map(known)
  for (const a of PACK_AGENTS) for (const t of a.actions) if (ACTION_TYPE.test(t) && !keys.has(t)) keys.set(t, t.replace(/[_.]/g, ' ').replace(/^./, c => c.toUpperCase()))
  return [...keys.entries()].map(([key, label]) => ({ key, label, money: isMoneyAction(key) }))
    .sort((a, b) => Number(a.money) - Number(b.money) || a.label.localeCompare(b.label))
}
