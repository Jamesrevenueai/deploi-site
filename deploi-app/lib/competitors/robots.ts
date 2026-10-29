/**
 * robots.txt, as RFC 9309 describes it: the group for our product token if there is one, else "*";
 * the longest matching rule wins, and Allow wins a tie; "*" matches any characters and "$" anchors
 * the end. Fail closed: a robots.txt that cannot be fetched because of a server or network error
 * means "do not crawl"; a missing one (4xx) means everything is allowed.
 */
export const BOT_TOKEN = 'deploibot'
export const USER_AGENT = 'DeploiBot/1.0 (+https://getdeploi.com; reads public product pages for store owners)'

type Rule = { allow: boolean; pattern: string }
export type Robots = { kind: 'rules'; rules: Rule[] } | { kind: 'allow_all' } | { kind: 'disallow_all'; reason: string }

export function parseRobots(text: string, token = BOT_TOKEN): Robots {
  const groups: { agents: string[]; rules: Rule[] }[] = []
  let current: { agents: string[]; rules: Rule[] } | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase(), value = m[2].trim()
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current) }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false
      if (field === 'disallow' && value === '') continue // an empty Disallow allows everything
      current.rules.push({ allow: field === 'allow', pattern: value })
    } else lastWasAgent = false
  }
  const ours = groups.filter(g => g.agents.some(a => a !== '*' && token.startsWith(a.replace(/\/.*$/, ''))))
  const chosen = ours.length ? ours : groups.filter(g => g.agents.includes('*'))
  return { kind: 'rules', rules: chosen.flatMap(g => g.rules) }
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const re = new RegExp('^' + body.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''))
  return re.test(path)
}

/** May we fetch this path (with its query string)? */
export function robotsAllows(r: Robots, pathWithQuery: string): boolean {
  if (r.kind === 'allow_all') return true
  if (r.kind === 'disallow_all') return false
  if (pathWithQuery === '/robots.txt') return true
  let best: Rule | null = null
  for (const rule of r.rules) {
    if (!rule.pattern.startsWith('/') && !rule.pattern.startsWith('*')) continue
    if (!matches(rule.pattern, pathWithQuery)) continue
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule
  }
  return best ? best.allow : true
}

/** robots.txt from an HTTP status and body. */
export function robotsFromResponse(status: number, body: string): Robots {
  if (status >= 200 && status < 300) return parseRobots(body)
  if (status >= 400 && status < 500) return { kind: 'allow_all' }
  return { kind: 'disallow_all', reason: `robots.txt could not be read (HTTP ${status}), so the store is not checked` }
}
