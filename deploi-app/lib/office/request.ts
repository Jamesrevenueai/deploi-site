/**
 * Office API requests: the signed-in customer (same session and CSRF rules as the store API) of an
 * organization that has Deploi Office enabled. Staff are refused (support reads the audit log at /staff).
 * A provider without OAuth credentials answers 503 "needs_setup".
 */
import { NextResponse } from 'next/server'
import { admin } from '../db'
import { errorResponse, HttpError, resolveActor } from '../store/request'
import { assertProduct } from '../products'
import type { Actor } from '../engine/actor'
import { OfficeNotConfigured } from './connections'
import './actions'

export async function officeActor(req: Request, opts: { mutating?: boolean; allowDisabled?: boolean } = {}): Promise<Exclude<Actor, { kind: 'staff' }>> {
  const actor = await resolveActor(req, opts)
  if (actor.kind === 'staff') throw new HttpError(403, 'staff_read_only', 'Deploi Office is used by the customer; staff read the audit log')
  if (!opts.allowDisabled) await admin(db => assertProduct(db, actor.orgId, 'office'))
  return actor
}

export function officeError(e: unknown): NextResponse {
  if (e instanceof OfficeNotConfigured) return NextResponse.json({ ok: false, error: 'needs_setup', message: e.message }, { status: 503 })
  return errorResponse(e)
}
