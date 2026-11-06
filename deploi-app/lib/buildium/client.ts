/**
 * Buildium Open API (property management). Authorization is an API key pair the customer creates in Buildium
 * (Settings > Application settings > API settings): every request carries the headers x-buildium-client-id and
 * x-buildium-client-secret. Keys do not expire and cannot be refreshed: a 401 means the key was revoked or
 * deactivated, and the connection needs a new key. Production https://api.buildium.com/v1, sandbox
 * https://apisandbox.buildium.com/v1 (BUILDIUM_ENVIRONMENT=sandbox).
 *
 * Reads: rental properties, units, leases, lease tenants, applicants and their rental applications, work orders and
 * resident (maintenance) requests. Writes: create and update work orders (including their status), create resident
 * requests, update an application's status. Lists page with offset/limit (at most 1000); `lastupdatedfrom` limits a
 * list to records changed since a time, which is what change polling uses. Buildium rate-limits per account (HTTP 429):
 * the shared office HTTP layer backs off with Retry-After.
 * Sources: developer.buildium.com (Open API reference). Endpoint names and status values are from the public reference
 * and must be confirmed against a Buildium sandbox account before launch. Not live-verified.
 */
import { officeConfig } from '../office/config'
import { OfficeHttpError, officeRequest } from '../office/http'

export const BUILDIUM_API = 'https://api.buildium.com/v1'
export const BUILDIUM_SANDBOX_API = 'https://apisandbox.buildium.com/v1'
export const buildiumBase = (sandbox = officeConfig.buildiumSandbox) => (sandbox ? BUILDIUM_SANDBOX_API : BUILDIUM_API)
export const BUILDIUM_PAGE_MAX = 1000

export type BuildiumKey = { clientId: string; clientSecret: string }
/** the stored credential (encrypted at rest as one secret) */
export const encodeBuildiumKey = (k: BuildiumKey) => JSON.stringify({ c: k.clientId, s: k.clientSecret })
export function decodeBuildiumKey(v: string): BuildiumKey {
  try { const j = JSON.parse(v) as { c?: string; s?: string }; if (j.c && j.s) return { clientId: j.c, clientSecret: j.s } } catch { /* fall through */ }
  throw new OfficeHttpError(401, 'auth', 'the stored Buildium key is unreadable; connect it again', 'buildium')
}
export const validBuildiumKey = (k: Partial<BuildiumKey>): k is BuildiumKey =>
  typeof k.clientId === 'string' && /^[\w-]{8,100}$/.test(k.clientId.trim()) && typeof k.clientSecret === 'string' && /^\S{8,200}$/.test(k.clientSecret.trim())

export const WORK_ORDER_STATUSES = ['New', 'InProgress', 'Completed', 'Deferred', 'Closed'] as const
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number]
export const APPLICATION_STATUSES = ['New', 'InProgress', 'Approved', 'Rejected', 'Deferred', 'Cancelled'] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

const str = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bId = (id: string | number) => { const s = String(id); if (!/^\d{1,12}$/.test(s)) throw new OfficeHttpError(400, 'invalid', 'not a Buildium id', 'buildium'); return s }
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

