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

export const AGENCY_A = uuidFrom('agency:buckeye')
export const AGENCY_B = uuidFrom('agency:scioto')
export const SESSIONS: Record<'staff' | 'clientA' | 'clientB', Session> = {
  staff: { uid: uuidFrom('user:hello'), email: 'hello@getdeploi.com', role: 'staff', agencyId: null },
  clientA: { uid: uuidFrom('user:buckeye-admin'), email: 'admin@buckeyehomecare.example', role: 'client', agencyId: AGENCY_A },
  clientB: { uid: uuidFrom('user:scioto-admin'), email: 'admin@sciotovalley.example', role: 'client', agencyId: AGENCY_B },
}
