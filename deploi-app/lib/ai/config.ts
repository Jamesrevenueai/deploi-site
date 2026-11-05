/**
 * AI gateway configuration (environment only; nothing here names a model).
 *
 *   AI_PROVIDER              off (default: every call is refused with a clear reason) | http | fake (tests only)
 *   AI_ENDPOINT              https URL of the model provider's completion endpoint (http provider)
 *   AI_API_KEY               the provider key (never committed; sent in AI_AUTH_HEADER)
 *   AI_AUTH_HEADER           header that carries the key: x-api-key (default) or authorization (sent as Bearer)
 *   AI_EXTRA_HEADERS         optional JSON object of extra request headers the provider requires (e.g. an API version)
 *   AI_MODEL_ROUTINE         model id for routine extraction and classification (cheap)
 *   AI_MODEL_COMPLEX         model id for complex reasoning (stronger)
 *   AI_PRICES                JSON price table, USD per million tokens: {"<model id>": {"input": 0.1, "output": 0.5}}
 *                            A model without a price is refused (cost must always be computable).
 *   AI_MAX_INPUT_TOKENS      per-call input cap (default 20000, estimated as characters / 4 before the call)
 *   AI_MAX_OUTPUT_TOKENS     per-call output cap (default 2000); a caller may ask for less, never more
 *   AI_MAX_CALLS_PER_AGENT_HOUR   runaway guard per agent (default 30 calls in any rolling hour)
 *   AI_MAX_CALLS_PER_CASE_HOUR    runaway guard per case (default 10)
 *   AI_ORG_MONTHLY_USD       organization budget when the plan names none (default 15)
 *   AI_TIMEOUT_MS            provider timeout (default 30000)
 */
type Env = Record<string, string | undefined>
const v = (e: Env, k: string) => (e[k] ?? '').trim()
const num = (e: Env, k: string, d: number, min = 0) => { const n = Number(v(e, k)); return v(e, k) !== '' && Number.isFinite(n) && n >= min ? n : d }

export type AiProviderMode = 'off' | 'http' | 'fake'
export type ModelPrice = { input: number; output: number }

export function aiProviderMode(e: Env = process.env): AiProviderMode {
  const m = v(e, 'AI_PROVIDER').toLowerCase()
  return m === 'http' || m === 'fake' ? m : 'off'
}

export function aiPrices(e: Env = process.env): Record<string, ModelPrice> {
  try {
    const j = JSON.parse(v(e, 'AI_PRICES') || '{}') as Record<string, unknown>
    const out: Record<string, ModelPrice> = {}
    for (const [k, p] of Object.entries(j)) {
      const x = p as { input?: unknown; output?: unknown }
      if (typeof x?.input === 'number' && typeof x?.output === 'number' && x.input >= 0 && x.output >= 0) out[k] = { input: x.input, output: x.output }
    }
    return out
  } catch { return {} }
}

export const aiConfig = {
  get provider() { return aiProviderMode() },
  get endpoint() { return v(process.env, 'AI_ENDPOINT') },
  get apiKey() { return v(process.env, 'AI_API_KEY') },
  get authHeader() { return v(process.env, 'AI_AUTH_HEADER').toLowerCase() || 'x-api-key' },
  get extraHeaders(): Record<string, string> {
    try { const j = JSON.parse(v(process.env, 'AI_EXTRA_HEADERS') || '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(j).filter(([k, x]) => /^[a-z0-9-]{1,60}$/i.test(k) && typeof x === 'string').map(([k, x]) => [k, String(x)])) } catch { return {} }
  },
  get modelRoutine() { return v(process.env, 'AI_MODEL_ROUTINE') },
  get modelComplex() { return v(process.env, 'AI_MODEL_COMPLEX') },
  get maxInputTokens() { return num(process.env, 'AI_MAX_INPUT_TOKENS', 20_000, 1) },
  get maxOutputTokens() { return num(process.env, 'AI_MAX_OUTPUT_TOKENS', 2_000, 1) },
  get maxCallsPerAgentHour() { return num(process.env, 'AI_MAX_CALLS_PER_AGENT_HOUR', 30, 0) },
  get maxCallsPerCaseHour() { return num(process.env, 'AI_MAX_CALLS_PER_CASE_HOUR', 10, 0) },
  get orgMonthlyUsdDefault() { return num(process.env, 'AI_ORG_MONTHLY_USD', 15, 0) },
  get timeoutMs() { return num(process.env, 'AI_TIMEOUT_MS', 30_000, 1000) },
}

/** Why the gateway cannot make calls in this environment ([] when it can). Shown by /api/health (no secrets). */
export function aiConfigProblems(e: Env = process.env): string[] {
  const mode = aiProviderMode(e)
  if (mode === 'off') return []
  const out: string[] = []
  if (!v(e, 'AI_MODEL_ROUTINE')) out.push('AI_MODEL_ROUTINE is not set')
  if (!v(e, 'AI_MODEL_COMPLEX')) out.push('AI_MODEL_COMPLEX is not set')
  const prices = aiPrices(e)
  for (const m of [v(e, 'AI_MODEL_ROUTINE'), v(e, 'AI_MODEL_COMPLEX')]) if (m && !prices[m]) out.push(`no price in AI_PRICES for the ${m === v(e, 'AI_MODEL_ROUTINE') ? 'routine' : 'complex'} model`)
  if (mode === 'http') {
    if (!/^https:\/\//.test(v(e, 'AI_ENDPOINT'))) out.push('AI_ENDPOINT must be an https URL')
    if (!v(e, 'AI_API_KEY')) out.push('AI_API_KEY is not set')
  }
  if (mode === 'fake' && (v(e, 'VERCEL_ENV') === 'production' || v(e, 'DEPLOI_ENV') === 'production')) out.push('AI_PROVIDER=fake is not allowed in production')
  return out
}

/** USD for a number of tokens on a model; null when the model has no price. */
export function costUsd(model: string, inputTokens: number, outputTokens: number, prices = aiPrices()): number | null {
  const p = prices[model]
  if (!p) return null
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1e6) * 1e6) / 1e6
}

/** Rough token estimate before a call: about four characters per token, rounded up. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)
