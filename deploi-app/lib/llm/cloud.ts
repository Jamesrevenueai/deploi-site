/**
 * CLOUD lane: env-selected provider. May ONLY be used with Deploi's own sales
 * data (prospects, touches). Never import from lib/phi.
 */
import { env } from '../env'
import { log } from '../log'
import { LlmUnavailable, type CompleteInput, type CompleteOutput } from './types'
import { mock } from './local'
import { assertApprovedHost } from '../net/outbound'

export async function completeCloud(input: CompleteInput): Promise<CompleteOutput> {
  const { provider, apiKey, model } = env.cloud
  if (env.llmMock || !provider) return { text: mock(input), provider: provider || 'none', model: model || 'mock', mocked: true }
  try {
    if (provider === 'openai') {
      assertApprovedHost('https://api.openai.com', 'cloud_llm')
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), { role: 'user', content: input.prompt }],
          response_format: input.json ? { type: 'json_object' } : undefined,
          max_tokens: input.maxTokens ?? 512,
          temperature: input.temperature ?? 0.2,
        }),
      })
      if (!res.ok) throw new LlmUnavailable('cloud', `openai HTTP ${res.status}`)
      const d = await res.json()
      return { text: d.choices?.[0]?.message?.content ?? '', provider, model: model || 'gpt-4o-mini', mocked: false }
    }
    if (provider === 'anthropic') {
      assertApprovedHost('https://api.anthropic.com', 'cloud_llm')
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-5',
          system: input.system,
          max_tokens: input.maxTokens ?? 512,
          temperature: input.temperature ?? 0.2,
          messages: [{ role: 'user', content: input.prompt + (input.json ? '\nRespond with JSON only.' : '') }],
        }),
      })
      if (!res.ok) throw new LlmUnavailable('cloud', `anthropic HTTP ${res.status}`)
      const d = await res.json()
      return { text: d.content?.[0]?.text ?? '', provider, model: model || 'claude-sonnet-4-5', mocked: false }
    }
    if (provider === 'ollama') {
      const { completeLocal } = await import('./local')
      return completeLocal(input)
    }
  } catch (e) {
    if (e instanceof LlmUnavailable) throw e
    throw new LlmUnavailable('cloud', (e as Error).message)
  } finally {
    log.info('llm.cloud.complete', { provider })
  }
  throw new LlmUnavailable('cloud', `unknown provider "${provider}"`)
}
