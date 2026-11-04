import { describe, it, expect } from 'vitest'
import { describePolicyChange, needsNewGrant } from '../../components/cx/policyDiff'
import { effectiveStatus } from '../../components/cx/Integrations'
import { minutesInWords } from '../../components/cx/types'
import { parsePolicy } from '../../lib/agents/policy'
import { navActive } from '../../lib/nav'
import { MERCHANT_NAV } from '../../lib/store/nav'
import type { Integration } from '../../lib/store/control-room'

const base = parsePolicy({ connectionId: '11111111-1111-4111-8111-111111111111', productScope: { mode: 'tags', tags: ['summer'] }, correctionTypes: ['oversell_policy'],
  email: { accountId: '22222222-2222-4222-8222-222222222222', purpose: 'Alert the owner', tasks: ['needs_person_alert'], recipients: { addresses: ['me@example.com'] }, notify: ['me@example.com'] } })

describe('edit preview', () => {
  it('flags widening as needing a new grant and narrowing as taking effect at once', () => {
    expect(needsNewGrant(describePolicyChange(base, base))).toBe(false)
    expect(describePolicyChange(base, base)[0].kind).toBe('same')
    const wider = parsePolicy({ ...base, approvalMode: 'review', productScope: { mode: 'all' }, email: { ...base.email, recipients: { addresses: ['me@example.com', 'supplier@example.com'], domains: [] } } })
    const c = describePolicyChange(base, wider)
    expect(needsNewGrant(c)).toBe(true)
    expect(c.map(x => x.text)).toEqual(expect.arrayContaining(['Store permission: Drafts only → After my approval', 'Products: products tagged "summer" → every product', 'New recipients: supplier@example.com']))
    const narrower = parsePolicy({ ...base, limits: { maxChangesPerRun: 5, maxChangesPerDay: 10 } })
    const n = describePolicyChange(base, narrower)
    expect(needsNewGrant(n)).toBe(false)
    expect(n[0].kind).toBe('narrower')
    expect(describePolicyChange(null, base)[0].kind).toBe('wider')
  })
})

describe('integration status on the page', () => {
  const item = (o: Partial<Integration>): Integration => ({ key: 'hubspot', name: 'HubSpot', group: 'office', status: 'needs_setup', detail: '', usedFor: 'x', permissions: ['y'], href: '/office/connections', probe: true, liveVerified: false, ...o })
  it('a page that is not deployed reads "not available yet" and offers no link; a real connection stays connected', () => {
    expect(effectiveStatus(item({}), 'missing')).toEqual({ status: 'not_available', linkable: false })
    expect(effectiveStatus(item({}), 'available')).toEqual({ status: 'needs_setup', linkable: true })
    expect(effectiveStatus(item({}), 'checking').linkable).toBe(false)
    expect(effectiveStatus(item({ status: 'connected' }), 'missing').status).toBe('connected')
    expect(effectiveStatus(item({ key: 'gmail', probe: false, status: 'not_available' }), undefined).linkable).toBe(false)
    expect(effectiveStatus(item({ key: 'shopify', probe: false, status: 'not_available' }), undefined).linkable).toBe(true)
  })
})

describe('navigation and words', () => {
  it('the Control Room is the store home and highlights on its own path; Integrations covers the old connection pages', () => {
    expect(MERCHANT_NAV[0]).toMatchObject({ href: '/store', label: 'Control Room' })
    expect(navActive(MERCHANT_NAV[0], '/store')).toBe(true)
    expect(navActive(MERCHANT_NAV[0], '/store/control-room')).toBe(true)
    expect(navActive(MERCHANT_NAV[0], '/store/agents')).toBe(false)
    const integ = MERCHANT_NAV.find(n => n.href === '/store/integrations')!
    expect(navActive(integ, '/store/connections')).toBe(true)
    expect(navActive(integ, '/store/connect/woocommerce')).toBe(true)
    expect(minutesInWords(0)).toBe('0 min')
    expect(minutesInWords(80)).toBe('about 1 h 20 min')
  })
})
