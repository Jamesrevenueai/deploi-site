import { describe, it, expect } from 'vitest'
import '../../lib/connectors'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES, INSTALL_WRITE_SCOPES, shopifyConfig, ACTION_SCOPES } from '../../lib/connectors/shopify/config'
import { scopesForPolicy, missingScopes, missingScopesForPolicy } from '../../lib/connectors/shopify/scopes'
import { docFor, Q_VARIANTS, Q_NODES, Q_FIND_VARIANTS } from '../../lib/connectors/shopify/queries'

describe('install scopes: the reads plus the one write the ready agents fix with; the rest asked for only when used', () => {
  it('installs read scopes plus write_products; publication scopes stay optional; no customer, order or inventory-write scope', () => {
    expect(REQUIRED_SCOPES).toEqual(['read_products', 'write_products', 'read_inventory', 'read_locations'])
    expect(INSTALL_WRITE_SCOPES).toEqual(['write_products'])
    expect(OPTIONAL_SCOPES).toEqual(['read_publications', 'write_publications'])
    expect(shopifyConfig.scopes).toEqual(REQUIRED_SCOPES)
    expect(shopifyConfig.optionalScopes).toEqual(OPTIONAL_SCOPES)
    for (const s of [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES]) expect(s).not.toMatch(/customer|order|report|write_inventory|write_discounts/)
    // every write an action can make is covered by an install or an optional scope; never both
    for (const scopes of Object.values(ACTION_SCOPES)) for (const s of scopes) { expect([...REQUIRED_SCOPES, ...OPTIONAL_SCOPES]).toContain(s); expect(REQUIRED_SCOPES.includes(s) && OPTIONAL_SCOPES.includes(s)).toBe(false) }
    // the ready store agents' corrections (Inventory Watcher: oversell_policy) need only what the install grants
    expect(missingScopesForPolicy({ platform: 'shopify', scopes: REQUIRED_SCOPES }, { correctionTypes: ['oversell_policy'], approvalMode: 'autonomous' })).toEqual([])
  })

  it('a drafts-only policy needs nothing beyond the install; widening needs exactly the write scope of its corrections', () => {
    const stock = { correctionTypes: ['oversell_policy'], approvalMode: 'draft' }
    expect(scopesForPolicy('shopify', stock)).toEqual([])
    expect(scopesForPolicy('shopify', { ...stock, approvalMode: 'review' })).toEqual(['write_products'])
    expect(scopesForPolicy('shopify', { ...stock, approvalMode: 'autonomous' })).toEqual(['write_products'])
    expect(scopesForPolicy('shopify', { correctionTypes: ['publication'], approvalMode: 'review' })).toEqual(['write_publications'])
    expect(scopesForPolicy('shopify', { correctionTypes: ['price', 'sku', 'publication'], approvalMode: 'review' })).toEqual(['write_products', 'write_publications'])
    expect(scopesForPolicy('woocommerce', { correctionTypes: ['oversell_policy'], approvalMode: 'review' })).toEqual([])
    const readOnly = { platform: 'shopify', scopes: REQUIRED_SCOPES.filter(s => s !== 'write_products') }
    expect(missingScopesForPolicy(readOnly, stock)).toEqual([])
    // an install from before write_products was requested at install still asks for it when an agent widens
    expect(missingScopesForPolicy(readOnly, { ...stock, approvalMode: 'review' })).toEqual(['write_products'])
    expect(missingScopesForPolicy({ platform: 'shopify', scopes: [...REQUIRED_SCOPES, 'write_products'] }, { ...stock, approvalMode: 'review' })).toEqual([])
    expect(missingScopes(['a'], ['a', 'b'])).toEqual(['b'])
  })

  it('reads publication fields only when read_publications is granted, so a read-only install scans without ACCESS_DENIED', () => {
    for (const q of [Q_VARIANTS, Q_NODES, Q_FIND_VARIANTS]) {
      expect(q).toContain('resourcePublicationsV2')
      expect(docFor(q, REQUIRED_SCOPES)).not.toContain('resourcePublicationsV2')
      expect(docFor(q, [...REQUIRED_SCOPES, 'read_publications'])).toContain('resourcePublicationsV2')
      expect(docFor(q, REQUIRED_SCOPES)).toContain('inventoryPolicy')
    }
  })
})
