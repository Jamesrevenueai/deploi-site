import { NotImplemented } from './types'
export const vendor = 'hhaexchange'
export const label = 'HHAeXchange'
export const status = 'next' as const
export async function fetchVisits(since: Date): Promise<never> {
  throw new NotImplemented(`HHAeXchange connector: live pull since ${since.toISOString()} is not built yet. Export the visit/EVV report to CSV and use the generic mapper at /staff/evv/import. A live connector needs HHAeXchange partner/integration API access (see docs/evv-connectors.md).`)
}
