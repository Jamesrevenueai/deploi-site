import { describe, it, expect } from 'vitest'
import '../../lib/connectors'
import { readFileSync } from 'node:fs'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES, INSTALL_WRITE_SCOPES, INSTALL_SCOPES, LIBRARY_SCOPES, PROTECTED_SCOPES, shopifyConfig, ACTION_SCOPES } from '../../lib/connectors/shopify/config'
import LIBRARY from '../../lib/library/agent-library.json'
import { scopesForPolicy, missingScopes, missingScopesForPolicy } from '../../lib/connectors/shopify/scopes'
import { docFor, Q_VARIANTS, Q_NODES, Q_FIND_VARIANTS } from '../../lib/connectors/shopify/queries'

describe('install scopes: the store core plus what the 12-agent library calls; publications asked for only when used', () => {
  it('installs exactly the core and library scopes; publication scopes stay optional; no report, analytics, marketing or inventory-write scope', () => {
    expect(REQUIRED_SCOPES).toEqual(['read_products', 'write_products', 'read_inventory', 'read_locations'])
    expect(INSTALL_SCOPES).toEqual(['read_products', 'write_products', 'read_inventory', 'read_locations', 'read_discounts', 'write_discounts', 'read_orders', 'write_orders', 'read_fulfillments', 'read_customers', 'read_returns', 'write_returns', 'read_shopify_payments_payouts'])
    expect(INSTALL_WRITE_SCOPES).toEqual(['write_products', 'write_discounts', 'write_orders', 'write_returns'])
    expect(OPTIONAL_SCOPES).toEqual(['read_publications', 'write_publications'])
    expect(shopifyConfig.scopes).toEqual(INSTALL_SCOPES)
    expect(shopifyConfig.optionalScopes).toEqual(OPTIONAL_SCOPES)
    for (const s of [...INSTALL_SCOPES, ...OPTIONAL_SCOPES]) expect(s).not.toMatch(/report|analytics|marketing|write_inventory|write_customers/)
    // every scope an agent declares in the library is installed (or optional); nothing installed that no agent or core read uses
    const declared = new Set(LIBRARY.agents.flatMap(a => a.scopes))
    for (const s of declared) expect([...INSTALL_SCOPES, ...OPTIONAL_SCOPES], s).toContain(s)
    for (const s of LIBRARY_SCOPES) expect([...declared, 'write_orders', 'read_customers', 'read_fulfillments'], s).toContain(s)
    for (const s of PROTECTED_SCOPES) expect(INSTALL_SCOPES).toContain(s)
    // both app configs ask for exactly these scopes
    for (const f of ['shopify.app.deploi-dev.toml', 'shopify.app.production.toml']) expect(/^scopes = "([^"]+)"/m.exec(readFileSync(f, 'utf8'))![1].split(','), f).toEqual(INSTALL_SCOPES)
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
