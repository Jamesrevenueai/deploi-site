/**
 * The legal documents, read from docs/legal/*.md (the Markdown files are the only source of the text).
 * Each document's identity is (key, version, sha256 of the exact text): a change to the text is a new
 * identity even when the version label was not bumped, so nobody is ever held to text they did not see.
 *
 * Every file carries the banner "DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH" until counsel has
 * reviewed it. Nothing in the app marks a document published (see lib/legal/index.ts and the review
 * checklist in docs/legal/REVIEW-CHECKLIST.md).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Product } from '../products'

export type LegalKey = 'terms' | 'privacy' | 'dpa' | 'aup' | 'ai_agent_terms' | 'pilot' | 'cookies' | 'subprocessors' | 'security'

export type LegalManifestEntry = {
  key: LegalKey
  file: string
  /** products whose customers must accept it (empty: informational, never clickwrapped) */
  requiredFor: Product[]
  /** org: one authorized user accepts for the organization; user: every person accepts for themselves */
  scope: 'org' | 'user'
  /** required only when LEGAL_REQUIRE_PILOT=true (paid pilots) */
  pilotOnly?: boolean
}

export const LEGAL_MANIFEST: LegalManifestEntry[] = [
  { key: 'terms', file: 'TERMS-OF-SERVICE.md', requiredFor: ['commerce', 'office'], scope: 'org' },
  { key: 'privacy', file: 'PRIVACY-POLICY.md', requiredFor: ['commerce', 'office'], scope: 'user' },
  { key: 'dpa', file: 'DATA-PROCESSING-ADDENDUM.md', requiredFor: ['commerce', 'office'], scope: 'org' },
  { key: 'aup', file: 'ACCEPTABLE-USE-POLICY.md', requiredFor: ['commerce', 'office'], scope: 'user' },
  { key: 'ai_agent_terms', file: 'AI-AGENT-AUTHORIZATION-TERMS.md', requiredFor: ['commerce', 'office'], scope: 'org' },
  { key: 'pilot', file: 'PILOT-BETA-AGREEMENT.md', requiredFor: ['commerce', 'office'], scope: 'org', pilotOnly: true },
  { key: 'cookies', file: 'COOKIE-NOTICE.md', requiredFor: [], scope: 'user' },
  { key: 'subprocessors', file: 'SUBPROCESSORS.md', requiredFor: [], scope: 'org' },
  { key: 'security', file: 'SECURITY-OVERVIEW.md', requiredFor: [], scope: 'org' },
]

export const DRAFT_BANNER = 'DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH'

export type LegalDocument = {
  key: LegalKey
  file: string
  title: string
  version: string
  effectiveDate: string
  sha256: string
  /** true while the file carries the draft banner */
  draft: boolean
  scope: 'org' | 'user'
  requiredFor: Product[]
  pilotOnly: boolean
  content: string
}

/** docs/legal next to the app (the build traces it in; see next.config.ts outputFileTracingIncludes). */
export function legalDir(): string {
  const fromEnv = (process.env.LEGAL_DOCS_DIR ?? '').trim()
  return fromEnv || join(process.cwd(), 'docs', 'legal')
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
/** Hash input: the file with line endings normalized, so a checkout on Windows hashes the same. */
export const normalize = (s: string) => s.replace(/\r\n?/g, '\n')

/** Parse one document. Throws when a required header field is missing, so a malformed edit fails fast. */
export function parseLegalDocument(entry: LegalManifestEntry, raw: string): LegalDocument {
  const content = normalize(raw)
  const title = /^# (.+)$/m.exec(content)?.[1]?.trim()
  const version = /^\|\s*Version\s*\|\s*(.+?)\s*\|\s*$/m.exec(content)?.[1]?.replace(/`/g, '').trim()
  const effectiveDate = /^\|\s*Effective date\s*\|\s*(.+?)\s*\|\s*$/m.exec(content)?.[1]?.trim()
  if (!title || !version || !effectiveDate) throw new Error(`docs/legal/${entry.file}: missing title, Version or Effective date row`)
  return {
    key: entry.key, file: entry.file, title, version, effectiveDate, sha256: sha256(content),
    draft: content.includes(DRAFT_BANNER), scope: entry.scope, requiredFor: entry.requiredFor, pilotOnly: Boolean(entry.pilotOnly), content,
  }
}

let cache: { dir: string; docs: LegalDocument[] } | null = null

/** All documents in the manifest. Cached per process; `fresh` re-reads the files (tests, after an edit). */
export function loadLegalDocuments(opts: { fresh?: boolean } = {}): LegalDocument[] {
  const dir = legalDir()
  if (!opts.fresh && cache?.dir === dir) return cache.docs
  const docs = LEGAL_MANIFEST.map(entry => {
    const p = join(dir, entry.file)
    if (!existsSync(p)) throw new Error(`legal document missing: ${p}`)
    return parseLegalDocument(entry, readFileSync(p, 'utf8'))
  })
  cache = { dir, docs }
  return docs
}

export function legalDocument(key: string): LegalDocument | null {
  return loadLegalDocuments().find(d => d.key === key) ?? null
}
