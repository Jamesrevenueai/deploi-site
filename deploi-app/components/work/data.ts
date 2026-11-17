'use client'
/** Loaders for the case screens. APIs owned by other workstreams are read when present (probe) and skipped when not. */
import { storeFetch, StoreApiError } from '@/components/store/api'
import type { ControlRoomResponse } from '@/components/cx/types'
import { mergeCases, type AgentDirectory, type ApprovalsResponse, type CaseCounts, type CaseItem, type CasesResponse } from './caseView'
import type { CaseView } from '@/lib/cases'

/** The cases of several views, merged, plus the organization's counts. */
export async function loadCases(views: CaseView[], limit = 100): Promise<{ cases: CaseItem[]; counts: CaseCounts }> {
  const rs = await Promise.all(views.map(v => storeFetch<CasesResponse>(`/api/store/cases?view=${v}&limit=${limit}`)))
  return { cases: mergeCases(rs.map(r => r.cases)), counts: rs[0]?.counts ?? { in_progress: 0, needs_approval: 0, completed: 0, attention: 0, total: 0, resolved_30d: 0 } }
}

/** The unified approvals; null when it cannot be read (the screens say so instead of showing zero). */
export async function loadApprovals(): Promise<ApprovalsResponse | null> {
  try { return await storeFetch<ApprovalsResponse>('/api/store/approvals') } catch (e) { if (e instanceof StoreApiError && e.status === 404) return null; throw e }
}

const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

export type TeamData = {
  cr: ControlRoomResponse | null
  office: { id: string; name: string; status: string; kind?: string }[] | null
  library: { key: string; name: string; enabled: boolean; locked: boolean; permission: string; waiting: number }[] | null
}

/** Every agent source the organization may have. Office answers 403 when it is not enabled: that is "no Office agents", not an error. */
export async function loadTeam(): Promise<TeamData> {
  const [cr, office, library] = await Promise.all([
    safe(storeFetch<ControlRoomResponse>('/api/store/control-room')),
    safe(storeFetch<{ agents: { id: string; name: string; status: string; kind?: string }[] }>('/api/office/agents').then(r => r.agents)),
    safe(storeFetch<{ agents: { key: string; name: string; enabled: boolean; locked: boolean; permission: string; waiting: number }[] }>('/api/store/library').then(r => r.agents)),
  ])
  return { cr, office, library }
}

export function directoryOf(t: TeamData): AgentDirectory {
  return {
    engine: Object.fromEntries((t.cr?.agents ?? []).map(a => [a.id, a.name])),
    office: Object.fromEntries((t.office ?? []).map(a => [a.id, a.name])),
    library: Object.fromEntries((t.library ?? []).map(a => [a.key, a.name])),
  }
}
