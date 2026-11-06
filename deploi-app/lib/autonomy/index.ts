/**
 * Autonomy model (owner setting per action type). SHARED INTERFACE — owned by workstream W1.
 *   'act_and_tell' (default): the agent acts on its own, verifies, logs proof and tells the owner after.
 *   'ask_first': the agent prepares the exact action and waits for the owner's approval.
 * Money actions (refunds, discounts, payout disputes) are act_and_tell by default too, and can be switched to ask_first.
 * Hard limits (amount caps, daily caps, allowed recipients) still apply in both modes.
 */
import type { Db } from '../db'

export type ActionMode = 'act_and_tell' | 'ask_first'
export const DEFAULT_MODE: ActionMode = 'act_and_tell'
/** action types that move money; listed separately in settings so an owner can switch them to ask_first */
export const MONEY_ACTIONS = ['refund', 'discount', 'payout_dispute', 'invoice_send', 'credit_note'] as const

/** The owner's mode for one action type in one organization (default act_and_tell). W1 replaces the body with the stored setting. */
export async function modeFor(_db: Db, _orgId: string, _actionType: string): Promise<ActionMode> {
  return DEFAULT_MODE
}
