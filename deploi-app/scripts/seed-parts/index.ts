/**
 * Seed parts: each feature area owns one file here and registers it below.
 * Every part is idempotent (deterministic ids via uuidFrom) and uses only synthetic data.
 * Runs after the core seed with the same client; receives the two seed agency ids.
 * Static imports (not top-level await): `npx tsx scripts/seed.ts` runs as CommonJS.
 */
import type { Client } from 'pg'
import { seedArea as assess } from './assess'
import { seedArea as engage } from './engage'
import { seedArea as econ } from './econ'
import { seedArea as web } from './web'
import { seedArea as ops } from './ops'

export type SeedCtx = { c: Client; agencyA: string; agencyB: string; counts: Record<string, number> }
export type SeedPart = (ctx: SeedCtx) => Promise<void>

const PARTS: SeedPart[] = [
  // register parts here, one line each: import { seedArea as <area> } from './<area>' above, then <area> here
  assess,
  engage,
  econ,
  web,
  ops,
]

export async function runSeedParts(ctx: SeedCtx) {
  for (const part of PARTS) await part(ctx)
}
