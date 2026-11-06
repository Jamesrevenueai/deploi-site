/** Client calls of the agent dashboard to the /api/app endpoints (lib/app/contract.ts). */
import type { AgentAutonomy, AgentDashboard, AutonomyResult, ChatMessage, Instruction, NeedsYouDecision } from '@/lib/app/contract'

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); this.name = 'ApiError' } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch { throw new ApiError(0, 'network', 'Could not reach Deploi. Check your connection and try again.') }
  const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; message?: string } & T
  if (!res.ok || json.ok === false) throw new ApiError(res.status, json.error ?? 'error', friendly(res.status, json.error, json.message))
  return json
}

function friendly(status: number, code?: string, message?: string): string {
  if (status === 403 && code === 'read_only_role') return 'Your role (viewer) is read-only; ask an owner or admin.'
  if (status === 403) return 'Only owners and admins can change this.'
  if (status === 401) return 'Your session ended. Sign in again.'
  if (status === 429) return 'Too many changes at once; try again in a minute.'
  if (status === 404) return 'Not found. It may have been removed.'
  if (message && status === 400) return message.charAt(0).toUpperCase() + message.slice(1)
  return 'Something went wrong; nothing was changed.'
}

const base = (id: string) => `/api/app/agents/${encodeURIComponent(id)}`

export const agentApi = {
  dashboard: async (id: string) => (await call<{ dashboard: AgentDashboard }>('GET', base(id))).dashboard,
  setAutonomy: (id: string, autonomy: AgentAutonomy) => call<AutonomyResult>('POST', `${base(id)}/autonomy`, { autonomy }),
  addInstruction: async (id: string, text: string) => (await call<{ instruction: Instruction }>('POST', `${base(id)}/instructions`, { text })).instruction,
  updateInstruction: async (id: string, instructionId: string, text: string) => (await call<{ instruction: Instruction }>('PATCH', `${base(id)}/instructions/${encodeURIComponent(instructionId)}`, { text })).instruction,
  deleteInstruction: (id: string, instructionId: string) => call<{ deleted: true }>('DELETE', `${base(id)}/instructions/${encodeURIComponent(instructionId)}`),
  chat: async (id: string, text: string) => (await call<{ messages: ChatMessage[] }>('POST', `${base(id)}/chat`, { text })).messages,
  decide: async (needsYouId: string, decision: 'approve' | 'decline') => (await call<{ result: NeedsYouDecision }>('POST', `/api/app/needs-you/${encodeURIComponent(needsYouId)}`, { decision })).result,
}
