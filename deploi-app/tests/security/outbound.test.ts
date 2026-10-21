import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { assertApprovedHost, assertLocalLlmHost, isPrivateHost, OutboundBlocked } from '../../lib/net/outbound'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })
}

describe('outbound request boundary', () => {
  afterEach(() => { delete process.env.OLLAMA_ALLOWED_HOSTS })
  it('the PHI lane refuses public hosts, including the cloud LLM APIs, and accepts private ones', () => {
    expect(() => assertLocalLlmHost('https://api.openai.com')).toThrow(OutboundBlocked)
    expect(() => assertLocalLlmHost('https://api.anthropic.com/v1')).toThrow(OutboundBlocked)
    expect(() => assertLocalLlmHost('https://ollama.example.com')).toThrow(OutboundBlocked)
    expect(assertLocalLlmHost('http://localhost:11434')).toBe('localhost')
    expect(assertLocalLlmHost('http://10.0.0.5:11434')).toBe('10.0.0.5')
    expect(assertLocalLlmHost('http://172.20.1.1')).toBe('172.20.1.1')
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    process.env.OLLAMA_ALLOWED_HOSTS = 'ollama.internal.example'
    expect(assertLocalLlmHost('https://ollama.internal.example')).toBe('ollama.internal.example')
    process.env.OLLAMA_ALLOWED_HOSTS = 'api.openai.com' // an allowlist entry can never whitelist a cloud LLM API
    expect(() => assertLocalLlmHost('https://api.openai.com')).toThrow(OutboundBlocked)
  })
  it('each provider purpose only reaches its approved hosts', () => {
    expect(assertApprovedHost('https://api.resend.com/emails', 'email')).toBe('api.resend.com')
    expect(() => assertApprovedHost('https://api.resend.com', 'sms')).toThrow(OutboundBlocked)
    expect(() => assertApprovedHost('https://evil.example', 'email')).toThrow(OutboundBlocked)
    expect(assertApprovedHost('https://abc.supabase.co/storage', 'storage')).toBe('abc.supabase.co')
  })
  it('every outbound fetch in lib/ and workers/ is guarded by assertApprovedHost or assertLocalLlmHost', () => {
    const files = [...walk(join(process.cwd(), 'lib')), ...walk(join(process.cwd(), 'workers'))].filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f) && !f.includes('/net/'))
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const calls = src.match(/\bfetch\(/g)?.length ?? 0
      if (calls === 0) continue
      if (!/assert(ApprovedHost|LocalLlmHost)\(/.test(src)) offenders.push(f.replace(process.cwd() + '/', ''))
    }
    expect(offenders).toEqual([])
  })
})
