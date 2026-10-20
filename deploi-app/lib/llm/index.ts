/**
 * Provider-agnostic LLM wrapper with two lanes.
 *   local  -> Ollama. Required for anything that could see client records.
 *   cloud  -> env-selected provider. Only for Deploi's own sales data.
 * lib/phi/* may only import lib/llm/local, never this file or cloud.ts.
 */
import type { Lane, CompleteInput, CompleteOutput } from './types'
import { completeLocal } from './local'
import { completeCloud } from './cloud'

export type { Lane, CompleteInput, CompleteOutput }
export { LlmUnavailable } from './types'

export async function complete(lane: Lane, input: CompleteInput): Promise<CompleteOutput> {
  return lane === 'local' ? completeLocal(input) : completeCloud(input)
}
