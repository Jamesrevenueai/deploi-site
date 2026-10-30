import { describe, it, expect } from 'vitest'
import '../../lib/connectors'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES, shopifyConfig, ACTION_SCOPES } from '../../lib/connectors/shopify/config'
import { scopesForPolicy, missingScopes, missingScopesForPolicy } from '../../lib/connectors/shopify/scopes'
import { docFor, Q_VARIANTS, Q_NODES, Q_FIND_VARIANTS } from '../../lib/connectors/shopify/queries'

describe('install scopes are read only; write scopes are optional and asked for only when an agent may write', () => {
  it('declares read-only required scopes and every write scope as optional, with no customer, order or inventory-write scope', () => {
    expect(REQUIRED_SCOPES).toEqual(['read_products', 'read_inventory', 'read_locations'])
    expect(OPTIONAL_SCOPES).toEqual(['write_products', 'read_publications', 'write_publications'])
    expect(shopifyConfig.scopes).toEqual(REQUIRED_SCOPES)
    expect(shopifyConfig.optionalScopes).toEqual(OPTIONAL_SCOPES)
    for (const s of [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES]) expect(s).not.toMatch(/customer|order|report|write_inventory/)
    // every write an action can make is covered by an optional scope, never by a required one
    for (const scopes of Object.values(ACTION_SCOPES)) for (const s of scopes) { expect(OPTIONAL_SCOPES).toContain(s); expect(REQUIRED_SCOPES).not.toContain(s) }
  })

  it('a drafts-only policy needs nothing beyond the install; widening needs exactly the write scope of its corrections', () => {
    const stock = { correctionTypes: ['oversell_policy'], approvalMode: 'draft' }
    expect(scopesForPolicy('shopify', stock)).toEqual([])
    expect(scopesForPolicy('shopify', { ...stock, approvalMode: 'review' })).toEqual(['write_products'])
    expect(scopesForPolicy('shopify', { ...stock, approvalMode: 'autonomous' })).toEqual(['write_products'])
    expect(scopesForPolicy('shopify', { correctionTypes: ['publication'], approvalMode: 'review' })).toEqual(['write_publications'])
    expect(scopesForPolicy('shopify', { correctionTypes: ['price', 'sku', 'publication'], approvalMode: 'review' })).toEqual(['write_products', 'write_publications'])
    expect(scopesForPolicy('woocommerce', { correctionTypes: ['oversell_policy'], approvalMode: 'review' })).toEqual([])
    const readOnly = { platform: 'shopify', scopes: REQUIRED_SCOPES }
    expect(missingScopesForPolicy(readOnly, stock)).toEqual([])
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

describe('authorizeScopes', () => {
  it('adds only declared optional scopes to the required ones', async () => {
    const { authorizeScopes } = await import('../../lib/connectors/shopify/scopes')
    const req = ['read_products', 'read_inventory', 'read_locations']
    const opt = ['write_products', 'read_publications', 'write_publications']
    expect(authorizeScopes(null, req, opt)).toEqual(req)
    expect(authorizeScopes('write_products', req, opt)).toEqual([...req, 'write_products'])
    expect(authorizeScopes('write_products,write_orders,read_products, write_products', req, opt)).toEqual([...req, 'write_products'])
  })
})
