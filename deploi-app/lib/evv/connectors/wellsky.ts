import { NotImplemented } from './types'
export const vendor = 'wellsky'
export const label = 'WellSky'
export const status = 'next' as const
export async function fetchVisits(since: Date): Promise<never> {
  throw new NotImplemented(`WellSky connector: live pull since ${since.toISOString()} is not built yet. Export visits to CSV and use the generic mapper at /staff/evv/import. A live connector needs WellSky Personal Care API access through their partner program (see docs/evv-connectors.md).`)
}
