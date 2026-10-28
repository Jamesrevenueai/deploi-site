export type EngineErrorCode =
  | 'not_found' | 'forbidden' | 'not_pending' | 'expired' | 'hash_mismatch' | 'rule_changed'
  | 'not_retryable' | 'connection_inactive' | 'not_operational' | 'invalid_input' | 'agent_inactive' | 'busy'

export class EngineError extends Error {
  constructor(public code: EngineErrorCode, message: string, public detail: Record<string, unknown> = {}) { super(message); this.name = 'EngineError' }
}

export function isEngineError(e: unknown): e is EngineError { return e instanceof EngineError }
