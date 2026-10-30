/**
 * Privacy-safe structured logger. Anything that could carry a person's details is
 * redacted by key name before it is written. Log ids, counts and outcomes, not people.
 */
const REDACT = /name|email|phone|dob|birth|ssn|address|notes?|body|message|answers|subject/i

type Level = 'info' | 'warn' | 'error'

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) && !/_id$|^id$|count|length|_at$|status/i.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '…'
  return value
}

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ? (redact(data) as object) : {}) })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
}
