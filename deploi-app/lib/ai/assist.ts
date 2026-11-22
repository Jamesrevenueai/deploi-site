/**
 * AI-assisted steps: a deterministic step that may ask the gateway for help, and always has its rules to fall back on.
 *
 *   aiAssist({ orgId, agentRef, caseId, purpose, tier, input, schema, guard, subjectRef })
 *
 *  - runs only when the gateway is on and fully configured (AI_PROVIDER, models, prices, endpoint, key). With
 *    AI_PROVIDER=off it returns `{ path: 'rules', fallback: 'off' }` at once and touches nothing: no model call, no
 *    usage row, no record, so every step behaves exactly as it did before AI assistance existed;
 *  - asks only while the organization's monthly budget has room (checked here, then again by the gateway under its lock);
 *  - validates the output twice: the strict schema (the gateway refuses anything that does not parse), then the
 *    step's own `guard`, which rejects output that is not grounded in the input (e.g. a quantity the supplier never
 *    wrote, an address that was not in the draft). Output is data: nothing here can add a recipient, change an
 *    amount, a tier or a permission, or approve anything; the caller decides what the data may influence;
 *  - falls back to the rules on refusal, budget, timeout, provider error or invalid output, and says why;
 *  - meters the call in ai_usage with the case id (the gateway), and records the path taken in ai_assists, once per
 *    subject: the same subject asked again (a re-run, a duplicate delivery) gets the recorded answer, never a second call.
 */
import { admin } from '../db'
import { aiComplete, type AiSchema, type AiTier } from './gateway'
import { aiConfig, aiConfigProblems } from './config'
import { aiBudgets, aiSpend } from './budgets'
import { monthOf } from './meter'

export type AssistFallback = 'off' | 'not_configured' | 'budget' | 'refused' | 'timeout' | 'provider_error' | 'invalid_output'
export type AssistOutcome<T> =
  | { path: 'ai'; value: T; usageId: number | null; cached: boolean }
  | { path: 'rules'; fallback: AssistFallback; reason: string; usageId: number | null; cached: boolean }

export type AssistRequest<T> = {
  orgId: string; agentRef: string; caseId?: string | null; purpose: string; tier: AiTier
  input: string; system?: string; maxOutputTokens?: number
  schema: AiSchema<T>
  /** null when the value may be used; otherwise why it was rejected */
  guard?: (value: T) => string | null
  /** what is being decided (inbound:<id>, draft:<key>): decided once, then answered from the record */
  subjectRef?: string | null
  timeoutMs?: number
  now?: Date
}

/** Is AI assistance possible in this environment at all? */
export function aiAssistEnabled(): boolean {
  return aiConfig.provider !== 'off' && aiConfigProblems().length === 0
}

const CODE: Record<string, AssistFallback> = { budget_agent: 'budget', budget_org: 'budget', provider_error: 'provider_error', invalid_output: 'invalid_output', disabled: 'off', not_configured: 'not_configured' }

/** Fields for the case event that says which path ran ({} with the gateway off, so nothing changes then). */
export function assistDetail(o: AssistOutcome<unknown>, label = 'interpreted_by'): Record<string, unknown> {
  if (o.path === 'rules' && o.fallback === 'off') return {}
  return o.path === 'ai' ? { [label]: 'ai', ai_validated: true } : { [label]: 'rules', ai_fallback: o.fallback, ai_fallback_reason: o.reason.slice(0, 200) }
}

