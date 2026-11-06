/**
 * Which packs an organization runs, and their settings. The business type chosen at setup turns packs on
 * (PACKS[pack].businessTypes in lib/packs/registry.ts). Writes run as the service role after the caller was
 * shown to be a merchant of the organization; reads may run as the user (RLS).
 */
import { admin, type Db } from '../db'
import { assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { PACKS, type BusinessType, type PackKey } from './registry'

export const BUSINESS_TYPES: { key: BusinessType; label: string; hint: string }[] = [
  { key: 'home_services', label: 'Home services', hint: 'Construction, HVAC, roofing, landscaping, cleaning' },
  { key: 'leasing_agent', label: 'Leasing agent or apartment locator', hint: 'Renter leads, tours, commission invoices' },
  { key: 'real_estate_agent', label: 'Real estate agent', hint: 'Buyer and seller leads, showings, your CRM' },
  { key: 'property_manager', label: 'Property manager', hint: 'Maintenance requests, vendors, rent reminders, leasing' },
  { key: 'store', label: 'Online store', hint: 'Shopify or WooCommerce' },
  { key: 'office', label: 'Other business', hint: 'Invoices, leads, inbox and scheduling' },
]
export const TRADES = ['construction', 'hvac', 'roofing', 'landscaping', 'cleaning', 'general'] as const
export type Trade = (typeof TRADES)[number]
export const isBusinessType = (v: unknown): v is BusinessType => typeof v === 'string' && BUSINESS_TYPES.some(b => b.key === v)

export const packsForBusiness = (t: BusinessType): PackKey[] => (Object.keys(PACKS) as PackKey[]).filter(k => PACKS[k].businessTypes.includes(t))

export type PackConfig = {
  senderName: string
  timezone: string
  /** business hours for visits, tours and showings */
  days: number[]; dayStart: string; dayEnd: string
  visitMinutes: number; tourMinutes: number; showingMinutes: number
  /** days after the first reply for each follow-up (leads that went quiet) */
  leadFollowUpDays: number[]
  /** days after a quote for each follow-up */
  quoteFollowUpDays: number[]
  paymentTermsDays: number
  /** days after the due date for each payment reminder */
  paymentReminderDays: number[]
  /** hours a crew member or vendor has to confirm before a reminder, and before the owner is told */
  confirmReminderHours: number; confirmEscalateHours: number
  reviewUrl: string | null
  applicationUrl: string | null
  /** the day the weekly commission summary goes out (ISO weekday, 1 = Monday) */
  weeklyReportDay: number
  currency: string
}
export const DEFAULT_CONFIG: Omit<PackConfig, 'senderName' | 'timezone'> = {
  days: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:00', visitMinutes: 60, tourMinutes: 30, showingMinutes: 45,
  leadFollowUpDays: [2, 5, 10], quoteFollowUpDays: [3, 7, 14], paymentTermsDays: 14, paymentReminderDays: [3, 10, 20],
  confirmReminderHours: 2, confirmEscalateHours: 4, reviewUrl: null, applicationUrl: null, weeklyReportDay: 1, currency: 'USD',
}

export type OrgPacks = { orgId: string; businessType: BusinessType | null; packs: PackKey[]; trade: Trade; config: PackConfig }

export async function orgPacks(db: Db, orgId: string): Promise<OrgPacks> {
  const org = await db.one<{ name: string; timezone: string | null }>('select name, timezone from agencies where id = $1', [orgId])
  const r = await db.one<{ business_type: BusinessType; packs: PackKey[]; trade: Trade | null; settings: Partial<PackConfig> }>('select business_type, packs, trade, settings from pack_settings where org_id = $1', [orgId])
  const config: PackConfig = { ...DEFAULT_CONFIG, senderName: org?.name ?? 'Our team', timezone: org?.timezone || 'UTC', ...(r?.settings ?? {}) }
  return { orgId, businessType: r?.business_type ?? null, packs: r?.packs ?? [], trade: r?.trade ?? 'general', config }
}
export async function packOn(db: Db, orgId: string, pack: PackKey) { return (await orgPacks(db, orgId)).packs.includes(pack) }

function merchantOrg(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not change a customer\'s setup')
  assertMerchant(actor, actor.orgId)
  return actor.orgId
}

