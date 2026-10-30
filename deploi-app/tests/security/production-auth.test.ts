/**
 * Production AUTH_MODE guard (lib/auth-guard.ts). On 2026-10-28 production ran with AUTH_MODE=dev and
 * ALLOW_DEV_LOGIN=true, which put a password-free "pick a user" sign-in on the public app. These tests
 * pin every layer that now refuses that configuration.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertProductionAuth, isProductionDeployment, resolveAuthMode, ProductionAuthError } from '../../lib/auth-guard'

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }), headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`) } }))

const PROD_DEV = { VERCEL_ENV: 'production', AUTH_MODE: 'dev', ALLOW_DEV_LOGIN: 'true', NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k' }

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('production auth guard', () => {
  it('recognises production from VERCEL_ENV or DEPLOI_ENV, not from NODE_ENV', () => {
    expect(isProductionDeployment({ VERCEL_ENV: 'production' })).toBe(true)
    expect(isProductionDeployment({ DEPLOI_ENV: 'production' })).toBe(true)
    expect(isProductionDeployment({ VERCEL_ENV: 'preview' })).toBe(false)
    expect(isProductionDeployment({ NODE_ENV: 'production' })).toBe(false)
  })

  it('refuses to build or start in production with AUTH_MODE=dev, ALLOW_DEV_LOGIN=true, or both', () => {
    expect(() => assertProductionAuth(PROD_DEV)).toThrow(ProductionAuthError)
    expect(() => assertProductionAuth(PROD_DEV)).toThrow(/AUTH_MODE=dev and ALLOW_DEV_LOGIN=true/)
    expect(() => assertProductionAuth({ VERCEL_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE=dev/)
    expect(() => assertProductionAuth({ DEPLOI_ENV: 'production', ALLOW_DEV_LOGIN: 'true' })).toThrow(/ALLOW_DEV_LOGIN=true/)
  })

  it('allows production with Supabase auth, and dev auth outside production', () => {
    expect(() => assertProductionAuth({ VERCEL_ENV: 'production', AUTH_MODE: 'supabase' })).not.toThrow()
    expect(() => assertProductionAuth({ VERCEL_ENV: 'preview', AUTH_MODE: 'dev', ALLOW_DEV_LOGIN: 'true' })).not.toThrow()
    expect(() => assertProductionAuth({ AUTH_MODE: 'dev', ALLOW_DEV_LOGIN: 'true' })).not.toThrow()
  })

  it('never resolves to dev auth in production, even when the env asks for it', () => {
    expect(resolveAuthMode(PROD_DEV)).toBe('supabase')
    expect(resolveAuthMode({ VERCEL_ENV: 'production', ALLOW_DEV_LOGIN: 'true' })).toBe('supabase')
    expect(resolveAuthMode({ ...PROD_DEV, VERCEL_ENV: 'preview' })).toBe('dev')
    expect(resolveAuthMode({ AUTH_MODE: 'dev' })).toBe('supabase') // ALLOW_DEV_LOGIN still required
  })

  it('next.config.ts fails the production build when dev auth is configured', async () => {
    for (const [k, val] of Object.entries(PROD_DEV)) vi.stubEnv(k, val)
    await expect(import('../../next.config')).rejects.toThrow(/Refusing to run: AUTH_MODE=dev and ALLOW_DEV_LOGIN=true/)
  })

  it('instrumentation refuses to start the production server when dev auth is configured', async () => {
    for (const [k, val] of Object.entries(PROD_DEV)) vi.stubEnv(k, val)
    const { register } = await import('../../instrumentation')
    await expect(register()).rejects.toThrow(/Refusing to run: AUTH_MODE=dev and ALLOW_DEV_LOGIN=true/)
  })

  it('in production a validly signed dev cookie is not a session, and dev sign-in is refused', async () => {
    const { encodeDevSession, decodeDevSession } = await import('../../lib/auth')
    const cookie = encodeDevSession({ uid: '00000000-0000-0000-0000-000000000001', email: 'hello@getdeploi.com', role: 'staff', agencyId: null })
    expect(decodeDevSession(cookie)?.role).toBe('staff') // outside production the same cookie decodes
    for (const [k, val] of Object.entries(PROD_DEV)) vi.stubEnv(k, val)
    expect(decodeDevSession(cookie)).toBeNull()
    const { env } = await import('../../lib/env')
    expect(env.authMode).toBe('supabase')
    const { devSignIn } = await import('../../app/login/actions')
    const fd = new FormData(); fd.set('email', 'hello@getdeploi.com')
    await expect(devSignIn(fd)).rejects.toThrow('REDIRECT:/login?error=dev-auth-disabled')
  })
})
