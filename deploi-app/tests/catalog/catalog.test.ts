import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SERVICES, getService, serviceForWorker } from '../../lib/catalog/services'
import { WORKER_NAMES } from '../../lib/workers/types'
import { getPricing } from '../../lib/catalog/pricing'
import { catalogJson } from '../../scripts/export-catalog'

describe('service catalog', () => {
  it('has exactly the eight services from the brief, every worker mapped to one service', () => {
    expect(SERVICES.map(s => s.key).sort()).toEqual(['applicant_screening', 'authorization_watch', 'credential_tracking', 'evv_exceptions', 'open_shift_fill', 'referral_response', 'retention_checkins', 'website_improvement'].sort())
    for (const w of WORKER_NAMES) expect(serviceForWorker(w), w).toBeTruthy()
  })
  it('every service carries the required fields and no service is production_verified by default', () => {
    for (const s of SERVICES) {
      for (const k of ['description', 'targetCustomer', 'availability'] as const) expect(s[k], `${s.key}.${k}`).toBeTruthy()
      for (const k of ['inputMethods', 'requiredAccess', 'setupDeliverables', 'customerResponsibilities', 'deploiResponsibilities', 'volumeLimits', 'exclusions', 'humanReview', 'successMeasures'] as const) expect(s[k].length, `${s.key}.${k}`).toBeGreaterThan(0)
      expect(s.availability).not.toBe('production_verified')
      for (const m of s.successMeasures) expect(m.definition).toMatch(/÷|median|published/i)
    }
  })
  it('Website Improvement is $500 one-time, standalone, and never credited toward another service', () => {
    const w = getService('website_improvement')!
    expect(w.standalone).toBe(true)
    const p = getPricing()
    expect(p.website.price).toBe(500)
    expect(p.website.standalone).toBe(true)
    expect(p.website.creditsTowardOtherServices).toBe(false)
    expect(p.assessment).toMatchObject({ min: 1500, max: 2500 })
    expect(p.build).toMatchObject({ min: 3000, max: 7000 })
    expect(p.management).toMatchObject({ min: 500, max: 1500, initialTermMonths: 3 })
  })
  it('the exported site copy is in sync with the catalog', () => {
    const file = join(__dirname, '../../../src/data/catalog.json')
    if (!existsSync(file)) return // site copy not generated in this checkout
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(catalogJson())))
  })
})
