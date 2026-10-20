export class NotImplemented extends Error {
  readonly code = 'NOT_IMPLEMENTED'
  constructor(message: string) { super(message); this.name = 'NotImplemented' }
}

export type ConnectorStatus = 'first' | 'next'
export type VendorConnector = {
  vendor: string
  label: string
  status: ConnectorStatus
  fetchVisits: (since: Date) => Promise<never>
}
