import { describe, it, expect, afterEach } from 'vitest'
import { buildiumBase, buildiumClient, decodeBuildiumKey, encodeBuildiumKey, validBuildiumKey, BUILDIUM_API, BUILDIUM_SANDBOX_API } from '../../lib/buildium/client'
import { OfficeHttpError } from '../../lib/office/http'
import { calls, fake, json, path, resetFake, waits } from './fake-http'

const KEY = { clientId: 'client-id-12345', clientSecret: 'secret-abcdefgh' }
const client = (base = BUILDIUM_API) => buildiumClient(async () => KEY, base)

describe('Buildium (fake HTTP; no real call is made)', () => {
  afterEach(() => { resetFake(); delete process.env.BUILDIUM_ENVIRONMENT })

  it('every request carries the API key headers; production or sandbox host', async () => {
    fake(() => json(200, { AccountId: 5150, CompanyName: 'Harbor Property Co' }))
    expect(await client().account()).toEqual({ id: '5150', name: 'Harbor Property Co' })
    expect(path(calls[0])).toBe('https://api.buildium.com/v1/administration/account')
    expect(calls[0].headers.get('x-buildium-client-id')).toBe(KEY.clientId)
    expect(calls[0].headers.get('x-buildium-client-secret')).toBe(KEY.clientSecret)
    expect(calls[0].headers.get('authorization')).toBeNull()
    process.env.BUILDIUM_ENVIRONMENT = 'sandbox'
    expect(buildiumBase()).toBe(BUILDIUM_SANDBOX_API)
    await client(buildiumBase()).account()
    expect(calls[1].url.host).toBe('apisandbox.buildium.com')
    expect(() => buildiumClient(async () => KEY, 'https://api.buildium.com.evil.example/v1')).toThrow()
  })

  it('lists page with offset / limit (at most 1000) and filter by lastupdatedfrom', async () => {
    fake(c => c.url.pathname.endsWith('/rentals') ? json(200, [{ Id: 1, Name: 'Harbor Lofts', RentalType: 'Residential', IsActive: true, Address: { City: 'Portland' }, LastUpdatedDateTime: '2026-11-01T00:00:00Z' }])
      : c.url.pathname.endsWith('/rentals/units') ? json(200, [{ Id: 11, PropertyId: 1, UnitNumber: '4B', UnitBedrooms: 'TwoBed', MarketRent: 2100 }])
      : c.url.pathname.endsWith('/leases') ? json(200, [{ Id: 300, PropertyId: 1, UnitId: 11, LeaseStatus: 'Active', LeaseFromDate: '2026-01-01', LeaseToDate: '2026-12-31', AccountDetails: { Rent: 2100 }, Tenants: [{ Id: 900 }], LastUpdatedDateTime: '2026-11-03T00:00:00Z' }])
      : json(200, [{ Id: 900, FirstName: 'Ana', LastName: 'Ruiz', Email: 'ANA@example.com', PhoneNumbers: [{ Number: '555-0100', Type: 'Cell' }] }]))
    const b = client()
    expect(await b.listProperties({ limit: 5000, offset: 20 })).toEqual([{ id: '1', name: 'Harbor Lofts', type: 'Residential', active: true, city: 'Portland', updatedAt: '2026-11-01T00:00:00Z' }])
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ offset: '20', limit: '1000' })
    expect(await b.listUnits({ propertyId: '1' })).toEqual([{ id: '11', propertyId: '1', unitNumber: '4B', bedrooms: 'TwoBed', marketRent: 2100 }])
    expect(calls[1].url.searchParams.get('propertyids')).toBe('1')
    const leases = await b.listLeases({ updatedSince: new Date('2026-11-02T00:00:00.000Z'), status: 'Active' })
    expect(leases[0]).toEqual({ id: '300', propertyId: '1', unitId: '11', status: 'Active', fromDate: '2026-01-01', toDate: '2026-12-31', rent: 2100, tenantIds: ['900'], updatedAt: '2026-11-03T00:00:00Z' })
    expect(Object.fromEntries(calls[2].url.searchParams)).toMatchObject({ lastupdatedfrom: '2026-11-02T00:00:00Z', leasestatuses: 'Active' })
    expect((await b.listTenants())[0]).toEqual({ id: '900', firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com', phone: '555-0100' })
    expect(path(calls[3])).toBe('https://api.buildium.com/v1/leases/tenants')
  })

  it('applications: list per applicant and update the status (only known statuses)', async () => {
    fake(c => c.method === 'PUT' ? json(200, { Id: 70, ApplicationStatus: 'Approved', LastUpdatedDateTime: '2026-11-04T00:00:00Z' }) : json(200, [{ Id: 70, ApplicationStatus: 'New', SubmittedDateTime: '2026-11-01T00:00:00Z' }]))
    const b = client()
    expect(await b.listApplications('55')).toEqual([{ id: '70', applicantId: '55', status: 'New', submittedAt: '2026-11-01T00:00:00Z', updatedAt: null }])
    expect(path(calls[0])).toBe('https://api.buildium.com/v1/applicants/55/applications')
    expect(await b.updateApplicationStatus('55', '70', 'Approved')).toMatchObject({ status: 'Approved' })
    expect(calls[1]).toMatchObject({ method: 'PUT', json: { ApplicationStatus: 'Approved' } })
    await expect(b.updateApplicationStatus('55', '70', 'Hired' as never)).rejects.toThrow(/application status/)
    await expect(b.listApplications('../admin')).rejects.toThrow(/Buildium id/)
  })

  it('work orders: create, and a status update reads the work order and writes it back whole with the new status', async () => {
    const current = { Id: 812, Task: { Id: 4001, Title: 'Leaking sink' }, VendorId: 66, WorkDetails: 'Replace trap', WorkOrderDueDate: '2026-11-08', WorkOrderStatus: 'New', EntryAllowed: 'Yes', VendorNotes: 'call first' }
    fake(c => c.method === 'POST' ? json(201, { ...current, Id: 813 }) : c.method === 'PUT' ? json(200, { ...current, WorkOrderStatus: (c.json as { WorkOrderStatus: string }).WorkOrderStatus, LastUpdatedDateTime: '2026-11-05T00:00:00Z' }) : json(200, current))
    const b = client()
    expect(await b.createWorkOrder({ taskId: '4001', vendorId: '66', workDetails: 'Replace trap', dueDate: '2026-11-08' })).toMatchObject({ id: '813', taskId: '4001', title: 'Leaking sink', status: 'New' })
    expect(calls[0].json).toEqual({ TaskId: 4001, VendorId: 66, WorkDetails: 'Replace trap', WorkOrderDueDate: '2026-11-08', WorkOrderStatus: 'New' })
    const w = await b.updateWorkOrderStatus('812', 'Completed')
    expect(w).toMatchObject({ id: '812', status: 'Completed', updatedAt: '2026-11-05T00:00:00Z' })
    expect(calls[1]).toMatchObject({ method: 'GET' })
    expect(calls[2]).toMatchObject({ method: 'PUT', json: { TaskId: 4001, VendorId: 66, WorkDetails: 'Replace trap', WorkOrderDueDate: '2026-11-08', EntryAllowed: 'Yes', VendorNotes: 'call first', WorkOrderStatus: 'Completed' } })
    expect(path(calls[2])).toBe('https://api.buildium.com/v1/workorders/812')
    await expect(b.updateWorkOrderStatus('812', 'Done' as never)).rejects.toThrow(/work order status/)
  })

  it('resident (maintenance) requests are created on the property and unit', async () => {
    fake(() => json(201, { Id: 5001 }))
    expect(await client().createResidentRequest({ title: 'No heat', description: 'Unit 4B radiator cold', propertyId: '1', unitId: '11', requestedByTenantId: '900', priority: 'High' })).toEqual({ id: '5001' })
    expect(path(calls[0])).toBe('https://api.buildium.com/v1/tasks/residentrequests')
    expect(calls[0].json).toEqual({ Title: 'No heat', Description: 'Unit 4B radiator cold', PropertyId: 1, UnitId: 11, RequestedByEntityId: 900, RequestedByEntityType: 'Tenant', Priority: 'High', TaskStatus: 'New' })
  })

  it('a refused key is an auth error (no refresh exists); 429 backs off with Retry-After; a missing record is null', async () => {
    fake(() => json(401, { UserMessage: 'Unauthorized', errorCode: 'Unauthorized' }))
    await expect(client().listWorkOrders()).rejects.toMatchObject({ code: 'auth', status: 401, provider: 'buildium' })
    expect(calls).toHaveLength(1)
    calls.length = 0
    fake((_c, n) => n === 1 ? json(429, {}, { 'retry-after': '2' }) : json(200, []))
    expect(await client().listWorkOrders({ status: 'New' })).toEqual([])
    expect(waits).toEqual([2000])
    expect(calls[1].url.searchParams.get('statuses')).toBe('New')
    fake(() => json(404, { UserMessage: 'Not found' }))
    expect(await client().getWorkOrder('9')).toBeNull()
    const e = await client().listLeases().catch(x => x as OfficeHttpError)
    expect(e).toBeInstanceOf(OfficeHttpError)
  })

  it('the stored key round-trips; an unreadable or malformed key is refused', () => {
    expect(decodeBuildiumKey(encodeBuildiumKey(KEY))).toEqual(KEY)
    expect(() => decodeBuildiumKey('garbage')).toThrow(/unreadable/)
    expect(validBuildiumKey(KEY)).toBe(true)
    expect(validBuildiumKey({ clientId: 'short', clientSecret: 'x' })).toBe(false)
    expect(validBuildiumKey({ clientId: 'client id with spaces', clientSecret: 'secret-abcdefgh' })).toBe(false)
  })
})
