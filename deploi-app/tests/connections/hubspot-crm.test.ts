import { describe, it, expect, afterEach } from 'vitest'
import { hubspotCrm } from '../../lib/crm/hubspot'
import { hubspotRevoke } from '../../lib/office/hubspot'
import { calls, fake, json, path, resetFake, tokens } from './fake-http'

const contact = (id: string, p: Record<string, string> = {}) => ({ id, properties: { email: 'ana@example.com', firstname: 'Ana', lastname: 'Ruiz', lifecyclestage: 'lead', lastmodifieddate: '2026-11-01T00:00:00Z', ...p } })

describe('HubSpot behind the CRM contract (fake HTTP; no real call is made)', () => {
  afterEach(resetFake)

  it('find by exact email; upsert updates the found contact or creates a lead', async () => {
    fake(c => c.url.pathname.endsWith('/search') ? json(200, { results: [contact('101')] }) : json(200, contact('101', { phone: '555' })))
    const crm = hubspotCrm(tokens())
    expect(await crm.findContactByEmail('Ana@Example.com')).toMatchObject({ id: '101', kind: 'lead', email: 'ana@example.com' })
    expect(calls[0].json).toMatchObject({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: 'ana@example.com' }] }], limit: 1 })
    expect((await crm.upsertContact({ email: 'ana@example.com', phone: '555' })).created).toBe(false)
    expect(calls[2]).toMatchObject({ method: 'PATCH', json: { properties: { phone: '555' } } })
    expect(path(calls[2])).toBe('https://api.hubapi.com/crm/v3/objects/contacts/101')
    calls.length = 0
    fake(c => c.url.pathname.endsWith('/search') ? json(200, { results: [] }) : json(201, contact('202', { email: 'new@example.com' })))
    expect(await crm.upsertContact({ email: 'new@example.com', firstName: 'Neil', source: 'Zillow' })).toMatchObject({ created: true, contact: { id: '202' } })
    expect(calls[1]).toMatchObject({ method: 'POST', json: { properties: { firstname: 'Neil', email: 'new@example.com', lifecyclestage: 'lead', hs_lead_status: 'NEW' } } })
  })

  it('tasks, notes and deal stage reuse the Office client; a 401 refreshes once and repeats', async () => {
    const t = tokens()
    fake((c, n) => n === 1 ? json(401, { category: 'EXPIRED_AUTHENTICATION' }) : json(201, { id: '9001', properties: { dealstage: 'closedwon' } }))
    const crm = hubspotCrm(t)
    expect(await crm.createTask({ contact: { id: '101', kind: 'lead' }, subject: 'Call', dueAt: new Date('2026-11-10T00:00:00Z') })).toEqual({ id: '9001' })
    expect(t.refreshed).toEqual(['access-1'])
    expect(calls.map(c => c.headers.get('authorization'))).toEqual(['Bearer access-1', 'Bearer access-2'])
    await crm.addNote({ contact: { id: '101', kind: 'lead' }, body: 'note' })
    expect(path(calls[2])).toBe('https://api.hubapi.com/crm/v3/objects/notes')
    expect(await crm.updateDealStage('77', 'closedwon')).toEqual({ id: '9001', stage: 'closedwon' })
  })

  it('changed contacts page by `after`; revoke deletes the refresh token at HubSpot', async () => {
    fake(c => c.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, { results: [contact('1')], paging: { next: { after: '1' } } }))
    const r = await hubspotCrm(tokens()).listChangedContacts({ since: new Date(1_700_000_000_000), page: '0' })
    expect(r.next).toBe('1')
    expect(calls[0].json).toMatchObject({ filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GT', value: '1700000000000' }] }], after: '0' })
    expect(await hubspotRevoke('rt/with?odd')).toBe(true)
    expect(calls[1]).toMatchObject({ method: 'DELETE' })
    expect(calls[1].url.pathname).toBe('/oauth/v1/refresh-tokens/rt%2Fwith%3Fodd')
  })
})
