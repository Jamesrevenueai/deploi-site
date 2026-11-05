/**
 * Model providers behind the gateway. The gateway is the only caller: nothing else in the app may talk to
 * a model provider (tests/platform/ai-gateway.test.ts checks the source tree for that).
 *
 *  - http: one JSON POST to AI_ENDPOINT through the outbound boundary (purpose `ai`). The request carries the
 *    model id, the system text, one user message and the output cap; the reply is read from the common
 *    response shapes (content[].text or choices[0].message.content; usage.input_tokens/output_tokens or
 *    prompt_tokens/completion_tokens). Any other shape is a provider error.
 *  - fake: a function the tests install (setFakeProvider). Refused outside tests (aiConfigProblems).
 */
import { assertApprovedHost } from '../net/outbound'
import { aiConfig } from './config'

export type ProviderRequest = { model: string; system: string; input: string; maxOutputTokens: number }
export type ProviderReply = { text: string; inputTokens: number | null; outputTokens: number | null }
export type Provider = (req: ProviderRequest) => Promise<ProviderReply>

export class ProviderError extends Error { constructor(message: string, public status = 0) { super(message); this.name = 'ProviderError' } }

let fake: Provider | null = null
/** Tests only: the provider used while AI_PROVIDER=fake. */
export function setFakeProvider(p: Provider | null) { fake = p }

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

export function parseReply(j: Record<string, unknown>): ProviderReply {
  const content = j.content
  let text: string | null = null
  if (Array.isArray(content)) text = content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('')
  const choices = j.choices as { message?: { content?: unknown } }[] | undefined
  if (text === null && Array.isArray(choices) && typeof choices[0]?.message?.content === 'string') text = choices[0].message.content as string
  if (text === null) throw new ProviderError('the model provider replied in an unexpected shape')
  const u = (j.usage ?? {}) as Record<string, unknown>
  return { text, inputTokens: int(u.input_tokens) ?? int(u.prompt_tokens), outputTokens: int(u.output_tokens) ?? int(u.completion_tokens) }
}

const httpProvider: Provider = async req => {
  const url = aiConfig.endpoint
  assertApprovedHost(url, 'ai')
  const key = aiConfig.apiKey
  if (!key) throw new ProviderError('the model provider key is not configured')
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...aiConfig.extraHeaders }
  if (aiConfig.authHeader === 'authorization') headers.authorization = `Bearer ${key}`
  else headers[aiConfig.authHeader] = key
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), aiConfig.timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', headers, signal: ctl.signal, redirect: 'error',
      body: JSON.stringify({ model: req.model, max_tokens: req.maxOutputTokens, system: req.system, messages: [{ role: 'user', content: req.input }] }) })
    let j: Record<string, unknown> = {}
    try { j = await res.json() as Record<string, unknown> } catch { j = {} }
    if (!res.ok) throw new ProviderError(`the model provider answered ${res.status}`, res.status)
    return parseReply(j)
  } catch (e) {
    if (e instanceof ProviderError) throw e
    throw new ProviderError((e as Error).name === 'AbortError' ? 'the model provider timed out' : 'the model provider could not be reached')
  } finally { clearTimeout(timer) }
}

export function currentProvider(): Provider | null {
  const mode = aiConfig.provider
  if (mode === 'http') return httpProvider
  if (mode === 'fake') return fake
  return null
}
