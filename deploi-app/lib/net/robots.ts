/**
 * robots.txt (RFC 9309). The competitor watcher reads a page only when the store's robots.txt allows it
 * for our user agent (or "*" when no group names us). Longest matching rule wins; on a tie, Allow wins.
 * Availability follows the RFC: 4xx (no robots.txt) allows everything; 5xx or no answer means "assume
 * everything is disallowed" until a later check succeeds.
 */
export type RobotsRules = { kind: 'rules'; allow: string[]; disallow: string[]; crawlDelaySeconds: number | null } | { kind: 'allow_all' } | { kind: 'disallow_all'; reason: string }

const TOKEN = 'deploicompetitorwatcher'

export function parseRobots(text: string, token = TOKEN): RobotsRules {
  type Group = { agents: string[]; allow: string[]; disallow: string[]; delay: number | null }
  const groups: Group[] = []
  let cur: Group | null = null
  let lastWasAgent = false
  for (const rawLine of text.slice(0, 512 * 1024).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase(), value = m[2].trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], delay: null }; groups.push(cur) }
      cur.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (key === 'allow') { if (value) cur.allow.push(value) }
    else if (key === 'disallow') { if (value) cur.disallow.push(value) }
    else if (key === 'crawl-delay') { const n = Number(value); if (Number.isFinite(n) && n >= 0) cur.delay = n }
  }
  const named = groups.filter(g => g.agents.some(a => a !== '*' && token.includes(a.replace(/\/.*$/, ''))))
  const chosen = named.length ? named : groups.filter(g => g.agents.includes('*'))
  if (!chosen.length) return { kind: 'allow_all' }
  return { kind: 'rules', allow: chosen.flatMap(g => g.allow), disallow: chosen.flatMap(g => g.disallow), crawlDelaySeconds: chosen.map(g => g.delay).find(d => d !== null) ?? null }
}

/** Length of the longest match of `pattern` against `path`, or -1. Supports * and a trailing $. */
function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith('$')
  const p = anchored ? pattern.slice(0, -1) : pattern
  const re = new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''))
  return re.test(path) ? pattern.length : -1
}

/** Is this path (with query) allowed? */
export function robotsAllows(rules: RobotsRules, pathWithQuery: string): boolean {
  if (rules.kind === 'allow_all') return true
  if (rules.kind === 'disallow_all') return false
  if (pathWithQuery === '/robots.txt') return true
  let best = -1, allowed = true
  for (const a of rules.allow) { const n = matchLength(a, pathWithQuery); if (n > best || (n === best && n >= 0)) { best = n; allowed = true } }
  for (const d of rules.disallow) { const n = matchLength(d, pathWithQuery); if (n > best) { best = n; allowed = false } }
  return allowed
}

/** What a robots.txt fetch outcome means. */
export function robotsFromResponse(status: number | null, body: string): RobotsRules {
  if (status === null) return { kind: 'disallow_all', reason: 'robots.txt could not be reached' }
  if (status >= 200 && status < 300) return parseRobots(body)
  if (status === 429) return { kind: 'disallow_all', reason: 'the store is rate limiting requests' }
  if (status >= 400 && status < 500) return { kind: 'allow_all' }
  return { kind: 'disallow_all', reason: `robots.txt answered ${status}` }
}
