/** Response shapes of the customer-experience APIs as the browser receives them. */
import type { ControlRoom, Integration, IntegrationStatus, Tier, AgentHealth, StopAllResult } from '@/lib/store/control-room'
import type { WizardView, WizardStep, AutoSetupResult } from '@/lib/library/onboarding'

export type { ControlRoom, Integration, IntegrationStatus, Tier, AgentHealth, StopAllResult, WizardView, WizardStep, AutoSetupResult }
export type ControlRoomResponse = { ok: true; canAct: boolean } & ControlRoom
export type WizardResponse = { ok: true; wizard: WizardView }
export type WizardOpResponse<R = unknown> = { ok: true; result: R; wizard: WizardView }

/** Client-safe labels for the three permission tiers (the server's own labels live with the policy code). */
export const TIER_WORDS: Record<Tier, string> = { draft: 'Drafts only', send_approved: 'After my approval', send_autonomous: 'Without asking, within limits' }
export const INTEGRATION_WORDS: Record<IntegrationStatus, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  connected: { label: 'Connected', tone: 'ok' },
  needs_setup: { label: 'Needs setup', tone: 'warn' },
  not_available: { label: 'Not available yet', tone: 'muted' },
}

/** "about 1 h 20 min" for the weekly estimate */
export function minutesInWords(m: number): string {
  if (m <= 0) return '0 min'
  const h = Math.floor(m / 60), r = m % 60
  return h ? `about ${h} h${r ? ` ${r} min` : ''}` : `about ${r} min`
}
