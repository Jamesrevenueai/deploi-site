import { Client } from 'pg'
import { migrate } from '../../scripts/migrate'
import { seed } from '../../scripts/seed'
import { uuidFrom } from '../../lib/ids'
import type { Session } from '../../lib/session'

let prepared = false
/** Migrate + seed the test database once per run. Skips when DATABASE_URL is unset. */
export async function prepareDb() {
  const url = process.env.DATABASE_URL
  if (!url) return false
  if (prepared) return true
  const c = new Client({ connectionString: url })
  await c.connect().catch(() => null)
  await c.end().catch(() => null)
  await migrate(url)
  await seed(url)
  prepared = true
  return true
}

export const ORG_NW = uuidFrom('merchant:northwind')
export const ORG_HB = uuidFrom('merchant:harbor')
export const SESSIONS: Record<'staff' | 'northwind' | 'harbor', Session> = {
  staff: { uid: uuidFrom('user:hello'), email: 'hello@getdeploi.com', role: 'staff', agencyId: null },
  northwind: { uid: uuidFrom('user:merchant:northwind'), email: 'owner@northwind-goods.example', role: 'client', agencyId: ORG_NW, orgType: 'merchant' },
  harbor: { uid: uuidFrom('user:merchant:harbor'), email: 'owner@harbor-supply.example', role: 'client', agencyId: ORG_HB, orgType: 'merchant' },
}
