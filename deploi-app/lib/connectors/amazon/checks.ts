/**
 * Amazon Seller Central (PLANNED). Detection logic only, from docs/platform-research/amazon.md.
 * Amazon is the authority for listing issues and buyability, so findings come from what Amazon
 * reports. Corrections to listing attributes need seller-provided data, and seller-fulfilled
 * quantities must come from a stock source the seller configures; neither is guessed, so the
 * first Amazon check routes to a person.
 */
import type { CheckDef, Finding, ResourceRecord } from '../../engine/types'

export type AmazonIssue = { code: string; message: string; severity: 'ERROR' | 'WARNING' | 'INFO'; attributeNames?: string[]; categories?: string[]; enforcements?: { actions?: { action: string }[] } }
export type AmazonListingRecord = ResourceRecord & {
  resourceType: 'amazon_listing'
  sellerId: string
  marketplaceId: string
  sku: string
  asin: string | null
  title: string | null
  status: string[]
  issues: AmazonIssue[]
}

export const AMAZON_ERRORS_CHECK = 'amazon.listing_errors'

export const amazonListingErrorsCheck: CheckDef<AmazonListingRecord, Finding> = {
  key: AMAZON_ERRORS_CHECK,
  platform: 'amazon',
  title: 'Amazon reports an error on this listing',
  description: 'Listings with an ERROR-severity issue reported by Amazon, with any enforcement such as suppression.',
  whyItIsAnError: 'Amazon itself classifies these issues as errors; Deploi does not infer them. Fixing one usually needs product data only the seller has, so a person decides.',
  kind: 'needs_person',
  resourceType: 'amazon_listing',
  defaultEnabled: true,
  defaultConfig: {},
  parseConfig: () => ({}),
  detect(r): Finding | null {
    const errors = r.issues.filter(i => i.severity === 'ERROR')
    if (!errors.length) return null
    const enforcement = errors.flatMap(i => i.enforcements?.actions?.map(a => a.action) ?? [])
    const buyable = r.status.includes('BUYABLE')
    return {
      checkKey: AMAZON_ERRORS_CHECK, kind: 'needs_person', fingerprint: `${AMAZON_ERRORS_CHECK}:${r.resourceId}:${errors.map(e => e.code).sort().join(',')}`,
      resourceType: r.resourceType, resourceId: r.resourceId, resourceLabel: `${r.title ?? r.sku} (SKU ${r.sku})`,
      severity: !buyable || enforcement.length ? 'high' : 'medium',
      summary: `${errors.length} error${errors.length === 1 ? '' : 's'} reported by Amazon${!buyable ? '; not buyable' : ''}.`,
      evidence: { sku: r.sku, asin: r.asin, marketplaceId: r.marketplaceId, status: r.status, errors: errors.map(e => ({ code: e.code, message: e.message, attributeNames: e.attributeNames ?? [], enforcement: e.enforcements?.actions?.map(a => a.action) ?? [] })), fetchedAt: r.fetchedAt },
      humanAction: 'Open the listing in Seller Central and supply the data Amazon asks for. Deploi will re-read the listing and close this once Amazon stops reporting the error.',
    }
  },
}
