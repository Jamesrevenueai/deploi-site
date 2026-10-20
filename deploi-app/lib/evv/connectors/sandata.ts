import { NotImplemented } from './types'
export const vendor = 'sandata'
export const label = 'Sandata'
export const status = 'first' as const
export async function fetchVisits(since: Date): Promise<never> {
  throw new NotImplemented(`Sandata connector: live pull since ${since.toISOString()} is not built yet. Use the CSV import of a Sandata visit export at /staff/evv/import. A live connector needs Sandata EVV vendor/aggregator API credentials for the agency (see docs/evv-connectors.md).`)
}
