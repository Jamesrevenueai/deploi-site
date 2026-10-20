/**
 * LOCAL lane: Ollama only. The sole lane lib/phi may import. Nothing here ever
 * leaves the machine Ollama runs on.
 */
import { env } from '../env'
import { log } from '../log'
import { LlmUnavailable, type CompleteInput, type CompleteOutput } from './types'

export async function completeLocal(input: CompleteInput): Promise<CompleteOutput> {
  if (env.llmMock) return { text: mock(input), provider: 'ollama', model: env.ollamaModel, mocked: true }
  let res: Response
  try {
    res = await fetch(`${env.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.ollamaModel,
        system: input.system,
        prompt: input.prompt,
        stream: false,
        format: input.json ? 'json' : undefined,
        options: { temperature: input.temperature ?? 0.2, num_predict: input.maxTokens ?? 512 },
      }),
    })
  } catch (e) {
    throw new LlmUnavailable('local', (e as Error).message)
  }
  if (!res.ok) throw new LlmUnavailable('local', `HTTP ${res.status}`)
  const data = (await res.json()) as { response: string }
  log.info('llm.local.complete', { model: env.ollamaModel, chars: data.response?.length ?? 0 })
  return { text: data.response ?? '', provider: 'ollama', model: env.ollamaModel, mocked: false }
}

export function mock(input: CompleteInput): string {
  if (input.json) return JSON.stringify({ mocked: true, summary: 'Mock response (LLM_MOCK=1).' })
  return `Mock response (LLM_MOCK=1) for a ${input.prompt.length}-character prompt.`
}