export async function aiAssist<T>(req: AssistRequest<T>): Promise<AssistOutcome<T>> {
  if (aiConfig.provider === 'off') return { path: 'rules', fallback: 'off', reason: 'AI_PROVIDER=off', usageId: null, cached: false }
  const subject = req.subjectRef?.slice(0, 200) ?? null
  if (subject) {
    const prior = await admin(db => db.one<{ path: 'ai' | 'rules'; fallback: string | null; result: T; usage_id: string | null }>(
      'select path, fallback, result, usage_id::text from ai_assists where org_id = $1 and purpose = $2 and subject_ref = $3', [req.orgId, req.purpose, subject]))
    if (prior) return prior.path === 'ai'
      ? { path: 'ai', value: prior.result, usageId: prior.usage_id ? Number(prior.usage_id) : null, cached: true }
      : { path: 'rules', fallback: (prior.fallback?.split(':')[0] as AssistFallback) ?? 'refused', reason: prior.fallback ?? 'recorded', usageId: prior.usage_id ? Number(prior.usage_id) : null, cached: true }
  }
  const settle = async (o: AssistOutcome<T>): Promise<AssistOutcome<T>> => {
    // budget or configuration refusals are not decisions about the subject: they are retried on the next run
    if (!subject || (o.path === 'rules' && (o.fallback === 'not_configured' || o.fallback === 'budget'))) return o
    const row = await admin(db => db.one<{ id: string }>(
      `insert into ai_assists (org_id, case_id, purpose, subject_ref, path, fallback, result, usage_id) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, purpose, subject_ref) do nothing returning id::text`,
      [req.orgId, req.caseId ?? null, req.purpose, subject, o.path, o.path === 'rules' ? `${o.fallback}: ${o.reason}`.slice(0, 300) : null, JSON.stringify(o.path === 'ai' ? o.value : {}), o.usageId]))
    if (row) return o
    // a concurrent run decided first: use its answer, so both runs act on the same one
    return aiAssist({ ...req })
  }
  if (aiConfigProblems().length) return { path: 'rules', fallback: 'not_configured', reason: aiConfigProblems().join('; '), usageId: null, cached: false }
  const now = req.now ?? new Date()
  const room = await admin(async db => {
    const b = await aiBudgets(db, req.orgId, req.agentRef, now)
    const spent = await aiSpend(db, req.orgId, null, monthOf(now))
    return spent < b.orgUsd ? null : `the organization's model budget for the month ($${b.orgUsd.toFixed(2)}) is used`
  })
  if (room) return settle({ path: 'rules', fallback: 'budget', reason: room, usageId: null, cached: false })

  const timeoutMs = Math.max(500, req.timeoutMs ?? aiConfig.timeoutMs + 2000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs) })
  const call = aiComplete<T>({ orgId: req.orgId, agentRef: req.agentRef, purpose: req.purpose, tier: req.tier, input: req.input, system: req.system, maxOutputTokens: req.maxOutputTokens, caseId: req.caseId ?? null, schema: req.schema, now })
  const r = await Promise.race([call, timeout]).finally(() => clearTimeout(timer))
  if (r === 'timeout') return settle({ path: 'rules', fallback: 'timeout', reason: `no answer within ${timeoutMs} ms`, usageId: null, cached: false })
  if (!r.ok) {
    const fb: AssistFallback = r.code === 'provider_error' && /timed out/i.test(r.reason) ? 'timeout' : CODE[r.code] ?? 'refused'
    return settle({ path: 'rules', fallback: fb, reason: r.reason, usageId: r.usageId, cached: false })
  }
  const value = r.data as T
  let rejected: string | null
  try { rejected = req.guard ? req.guard(value) : null } catch (e) { rejected = (e as Error).message || 'rejected' }
  if (rejected) return settle({ path: 'rules', fallback: 'invalid_output', reason: `rejected: ${rejected}`.slice(0, 300), usageId: r.usageId, cached: false })
  return settle({ path: 'ai', value, usageId: r.usageId, cached: false })
}

/** Attach an assisted step's usage and record to a case opened after the step ran. */
export async function attachAssistToCase(o: AssistOutcome<unknown>, caseId: string, orgId: string) {
  if (o.path === 'rules' && o.fallback === 'off') return
  await admin(async db => {
    if (o.usageId) await db.query('update ai_usage set case_id = $2 where id = $1 and org_id = $3 and case_id is null', [o.usageId, caseId, orgId])
    if (o.usageId) await db.query('update ai_assists set case_id = $2 where usage_id = $1 and org_id = $3 and case_id is null', [o.usageId, caseId, orgId])
  })
}
