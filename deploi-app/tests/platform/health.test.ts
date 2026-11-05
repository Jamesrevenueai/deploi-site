/** /api/health carries the AI gateway status and the retention and deletion lag, and never tenant data. */
import { describe, it, expect } from 'vitest'
import { prepareDb } from '../db/helpers'
import { GET as health } from '../../app/api/health/route'

const ready = await prepareDb()

describe.skipIf(!ready)('health: platform signals', () => {
  it('reports the AI gateway (off by default), retention and deletion lag as counts and ages only', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    const j = await res.json() as Record<string, unknown>
    expect(j.ai).toMatchObject({ provider: expect.any(String), configured: expect.any(Boolean), lastHour: { calls: expect.any(Number), providerErrors: expect.any(Number), refused: expect.any(Number) } })
    expect(j.retention).toMatchObject({ status: expect.any(String) })
    expect(j.deletion).toMatchObject({ overdue: expect.any(Number), failed: expect.any(Number) })
    const text = JSON.stringify(j)
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) // no organization or row id
    expect(text).not.toMatch(/@/)
  })
})
