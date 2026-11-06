/**
 * Supabase Auth admin calls made with the service role key (server only). Used to record an organization
 * assignment in a user's app_metadata, which only the service role can write. user_metadata is never written
 * or read for authorization (docs/HOTFIX-F02.md): the person signing up controls it.
 *
 * GoTrue admin API: PUT /auth/v1/admin/users/{id} with { app_metadata } merges into the existing app metadata.
 * https://supabase.com/docs/reference/api/update-a-user (auth admin updateUserById)
 */
import { env } from '../env'
import { log } from '../log'

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let override: Fetch | null = null
/** tests only: route Supabase admin HTTP through a fake */
export function setSupabaseAdminFetch(f: Fetch | null) { override = f }

export const supabaseAdminConfigured = () => Boolean(env.supabaseUrl && env.supabaseServiceKey)

export type AppMetadataResult = { ok: true } | { ok: false; skipped: true; reason: string } | { ok: false; skipped: false; reason: string }

/** Merge { agency_id, role } into the user's app_metadata. Skipped (not an error) when Supabase is not configured. */
export async function setAppMetadata(uid: string, meta: { agency_id: string | null; role: 'client' | 'staff' }): Promise<AppMetadataResult> {
  if (!supabaseAdminConfigured()) return { ok: false, skipped: true, reason: 'Supabase is not configured' }
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return { ok: false, skipped: false, reason: 'invalid user id' }
  const url = `${env.supabaseUrl.replace(/\/$/, '')}/auth/v1/admin/users/${uid}`
  try {
    const res = await (override ?? fetch)(url, {
      method: 'PUT',
      headers: { apikey: env.supabaseServiceKey, authorization: `Bearer ${env.supabaseServiceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app_metadata: meta }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) return { ok: true }
    log.warn('supabase.app_metadata.failed', { status: res.status })
    return { ok: false, skipped: false, reason: `Supabase answered ${res.status}` }
  } catch (e) {
    log.warn('supabase.app_metadata.failed', { error: (e as Error).name })
    return { ok: false, skipped: false, reason: 'no response from Supabase' }
  }
}
