/**
 * A server in Supabase sign-in mode without the Supabase web keys (the dev-store preview on dev.getdeploi.com, reached
 * through Shopify's session tokens; 2026-11-08 live finding: /login answered 500) has no web session: getSession is null
 * and never throws, and the dev sign-in stays off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }) }))

const KEYS = ['AUTH_MODE', 'ALLOW_DEV_LOGIN', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
let saved: Record<string, string | undefined>

describe('no Supabase web keys', () => {
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])) })
  afterEach(() => { for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] })

  it('getSession is null, without calling Supabase', async () => {
    process.env.AUTH_MODE = 'supabase'
    process.env.ALLOW_DEV_LOGIN = 'false'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://bhddgjcefwasdyrrfptc.supabase.co'
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const { env } = await import('../../lib/env')
    expect(env.authMode).toBe('supabase')
    expect(env.hasSupabase).toBe(false)
    const { getSession } = await import('../../lib/auth')
    await expect(getSession()).resolves.toBeNull()
  })
})
