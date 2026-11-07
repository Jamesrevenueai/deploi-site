'use server'
import { redirect } from 'next/navigation'
import { getSession, requestIp } from '@/lib/auth'
import { isEngineError } from '@/lib/engine/errors'
import { runUndo } from '@/lib/undo/run'
import { undoActorFor } from './actor'

const back = (token: string, q = '') => `/undo/${encodeURIComponent(token)}${q ? `?${q}` : ''}`

/** Reverse the change: owner or admin of the token's organization, once (lib/undo/run.ts enforces every rule). */
export async function confirmUndoAction(fd: FormData) {
  const token = String(fd.get('token') ?? '')
  const s = await getSession()
  if (!s) redirect('/login')
  const actor = undoActorFor(s)
  if (!actor) redirect(back(token, 'error=not-allowed'))
  try {
    await runUndo(actor, token, { ip: await requestIp() })
  } catch (e) {
    if (isEngineError(e)) redirect(back(token, `error=${encodeURIComponent(e.code)}`))
    throw e
  }
  redirect(back(token))
}