type Raw = Record<string, unknown>
export type BuildiumProperty = { id: string; name: string | null; type: string | null; active: boolean; city: string | null; updatedAt: string | null }
export type BuildiumUnit = { id: string; propertyId: string | null; unitNumber: string | null; bedrooms: string | null; marketRent: number | null }
export type BuildiumLease = { id: string; propertyId: string | null; unitId: string | null; status: string | null; fromDate: string | null; toDate: string | null; rent: number | null; tenantIds: string[]; updatedAt: string | null }
export type BuildiumTenant = { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
export type BuildiumApplication = { id: string; applicantId: string; status: string | null; submittedAt: string | null; updatedAt: string | null }
export type BuildiumWorkOrder = { id: string; taskId: string | null; title: string | null; status: string | null; priority: string | null; vendorId: string | null; dueDate: string | null; updatedAt: string | null }

const toProperty = (r: Raw): BuildiumProperty => ({ id: String(r.Id ?? ''), name: str(r.Name), type: str(r.RentalType ?? r.Type, 40), active: r.IsActive !== false,
  city: str((r.Address as Raw | undefined)?.City, 80), updatedAt: str(r.LastUpdatedDateTime, 40) })
const toUnit = (r: Raw): BuildiumUnit => ({ id: String(r.Id ?? ''), propertyId: r.PropertyId !== undefined ? String(r.PropertyId) : null, unitNumber: str(r.UnitNumber, 40), bedrooms: str(r.UnitBedrooms, 40), marketRent: num(r.MarketRent) })
const toLease = (r: Raw): BuildiumLease => ({ id: String(r.Id ?? ''), propertyId: r.PropertyId !== undefined ? String(r.PropertyId) : null, unitId: r.UnitId !== undefined ? String(r.UnitId) : null,
  status: str(r.LeaseStatus, 40), fromDate: str(r.LeaseFromDate, 10), toDate: str(r.LeaseToDate, 10), rent: num((r.AccountDetails as Raw | undefined)?.Rent),
  tenantIds: ((r.Tenants as Raw[] | undefined) ?? []).map(t => String(t.Id ?? '')).filter(Boolean), updatedAt: str(r.LastUpdatedDateTime, 40) })
const toTenant = (r: Raw): BuildiumTenant => ({ id: String(r.Id ?? ''), firstName: str(r.FirstName, 80), lastName: str(r.LastName, 80), email: str(r.Email, 254)?.toLowerCase() ?? null,
  phone: str(((r.PhoneNumbers as Raw[] | undefined) ?? [])[0]?.Number, 40) })
const toApplication = (r: Raw, applicantId: string): BuildiumApplication => ({ id: String(r.Id ?? ''), applicantId, status: str(r.ApplicationStatus, 40), submittedAt: str(r.SubmittedDateTime, 40), updatedAt: str(r.LastUpdatedDateTime, 40) })
const toWorkOrder = (r: Raw): BuildiumWorkOrder => ({ id: String(r.Id ?? ''), taskId: (r.Task as Raw | undefined)?.Id !== undefined ? String((r.Task as Raw).Id) : r.TaskId !== undefined ? String(r.TaskId) : null,
  title: str(r.Title ?? (r.Task as Raw | undefined)?.Title), status: str(r.WorkOrderStatus, 40), priority: str(r.Priority, 20), vendorId: r.VendorId !== undefined ? String(r.VendorId) : null,
  dueDate: str(r.WorkOrderDueDate ?? r.DueDate, 10), updatedAt: str(r.LastUpdatedDateTime, 40) })

export type Page = { offset?: number; limit?: number; updatedSince?: Date }

export interface BuildiumApi {
  account(): Promise<{ id: string; name: string | null }>
  listProperties(p?: Page): Promise<BuildiumProperty[]>
  listUnits(p?: Page & { propertyId?: string }): Promise<BuildiumUnit[]>
  listLeases(p?: Page & { status?: 'Active' | 'Past' | 'Future' }): Promise<BuildiumLease[]>
  getLease(id: string): Promise<BuildiumLease | null>
  listTenants(p?: Page): Promise<BuildiumTenant[]>
  listApplicants(p?: Page): Promise<{ id: string; name: string | null; updatedAt: string | null }[]>
  listApplications(applicantId: string): Promise<BuildiumApplication[]>
  updateApplicationStatus(applicantId: string, applicationId: string, status: ApplicationStatus): Promise<BuildiumApplication>
  listWorkOrders(p?: Page & { status?: WorkOrderStatus }): Promise<BuildiumWorkOrder[]>
  getWorkOrder(id: string): Promise<BuildiumWorkOrder | null>
  createWorkOrder(w: { taskId: string; vendorId: string; workDetails: string; dueDate?: string | null; status?: WorkOrderStatus }): Promise<BuildiumWorkOrder>
  updateWorkOrderStatus(id: string, status: WorkOrderStatus): Promise<BuildiumWorkOrder>
  createResidentRequest(r: { title: string; description: string; propertyId: string; unitId?: string | null; requestedByTenantId?: string | null; priority?: 'Low' | 'Normal' | 'High' }): Promise<{ id: string }>
  listResidentRequests(p?: Page): Promise<{ id: string; title: string | null; status: string | null; updatedAt: string | null }[]>
}

/** `key` is read once per request (it comes from the encrypted credential); `base` is fixed when the connection is made. */
export function buildiumClient(key: () => Promise<BuildiumKey>, base: string = buildiumBase()): BuildiumApi {
  if (base !== BUILDIUM_API && base !== BUILDIUM_SANDBOX_API) throw new OfficeHttpError(400, 'invalid', 'not a Buildium API address', 'buildium')
  const call = async <T>(path: string, init: RequestInit & { json?: unknown; retryServer?: boolean } = {}): Promise<T> => {
    const k = await key()
    return (await officeRequest<T>('buildium', `${base}${path}`, { ...init, headers: { 'x-buildium-client-id': k.clientId, 'x-buildium-client-secret': k.clientSecret } })).body
  }
  const list = (path: string, p: Page = {}, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ offset: String(Math.max(0, Math.floor(p.offset ?? 0))), limit: String(Math.min(Math.max(1, Math.floor(p.limit ?? 100)), BUILDIUM_PAGE_MAX)), ...extra })
    if (p.updatedSince) q.set('lastupdatedfrom', iso(p.updatedSince))
    return call<Raw[]>(`${path}?${q}`, { retryServer: true }).then(r => (Array.isArray(r) ? r : []))
  }
  const maybe = async <T>(path: string): Promise<T | null> => { try { return await call<T>(path, { retryServer: true }) } catch (e) { if (e instanceof OfficeHttpError && e.code === 'not_found') return null; throw e } }
  const self: BuildiumApi = {
    async account() {
      const r = await call<Raw>('/administration/account', { retryServer: true })
      if (r.Id === undefined && r.AccountId === undefined) throw new OfficeHttpError(200, 'server', 'Buildium did not return the account', 'buildium')
      return { id: String(r.AccountId ?? r.Id), name: str(r.CompanyName ?? r.Name, 120) }
    },
    listProperties: async p => (await list('/rentals', p)).map(toProperty),
    listUnits: async (p = {}) => (await list('/rentals/units', p, p.propertyId ? { propertyids: bId(p.propertyId) } : {})).map(toUnit),
    listLeases: async (p = {}) => (await list('/leases', p, p.status ? { leasestatuses: p.status } : {})).map(toLease),
    async getLease(id) { const r = await maybe<Raw>(`/leases/${bId(id)}`); return r ? toLease(r) : null },
    listTenants: async p => (await list('/leases/tenants', p)).map(toTenant),
    listApplicants: async p => (await list('/applicants', p)).map(r => ({ id: String(r.Id ?? ''), name: str([r.FirstName, r.LastName].filter(Boolean).join(' '), 160), updatedAt: str(r.LastUpdatedDateTime, 40) })),
    async listApplications(applicantId) { return (await list(`/applicants/${bId(applicantId)}/applications`)).map(r => toApplication(r, applicantId)) },
    async updateApplicationStatus(applicantId, applicationId, status) {
      if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) throw new OfficeHttpError(400, 'invalid', 'not a Buildium application status', 'buildium')
      return toApplication(await call<Raw>(`/applicants/${bId(applicantId)}/applications/${bId(applicationId)}`, { method: 'PUT', json: { ApplicationStatus: status } }), applicantId)
    },
    listWorkOrders: async (p = {}) => (await list('/workorders', p, p.status ? { statuses: p.status } : {})).map(toWorkOrder),
    async getWorkOrder(id) { const r = await maybe<Raw>(`/workorders/${bId(id)}`); return r ? toWorkOrder(r) : null },
    async createWorkOrder(w) {
      const r = await call<Raw>('/workorders', { method: 'POST', json: { TaskId: Number(bId(w.taskId)), VendorId: Number(bId(w.vendorId)), WorkDetails: w.workDetails.slice(0, 5000),
        ...(w.dueDate ? { WorkOrderDueDate: w.dueDate } : {}), WorkOrderStatus: w.status ?? 'New' } })
      if (r.Id === undefined) throw new OfficeHttpError(200, 'server', 'Buildium did not return the new work order', 'buildium')
      return toWorkOrder(r)
    },
    async updateWorkOrderStatus(id, status) {
      if (!(WORK_ORDER_STATUSES as readonly string[]).includes(status)) throw new OfficeHttpError(400, 'invalid', 'not a Buildium work order status', 'buildium')
      // Buildium's update is a full PUT: read the work order, change only its status, write it back
      const cur = await call<Raw>(`/workorders/${bId(id)}`, { retryServer: true })
      const body = { TaskId: (cur.Task as Raw | undefined)?.Id ?? cur.TaskId, VendorId: cur.VendorId, WorkDetails: cur.WorkDetails ?? '', WorkOrderDueDate: cur.WorkOrderDueDate ?? null,
        InvoiceNumber: cur.InvoiceNumber ?? null, ChargedTo: cur.ChargedTo ?? null, EntryAllowed: cur.EntryAllowed ?? null, EntryNotes: cur.EntryNotes ?? null, VendorNotes: cur.VendorNotes ?? null, WorkOrderStatus: status }
      return toWorkOrder(await call<Raw>(`/workorders/${bId(id)}`, { method: 'PUT', json: body }))
    },
    async createResidentRequest(r) {
      const out = await call<Raw>('/tasks/residentrequests', { method: 'POST', json: { Title: r.title.slice(0, 255), Description: r.description.slice(0, 5000), PropertyId: Number(bId(r.propertyId)),
        ...(r.unitId ? { UnitId: Number(bId(r.unitId)) } : {}), ...(r.requestedByTenantId ? { RequestedByEntityId: Number(bId(r.requestedByTenantId)), RequestedByEntityType: 'Tenant' } : {}), Priority: r.priority ?? 'Normal', TaskStatus: 'New' } })
      if (out.Id === undefined) throw new OfficeHttpError(200, 'server', 'Buildium did not return the new request', 'buildium')
      return { id: String(out.Id) }
    },
    listResidentRequests: async p => (await list('/tasks/residentrequests', p)).map(r => ({ id: String(r.Id ?? ''), title: str(r.Title), status: str(r.TaskStatus, 40), updatedAt: str(r.LastUpdatedDateTime, 40) })),
  }
  return self
}
