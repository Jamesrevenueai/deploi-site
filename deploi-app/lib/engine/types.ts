/**
 * Shared engine types. The engine is platform-agnostic: connectors read records and apply
 * corrections; checks turn records into findings; the engine owns issues, proposals, approvals,
 * executions, verification and the audit trail.
 */
export type Platform = 'shopify' | 'woocommerce' | 'amazon'

/** A record as read from a platform, normalised by its connector. */
export type ResourceRecord = {
  resourceType: string
  resourceId: string
  /** ISO time the platform data was read */
  fetchedAt: string
  [key: string]: unknown
}

/** A fact that must still be true, on a fresh read, for an approved change to run. */
export type Precondition = { path: string; equals: unknown; description: string }

export type Change = { field: string; from: unknown; to: unknown }

export type Correction = {
  actionKey: string
  targetType: string
  targetId: string
  targetLabel: string
  change: Change
  preconditions: Precondition[]
  /** platform-specific data the action needs (e.g. the parent product id); part of the approved hash */
  params?: Record<string, unknown>
}

export type Severity = 'high' | 'medium' | 'low'
export type IssueKind = 'correctable' | 'needs_person'

export type Finding = {
  checkKey: string
  kind: IssueKind
  fingerprint: string
  resourceType: string
  resourceId: string
  resourceLabel: string
  severity: Severity
  /** one plain sentence: what is wrong */
  summary: string
  /** the records and rule facts that establish the problem */
  evidence: Record<string, unknown>
  correction?: Correction
  /** what a person needs to do when there is no supported correction */
  humanAction?: string
}

/** Store-wide facts a check may need (duplicate SKUs, barcodes, currency). `complete` is false when built from targeted lookups. */
export type StoreContext = {
  currency: string | null
  variantIdsBySku: (sku: string) => string[]
  variantIdsByBarcode: (barcode: string) => string[]
  variantIdsByHandleTitle: (handle: string, variantTitle: string) => string[]
  complete: boolean
}

export type CheckContext = {
  /** merchant rule version, or the agent policy version */
  ruleVersion: number
  agentId?: string | null
  /** merchant reference files by source id (price lists, SKU mappings, publication lists) */
  references?: Record<string, import('../agents/references').ReferenceIndex>
  store?: StoreContext
}

/** Values a check needs looked up store-wide for a targeted read (e.g. other variants using the same SKU). */
export type LookupKeys = { skus: string[]; barcodes: string[]; handles: string[] }

export type CheckDef<R extends ResourceRecord = ResourceRecord, F extends Finding | Finding[] = Finding | Finding[]> = {
  key: string
  platform: Platform
  title: string
  /** what the check looks for, in merchant language */
  description: string
  /** why a match is an actual error rather than an intentional configuration */
  whyItIsAnError: string
  kind: IssueKind
  resourceType: string
  defaultEnabled: boolean
  defaultConfig: Record<string, unknown>
  /** configured only through an agent policy (needs a reference file or channel), never as a store-wide rule */
  agentOnly?: boolean
  /** validate and normalise merchant input; throws on invalid config */
  parseConfig: (raw: unknown) => Record<string, unknown>
  detect: (record: R, config: Record<string, unknown>, ctx: CheckContext) => F | null
  /** optional: store-wide values to look up when only some records were read */
  lookupKeys?: (record: R, config: Record<string, unknown>, ctx: CheckContext) => LookupKeys
}

export type ConnectionRow = {
  id: string
  org_id: string
  platform: Platform
  external_id: string
  display_name: string | null
  status: 'pending' | 'active' | 'uninstalled' | 'error' | 'disconnected'
  scopes: string[]
  api_version: string | null
  is_synthetic: boolean
  timezone: string | null
  currency?: string | null
}

export type ApplyResult = {
  /** applied: platform accepted the write; rejected: platform refused (definite); unknown: no definite answer (timeout, 5xx) */
  outcome: 'applied' | 'rejected' | 'unknown'
  request: Record<string, unknown>
  response: Record<string, unknown> | null
  error?: string
  /** true when the connector refused before sending any write (permission or preflight); the engine reports it as blocked */
  blocked?: boolean
}

export interface Connector<R extends ResourceRecord = ResourceRecord> {
  platform: Platform
  /** false until the connector has been built and verified; planned connectors refuse every call */
  operational: boolean
  /** access scopes needed to read, and per action key to write */
  requiredScopes: { read: string[]; actions: Record<string, string[]> }
  /** full catalogue read, page by page */
  listResources(conn: ConnectionRow): AsyncGenerator<R[]>
  /** fresh read of specific resources (precheck, verification, targeted rescans); missing ids are absent from the map */
  readResources(conn: ConnectionRow, resourceIds: string[]): Promise<Map<string, R>>
  /** perform one approved correction; `allowedFields` is enforced by the connector as well as the engine */
  applyAction(conn: ConnectionRow, correction: Correction, allowedFields?: string[]): Promise<ApplyResult>
  /** optional: find records by store-wide keys (SKU, barcode, product handle) */
  findResources?(conn: ConnectionRow, keys: LookupKeys): Promise<R[]>
}

export class NotOperational extends Error {
  constructor(public platform: Platform) { super(`${platform} connector is planned, not operational`); this.name = 'NotOperational' }
}
