/** Door and leak → the catalog service that is the recommended first workflow, and its first success measure. */
import { SERVICES, servicesByDoor, getService, type ServiceDef, type Door } from '../catalog/services'
import type { Leak, LeakKey } from '../leaks'

export const LEAK_SERVICE: Record<LeakKey, string> = {
  referral_response: 'referral_response',
  open_shifts: 'open_shift_fill',
  turnover: 'retention_checkins',
  evv_denials: 'evv_exceptions',
  evv_denials_delayed: 'evv_exceptions',
  staff_capacity: 'open_shift_fill',
  cash_savings: 'evv_exceptions',
}

/** The first workflow to build: the service behind the biggest leak, else the door's first non-standalone service. Never a standalone service. */
export function recommendedService(leaks: Leak[], door: Door): ServiceDef {
  const fromLeak = leaks[0] ? getService(LEAK_SERVICE[leaks[0].key]) : undefined
  if (fromLeak && !fromLeak.standalone) return fromLeak
  const byDoor = servicesByDoor(door).find(s => !s.standalone)
  return byDoor ?? SERVICES.find(s => !s.standalone)!
}

export function successMetric(svc: ServiceDef) {
  return svc.successMeasures[0] ?? null
}
