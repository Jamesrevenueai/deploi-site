/**
 * Seed parts: each feature area owns one file here and registers it below.
 * Every part is idempotent (deterministic ids via uuidFrom) and uses only synthetic data.
 * Runs after the staff logins with the same client.
 * Static imports (not top-level await): `npx tsx scripts/seed.ts` runs as CommonJS.
 */
import type { Client } from 'pg'
import { seedArea as merchant } from './merchant'

export type SeedCtx = { c: Client; counts: Record<string, number> }
export type SeedPart = (ctx: SeedCtx) => Promise<void>

const PARTS: SeedPart[] = [
  // register parts here, one line each: import { seedArea as <area> } from './<area>' above, then <area> here
  merchant,
]

export async function runSeedParts(ctx: SeedCtx) {
  for (const part of PARTS) await part(ctx)
}
