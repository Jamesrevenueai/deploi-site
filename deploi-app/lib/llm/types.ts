export type Lane = 'local' | 'cloud'
export type CompleteInput = {
  system?: string
  prompt: string
  /** ask for strict JSON output */
  json?: boolean
  maxTokens?: number
  temperature?: number
}
export type CompleteOutput = { text: string; provider: string; model: string; mocked: boolean }
export class LlmUnavailable extends Error {
  constructor(lane: Lane, detail: string) { super(`LLM lane "${lane}" unavailable: ${detail}`) }
}
