/**
 * Seed parts: each feature area owns one file here and registers it below.
 * Every part is idempotent (deterministic ids via uuidFrom) and uses only synthetic data.
 * Runs after the core seed with the same client; receives the two seed agency ids.
 */
import type { Client } from 'pg'

export type SeedCtx = { c: Client; agencyA: string; agencyB: string; counts: Record<string, number> }
export type SeedPart = (ctx: SeedCtx) => Promise<void>

const PARTS: SeedPart[] = [
  // register parts here, one line each: (await import('./<area>')).seedArea
]

export async function runSeedParts(ctx: SeedCtx) {
  for (const part of PARTS) await part(ctx)
}
