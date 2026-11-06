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
  /** the application the problem is in, when it differs from the detector's sourceApp (optional) */
  sourceApp?: string
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

/**
 * `shared` (optional) lives for one discovery run: detectors that read the same source (two store detectors
 * reading one catalog) cache the read there instead of reading it twice. `deadline` (epoch ms, optional) is
 * when the run stops waiting for this detector; a detector that can stop early should.
 */
export type DetectorContext = { orgId: string; now: Date; shared?: Map<string, unknown>; deadline?: number }

/** A fact for the business profile: a count or plain value read from an authorized source, never inferred. */
export type ProfileFact = { key: string; label: string; value: number | string | boolean; source: string; observedAt: string; /** the count stopped at a read limit: "at least" */ capped?: boolean }

export type DetectorResult = {
  findings: DiscoveryFinding[]; recommendation: AgentRecommendation | null; sourcesRead: string[]; notes?: string[]
  /** further recommendations, when one detector's findings call for more than one agent (optional) */
  recommendations?: AgentRecommendation[]
  /** profile facts the detector observed while reading (optional) */
  facts?: ProfileFact[]
}

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
/** Tests only: remove a detector registered for one test. */
export function unregisterDetector(key: string) { detectors.delete(key) }
export const listDetectors = () => [...detectors.values()]
