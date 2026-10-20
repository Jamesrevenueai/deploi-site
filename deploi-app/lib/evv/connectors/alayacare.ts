import { NotImplemented } from './types'
export const vendor = 'alayacare'
export const label = 'AlayaCare'
export const status = 'next' as const
export async function fetchVisits(since: Date): Promise<never> {
  throw new NotImplemented(`AlayaCare connector: live pull since ${since.toISOString()} is not built yet. Export visits to CSV and use the generic mapper at /staff/evv/import. A live connector needs AlayaCare REST API partner credentials (see docs/evv-connectors.md).`)
}
