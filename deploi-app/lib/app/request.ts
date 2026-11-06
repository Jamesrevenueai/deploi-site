/** Small helpers shared by the /api/app routes (the organization always comes from resolveActor, never the request). */
import { HttpError } from '../store/request'

/** A TeamAgent id from a path segment (URL-encoded or not). */
export function agentIdParam(raw: string): string {
  let id = raw
  try { if (id.includes('%')) id = decodeURIComponent(id) } catch { throw new HttpError(400, 'invalid_input', 'invalid agent id') }
  if (!/^(store|office|pack):[A-Za-z0-9_-]{1,100}$/.test(id)) throw new HttpError(404, 'not_found', 'agent not found')
  return id
}
