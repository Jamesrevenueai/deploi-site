import { describe, it, expect, afterEach } from 'vitest'
import { POST } from '../../app/api/admin/devstore/route'

const req = (headers: Record<string, string> = {}, body: unknown = { action: 'env' }) =>
  new Request('http://localhost/api/admin/devstore', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const saved = { ...process.env }
afterEach(() => { for (const k of ['DEVSTORE_ADMIN_TOKEN', 'VERCEL_ENV', 'DEPLOI_ENV']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('dev-store harness is unreachable without its token and never in production', () => {
  it('answers 404 without a configured token, with a short token, with the wrong token, and in production even with the right token', async () => {
    delete process.env.DEVSTORE_ADMIN_TOKEN; delete process.env.VERCEL_ENV; delete process.env.DEPLOI_ENV
    expect((await POST(req({ 'x-devstore-token': 'anything' }))).status).toBe(404)
    process.env.DEVSTORE_ADMIN_TOKEN = 'short'
    expect((await POST(req({ 'x-devstore-token': 'short' }))).status).toBe(404)
    process.env.DEVSTORE_ADMIN_TOKEN = 'a'.repeat(64)
    expect((await POST(req({ 'x-devstore-token': 'b'.repeat(64) }))).status).toBe(404)
    expect((await POST(req())).status).toBe(404)
    process.env.VERCEL_ENV = 'production'
    expect((await POST(req({ 'x-devstore-token': 'a'.repeat(64) }))).status).toBe(404)
  })
  it('answers the read-only env action with the right token outside production, without leaking the database credentials', async () => {
    delete process.env.VERCEL_ENV; delete process.env.DEPLOI_ENV
    process.env.DEVSTORE_ADMIN_TOKEN = 'a'.repeat(64)
    const res = await POST(req({ 'x-devstore-token': 'a'.repeat(64) }))
    expect(res.status).toBe(200)
    const j = await res.json() as { ok: boolean; database: string }
    expect(j.ok).toBe(true)
    expect(j.database).not.toMatch(/postgres(ql)?:\/\/[^/]*:[^@]+@/)
  })
})
