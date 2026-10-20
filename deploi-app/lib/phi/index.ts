/**
 * PHI-adjacent LLM helpers. This directory may ONLY call the local (Ollama) lane.
 * Enforced by: eslint no-restricted-imports (eslint.config.mjs) + tests/phi-boundary.test.ts.
 */
import { completeLocal } from '../llm/local'
import type { CompleteInput, CompleteOutput } from '../llm/types'

export async function phiComplete(input: CompleteInput): Promise<CompleteOutput> {
  return completeLocal(input)
}

/** Draft a short, plain reply to a referral request using only the local lane. */
export async function draftReferralReply(opts: { referrerName: string | null; service: string | null; county: string | null; canServe: boolean; agencyName: string }) {
  const prompt = `Write a two-sentence reply to a home care referral.
Referrer: ${opts.referrerName ?? 'the case manager'}. Service: ${opts.service ?? 'home care'}. County: ${opts.county ?? 'unknown'}.
We ${opts.canServe ? 'CAN accept this client and will start intake today' : 'cannot serve this county/service right now and will suggest a partner'}.
Sign as ${opts.agencyName}. Plain English, no emojis.`
  return phiComplete({ prompt, maxTokens: 160 })
}
