import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../../lib/env'

const KEYS = ['ALLOW_DEV_LOGIN', 'AUTH_MODE', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VERCEL_ENV'] as const
let saved: Record<string, string | undefined> = {}

function set(v: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, v)
}
const SB = { NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' }

describe('auth mode', () => {
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])) })
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('uses Supabase when it is configured and dev login is off', () => {
    set({ ...SB })
    expect(env.authMode).toBe('supabase')
    expect(env.authReady).toBe(true)
  })
  it('falls back to the dev picker only when allowed and Supabase is missing', () => {
    set({ ALLOW_DEV_LOGIN: 'true' })
    expect(env.authMode).toBe('dev')
    expect(env.authReady).toBe(true)
  })
  it('honours AUTH_MODE=dev outside production when dev login is allowed', () => {
    set({ ...SB, ALLOW_DEV_LOGIN: 'true', AUTH_MODE: 'dev', VERCEL_ENV: 'preview' })
    expect(env.authMode).toBe('dev')
  })
  it('never offers the dev picker on Vercel production', () => {
    set({ ...SB, ALLOW_DEV_LOGIN: 'true', AUTH_MODE: 'dev', VERCEL_ENV: 'production' })
    expect(env.allowDevLogin).toBe(false)
    expect(env.authMode).toBe('supabase')
    expect(env.authReady).toBe(true)
  })
  it('closes sign-in (not open) on production with no Supabase config', () => {
    set({ ALLOW_DEV_LOGIN: 'true', VERCEL_ENV: 'production' })
    expect(env.authMode).toBe('supabase')
    expect(env.authReady).toBe(false)
  })
  it('closes sign-in when dev login is off and Supabase is missing', () => {
    set({})
    expect(env.authMode).toBe('supabase')
    expect(env.authReady).toBe(false)
  })
})
