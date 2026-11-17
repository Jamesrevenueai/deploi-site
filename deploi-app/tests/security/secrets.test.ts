/**
 * Secret scan of every file tracked by git (app, site, docs, scripts): no API key, signing secret,
 * private key or token may be committed. Only .env.example files may hold variable assignments, and only
 * with empty or obviously local placeholder values.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean)

const PATTERNS: [string, RegExp][] = [
  ['Stripe secret/restricted key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9+/]{24,}/],
  ['Shopify access token / secret', /\bshp(at|ss|ca|pa)_[a-fA-F0-9]{32}\b/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['JWT (e.g. a Supabase service role key)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['HubSpot private app token', /\bpat-(na1|eu1)-[0-9a-f]{8}-[0-9a-f]{4}-/],
]
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|sh|py|toml|yml|yaml|html|css|txt|example|env)$/i
const SKIP = /(^|\/)(package-lock\.json|node_modules\/)/

describe('repository secret scan', () => {
  it('no tracked file contains a credential', () => {
    const hits: string[] = []
    for (const f of tracked) {
      if (SKIP.test(f) || !TEXT.test(f)) continue
      const p = join(REPO, f)
      let st; try { st = statSync(p) } catch { continue }
      if (st.size > 2_000_000) continue
      const text = readFileSync(p, 'utf8')
      for (const [name, re] of PATTERNS) { const m = re.exec(text); if (m) hits.push(`${f}: ${name} (${m[0].slice(0, 12)}…)`) }
    }
    expect(hits).toEqual([])
  })

  it('no real env file is tracked; .env.example files hold only empty or local placeholder values', () => {
    expect(tracked.filter(f => /(^|\/)\.env(\.|$)/.test(f) && !/\.env\.example$/.test(f))).toEqual([])
    const SECRETISH = /(SECRET|KEY|TOKEN|PASSWORD)$/
    const ALLOWED = new Set(['change-me-to-a-long-random-string'])
    for (const f of tracked.filter(f => /\.env\.example$/.test(f))) {
      for (const line of readFileSync(join(REPO, f), 'utf8').split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
        if (!m || !SECRETISH.test(m[1]) || !m[2].trim()) continue
        expect(ALLOWED.has(m[2].trim()), `${f}: ${m[1]} has a value`).toBe(true)
      }
    }
  })
})
