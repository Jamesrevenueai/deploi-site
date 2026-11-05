/**
 * Pure reading of the discovery API's answer (GET/POST /api/store/discover) for the first-run screen. The API is
 * delivered by another workstream, so its shape is read defensively: findings and recommendations are taken only
 * when they carry real text; nothing is filled in. Tested in tests/cx/work-view.test.ts.
 */
export type Finding = { key: string; title: string; problem: string | null; kind: string | null; sourceApp: string | null; caseRef: string | null; priority: string | null }
export type Recommendation = { template: string; name: string; reason: string | null; suite: string | null; needs: string[] }
export type Discovery = { findings: Finding[]; recommendations: Recommendation[]; sourcesRead: string[]; state: 'ready' | 'running' | 'not_run' | 'nothing_connected'; ranAt: string | null }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [])

export function readDiscovery(json: unknown): Discovery {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const root = (j.discovery && typeof j.discovery === 'object' ? j.discovery : j.result && typeof j.result === 'object' ? j.result : j) as Record<string, unknown>
  const findings: Finding[] = arr(root.findings ?? root.cases).flatMap((f, i) => {
    const title = str(f.title)
    if (!title) return []
    const c = (f.case && typeof f.case === 'object' ? f.case : {}) as Record<string, unknown>
    return [{ key: str(f.dedupeKey) ?? str(f.id) ?? str(f.ref) ?? `f${i}`, title, problem: str(f.problem), kind: str(f.kind), sourceApp: str(f.sourceApp) ?? str(f.source_app), caseRef: str(f.caseRef) ?? str(f.ref) ?? str(c.ref), priority: str(f.priority) }]
  })
  const recommendations: Recommendation[] = arr(root.recommendations ?? root.recommended ?? root.team).flatMap(r => {
    const template = str(r.template) ?? str(r.key)
    const name = str(r.name)
    if (!template || !name) return []
    return [{ template, name, reason: str(r.reason), suite: str(r.suite), needs: Array.isArray(r.needs) ? r.needs.map(x => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.label))).filter((x): x is string => Boolean(x)) : [] }]
  })
  const sourcesRead = Array.isArray(root.sourcesRead) ? root.sourcesRead.filter((x): x is string => typeof x === 'string') : []
  const status = str(root.status) ?? str(root.state)
  const ranAt = str(root.ranAt) ?? str(root.finishedAt) ?? str(root.at)
  const state: Discovery['state'] = status === 'running' || status === 'queued' ? 'running'
    : findings.length || recommendations.length || ranAt ? 'ready'
    : root.connected === false || status === 'nothing_connected' ? 'nothing_connected' : 'not_run'
  return { findings, recommendations, sourcesRead, state, ranAt }
}