/** The business-type choice at setup: turns its packs on (and the packs of any other type off). */
export async function chooseBusinessType(actor: Actor, input: { businessType: unknown; trade?: unknown }) {
  const orgId = merchantOrg(actor)
  if (!isBusinessType(input.businessType)) throw new EngineError('invalid_input', 'choose a business type')
  const trade = input.trade === undefined || input.trade === null ? null : String(input.trade)
  if (trade && !(TRADES as readonly string[]).includes(trade)) throw new EngineError('invalid_input', 'choose a trade from the list')
  const packs = packsForBusiness(input.businessType)
  await admin(db => db.query(`insert into pack_settings (org_id, business_type, packs, trade, updated_by) values ($1,$2,$3,$4,$5)
    on conflict (org_id) do update set business_type = excluded.business_type, packs = excluded.packs, trade = coalesce(excluded.trade, pack_settings.trade), updated_by = excluded.updated_by`,
    [orgId, input.businessType, packs, trade, actor.label]))
  return { businessType: input.businessType, packs }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const days = (v: unknown, max: number) => Array.isArray(v) && v.length <= 6 && v.every(n => Number.isInteger(n) && n >= 0 && n <= max) ? [...(v as number[])].sort((a, b) => a - b) : undefined
/** Change pack settings (validated field by field; unknown fields are refused). */
export async function updatePackConfig(actor: Actor, patch: Record<string, unknown>) {
  const orgId = merchantOrg(actor)
  const out: Partial<PackConfig> = {}
  for (const [k, v] of Object.entries(patch)) {
    const bad = () => { throw new EngineError('invalid_input', `${k}: not a valid value`) }
    switch (k) {
      case 'senderName': if (typeof v !== 'string' || !v.trim() || v.length > 80) bad(); out.senderName = String(v).trim(); break
      case 'dayStart': case 'dayEnd': if (typeof v !== 'string' || !HHMM.test(v)) bad(); out[k] = v as string; break
      case 'days': { const d = Array.isArray(v) && v.length && v.every(n => Number.isInteger(n) && n >= 1 && n <= 7) ? [...new Set(v as number[])].sort() : null; if (!d) bad(); out.days = d!; break }
      case 'visitMinutes': case 'tourMinutes': case 'showingMinutes': if (!Number.isInteger(v) || (v as number) < 15 || (v as number) > 240) bad(); out[k] = v as number; break
      case 'paymentTermsDays': if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 120) bad(); out.paymentTermsDays = v as number; break
      case 'confirmReminderHours': case 'confirmEscalateHours': if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 72) bad(); out[k] = v as number; break
      case 'weeklyReportDay': if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 7) bad(); out.weeklyReportDay = v as number; break
      case 'leadFollowUpDays': case 'quoteFollowUpDays': case 'paymentReminderDays': { const d = days(v, 60); if (!d) bad(); out[k] = d!; break }
      case 'reviewUrl': case 'applicationUrl': if (v !== null && (typeof v !== 'string' || !/^https:\/\/[^\s<>"]{4,400}$/.test(v))) bad(); out[k] = v as string | null; break
      case 'currency': if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) bad(); out.currency = v as string; break
      default: throw new EngineError('invalid_input', `${k} is not a pack setting`)
    }
  }
  if ((out.confirmEscalateHours ?? 99) <= (out.confirmReminderHours ?? 0)) throw new EngineError('invalid_input', 'the owner is told after the reminder: confirmEscalateHours must be larger')
  const r = await admin(db => db.query(`update pack_settings set settings = settings || $2::jsonb, updated_by = $3 where org_id = $1 returning org_id`, [orgId, JSON.stringify(out), actor.label]))
  if (!r.length) throw new EngineError('not_pending', 'choose your business type first')
  return out
}
