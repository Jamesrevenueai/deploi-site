/**
 * Passwords never land in a form, note, log or table. Free text that carries a
 * "password: xyz" / "pwd=xyz" style segment has that segment replaced by "[removed]".
 * Structured input rejects credential-looking keys outright.
 */
const SECRET_SEGMENT = /\b(password|passwd|passphrase|passcode|pwd|pass|pin)\b\s*(?:is|[:=\-])\s*\S+/gi
const SECRET_KEY = /^(password|passwd|passphrase|pass|pwd|login|secret|token)$/i

export function stripSecrets(text: string | null | undefined): { text: string | null; removed: number } {
  if (!text) return { text: text ?? null, removed: 0 }
  let removed = 0
  const out = text.replace(SECRET_SEGMENT, (_m, word: string) => { removed++; return `${word}: [removed]` })
  return { text: out, removed }
}

export const isSecretKey = (k: string) => SECRET_KEY.test(k.trim())

/** Strip secret segments from several fields at once; returns the cleaned fields and the total removed. */
export function stripSecretsFrom<T extends Record<string, string | null | undefined>>(fields: T): { fields: { [K in keyof T]: string | null }; removed: number } {
  let removed = 0
  const out = {} as { [K in keyof T]: string | null }
  for (const k of Object.keys(fields) as (keyof T)[]) {
    const r = stripSecrets(fields[k])
    out[k] = r.text
    removed += r.removed
  }
  return { fields: out, removed }
}
