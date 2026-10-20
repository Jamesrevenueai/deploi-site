import * as sandata from './sandata'
import * as alayacare from './alayacare'
import * as hhaexchange from './hhaexchange'
import * as wellsky from './wellsky'
import type { VendorConnector } from './types'

export { NotImplemented } from './types'
export const CONNECTORS: VendorConnector[] = [sandata, alayacare, hhaexchange, wellsky].map(m => ({
  vendor: m.vendor, label: m.label, status: m.status, fetchVisits: m.fetchVisits,
}))
export function connector(vendor: string): VendorConnector | undefined {
  return CONNECTORS.find(c => c.vendor === vendor)
}
