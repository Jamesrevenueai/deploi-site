import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../../lib/env'

const keep = { a: process.env.DATABASE_URL, b: process.env.DATABASE_URL_POOLED }
afterEach(() => {
  for (const [k, v] of [['DATABASE_URL', keep.a], ['DATABASE_URL_POOLED', keep.b]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

describe('database url', () => {
  it('prefers DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://primary'; process.env.DATABASE_URL_POOLED = 'postgres://pooled'
    expect(env.databaseUrl).toBe('postgres://primary')
  })
  it('falls back to the Preview-wide pooler string', () => {
    delete process.env.DATABASE_URL; process.env.DATABASE_URL_POOLED = 'postgres://pooled'
    expect(env.databaseUrl).toBe('postgres://pooled')
  })
  it('is empty when neither is set', () => {
    delete process.env.DATABASE_URL; delete process.env.DATABASE_URL_POOLED
    expect(env.databaseUrl).toBe('')
  })
})
