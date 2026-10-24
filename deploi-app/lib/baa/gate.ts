/**
 * BAA gate. Every data-ingest path (roster, capacity rules, referral inbox,
 * scheduler/claim CSV, applicant CSV/webhook, EVV import) must call
 * assertBaaSigned() BEFORE writing a row. Assessment traces, leak inputs and
 * report generation are deliberately NOT gated.
 */
import { NextResponse } from 'next/server'
import type { Db } from '../db'

export const BAA_MESSAGE = 'BAA not signed for this agency'

export class BaaNotSignedError extends Error {
  status = 403
  constructor(public agencyId: string) {
    super(BAA_MESSAGE)
    this.name = 'BaaNotSignedError'
  }
}

export async function isBaaSigned(db: Db, agencyId: string): Promise<boolean> {
  const row = await db.one<{ baa_signed_at: string | null }>('select baa_signed_at from agencies where id = $1', [agencyId])
  return Boolean(row?.baa_signed_at)
}

/** Throws BaaNotSignedError (403) when the agency has no signed BAA on file. */
export async function assertBaaSigned(db: Db, agencyId: string): Promise<void> {
  if (!(await isBaaSigned(db, agencyId))) throw new BaaNotSignedError(agencyId)
}

export function isBaaError(e: unknown): e is BaaNotSignedError {
  return e instanceof BaaNotSignedError || (e instanceof Error && e.message === BAA_MESSAGE)
}

/** Route-handler response for a gated request. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function baaResponse(_err?: unknown) {
  return NextResponse.json({ ok: false, error: BAA_MESSAGE }, { status: 403 })
}

/** Query-string flag server actions redirect with when the gate rejects. */
export const BAA_ERROR_PARAM = 'baa-not-signed'

export function baaErrorUrl(base: string) {
  return `${base}${base.includes('?') ? '&' : '?'}error=${BAA_ERROR_PARAM}`
}
