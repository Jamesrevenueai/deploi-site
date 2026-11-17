/** The legal drafts: present, labelled DRAFT, versioned, hashed; nothing in the code base publishes them. */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { LEGAL_MANIFEST, DRAFT_BANNER, loadLegalDocuments, parseLegalDocument, sha256, normalize } from '../../lib/legal/documents'
import { requiredAgreements, legalGateMode } from '../../lib/legal'

const ROOT = join(__dirname, '..', '..')
const LEGAL = join(ROOT, 'docs', 'legal')

describe('legal documents', () => {
  it('every manifest document exists, carries the DRAFT banner, a version and an effective-date placeholder', () => {
    const docs = loadLegalDocuments({ fresh: true })
    expect(docs.map(d => d.key).sort()).toEqual(['ai_agent_terms', 'aup', 'cookies', 'dpa', 'pilot', 'privacy', 'security', 'subprocessors', 'terms'])
    for (const d of docs) {
      expect(d.draft, d.file).toBe(true)
      expect(d.content.split('\n').slice(0, 4).join('\n'), d.file).toContain(DRAFT_BANNER)
      expect(d.version, d.file).toMatch(/draft/)
      expect(d.effectiveDate, d.file).toMatch(/\[EFFECTIVE DATE/)
      expect(d.sha256).toBe(sha256(normalize(readFileSync(join(LEGAL, d.file), 'utf8'))))
      expect(d.content.length, `${d.file} should be a substantive draft`).toBeGreaterThan(2500)
    }
  })

  it('the review checklist exists and every document key it names is in the manifest', () => {
    const text = readFileSync(join(LEGAL, 'REVIEW-CHECKLIST.md'), 'utf8')
    for (const e of LEGAL_MANIFEST) expect(text, e.key).toContain(`\`${e.key}\``)
    expect(text).toMatch(/update legal_documents set status = 'published'/)
  })

  it('the DPA and the subprocessor list name the actual stack', () => {
    const subs = readFileSync(join(LEGAL, 'SUBPROCESSORS.md'), 'utf8')
    for (const p of ['Vercel', 'Supabase', 'Resend', 'Stripe', 'Shopify', 'WooCommerce', 'HubSpot', 'Google']) expect(subs, p).toContain(p)
    const ai = readFileSync(join(LEGAL, 'AI-AGENT-AUTHORIZATION-TERMS.md'), 'utf8')
    for (const p of ['CAN-SPAM', 'consent', 'Revoke', 'Audit trail', 'No guarantee of outcomes', 'Drafts only']) expect(ai, p).toContain(p)
  })

  it('a missing header field fails loudly; the fingerprint changes with any edit', () => {
    expect(() => parseLegalDocument(LEGAL_MANIFEST[0], '# Title\nno table')).toThrow(/missing/)
    const doc = `# T\n\n> **${DRAFT_BANNER}**\n\n| Field | Value |\n|---|---|\n| Version | 1 |\n| Effective date | x |\n`
    const a = parseLegalDocument(LEGAL_MANIFEST[0], doc), b = parseLegalDocument(LEGAL_MANIFEST[0], doc + ' ')
    expect(a.sha256).not.toBe(b.sha256)
    expect(parseLegalDocument(LEGAL_MANIFEST[0], doc.replace(/\n/g, '\r\n')).sha256).toBe(a.sha256)
  })

  it('commerce and office need terms, privacy, DPA, AUP and AI agent terms; the pilot agreement only for paid pilots', () => {
    expect(requiredAgreements('commerce').map(d => d.key)).toEqual(['terms', 'privacy', 'dpa', 'aup', 'ai_agent_terms'])
    expect(requiredAgreements('office').map(d => d.key)).toEqual(['terms', 'privacy', 'dpa', 'aup', 'ai_agent_terms'])
    process.env.LEGAL_REQUIRE_PILOT = 'true'
    try { expect(requiredAgreements('commerce').map(d => d.key)).toContain('pilot') } finally { delete process.env.LEGAL_REQUIRE_PILOT }
  })

  it('LEGAL_GATE defaults to off and accepts only off, draft or enforce', () => {
    expect(legalGateMode({})).toBe('off')
    expect(legalGateMode({ LEGAL_GATE: 'draft' })).toBe('draft')
    expect(legalGateMode({ LEGAL_GATE: 'ENFORCE' })).toBe('enforce')
    expect(legalGateMode({ LEGAL_GATE: 'yes' })).toBe('off')
  })

  it('no application code or script ever marks a legal document published', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (['node_modules', '.next', 'tests', 'docs', 'proof', 'e2e'].includes(n)) continue
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs|js|sql)$/.test(n)) {
          const t = readFileSync(p, 'utf8')
          if (/legal_documents/.test(t) && /(update\s+legal_documents|insert\s+into\s+legal_documents)[^;]*'published'/i.test(t)) offenders.push(relative(ROOT, p))
        }
      }
    }
    walk(ROOT)
    expect(offenders).toEqual([])
  })
})
