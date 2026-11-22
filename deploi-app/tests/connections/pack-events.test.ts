/** Provider changes -> the business events the agent packs listen for (lib/connections/events.ts packEvents). */
import { describe, it, expect } from 'vitest'
import { packEvents, type ConnectionEvent } from '../../lib/connections/events'

const ORG = '00000000-0000-4000-8000-000000000001'
const ev = (type: string, payload: Record<string, unknown>, source: ConnectionEvent['source'] = 'crm'): ConnectionEvent =>
  ({ source, type, orgId: ORG, externalId: `${type}:x:v1`, occurredAt: '2026-11-06T10:00:00.000Z', payload, connectionId: 'c1' })

describe('connection changes -> pack events', () => {
  it('a CRM person becomes crm.lead.created once per person (not once per version)', () => {
    const a = packEvents(ev('crm.contact.changed', { provider: 'salesforce', contact: { id: '00Q1', kind: 'lead' } }))
    const b = packEvents({ ...ev('crm.contact.changed', { provider: 'salesforce', contact: { id: '00Q1', kind: 'lead' } }), externalId: 'crm.contact.changed:x:v2' })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ type: 'crm.lead.created', externalId: 'lead:salesforce:lead:00Q1', orgId: ORG, source: 'crm' })
    expect(b[0].externalId).toBe(a[0].externalId)
  })
  it('QuickBooks invoice and payment changes map to quickbooks.invoice / quickbooks.payment; a deleted payment maps to nothing', () => {
    expect(packEvents(ev('invoice.changed', { id: '130', deleted: false }, 'quickbooks'))[0]).toMatchObject({ type: 'quickbooks.invoice', payload: { invoiceId: '130' } })
    expect(packEvents(ev('payment.changed', { id: '77', deleted: false }, 'quickbooks'))[0]).toMatchObject({ type: 'quickbooks.payment', payload: { paymentId: '77' } })
    expect(packEvents(ev('payment.changed', { id: '77', deleted: true }, 'quickbooks'))).toEqual([])
  })
  it('a Buildium resident request is a new maintenance request once; a work order or lease is not', () => {
    expect(packEvents(ev('buildium.request.changed', { record: { id: 501 } }, 'buildium'))[0]).toMatchObject({ type: 'buildium.maintenance.created', externalId: 'maintenance:request:501', payload: { requestId: '501' } })
    expect(packEvents(ev('buildium.workorder.changed', { record: { id: 812 } }, 'buildium'))).toEqual([])
    expect(packEvents(ev('buildium.lease.changed', { record: { id: 9 } }, 'buildium'))).toEqual([])
  })
  it('mail and calendar changes already carry the names the packs listen for: no alias', () => {
    expect(packEvents(ev('mail.received', { from: 'a@b.example' }, 'outlook'))).toEqual([])
    expect(packEvents(ev('lead.email', {}, 'outlook'))).toEqual([])
  })
})
