/**
 * Discovery contract. A detector looks at what an organization has connected (only data it is authorized to
 * read), finds supported operational problems, and names the agent template that would handle them. It
 * never invents data and never acts: findings become `detected` cases (lib/cases) and recommendations the
 * owner reviews and grants. Domains register detectors; lib/discovery runs them.
 */
import type { Db } from '../db'
import type { Evidence, CaseRecord, Priority, Suite } from '../cases'

export type DiscoveryFinding = {
  /** case kind this finding opens (e.g. supplier_exception, lead_followup, invoice_overdue) */
  kind: string
  /** stable per problem: the case dedupe key */
  dedupeKey: string
  title: string
  problem: string
  whyItMatters?: string
  priority?: Priority
  evidence: Evidence[]
  records: CaseRecord[]
  /** what must be observed for the case to count as resolved */
  verification: { criteria: string; rule?: Record<string, unknown> }
}

export type AgentRecommendation = {
  /** template key the owner can create (drafts only until granted) */
  template: string
  suite: Suite
  name: string
  /** why Deploi recommends it, from the findings (counts, not invented values) */
  reason: string
  /** what the owner must still supply before granting (e.g. a supplier email), never guessed */
  needs: string[]
}

export type DetectorContext = { orgId: string; now: Date }
export type DetectorResult = { findings: DiscoveryFinding[]; recommendation: AgentRecommendation | null; sourcesRead: string[]; notes?: string[] }

export type Detector = {
  key: string
  suite: Suite
  /** the source application this detector reads (shopify, woocommerce, hubspot, quickbooks, deploi_email ...) */
  sourceApp: string
  /** cheap check: is the needed connection present and readable for this org? */
  available(db: Db, orgId: string): Promise<boolean>
  detect(ctx: DetectorContext): Promise<DetectorResult>
}

const detectors = new Map<string, Detector>()
export function registerDetector(d: Detector) { detectors.set(d.key, d) }
export const listDetectors = () => [...detectors.values()]
