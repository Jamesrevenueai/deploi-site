'use server'
import { revalidatePath } from 'next/cache'
import { requireSession, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { correctException, dismissException, reopenException } from '@/lib/evv/workflow'
import { log } from '@/lib/log'

export type ActionResult = { ok: boolean; error?: string }

async function run(formData: FormData, fn: 'correct' | 'dismiss' | 'reopen'): Promise<ActionResult> {
  const session = await requireSession()
  const ip = await requestIp()
  const id = String(formData.get('id') ?? '')
  const note = String(formData.get('note') ?? '')
  if (!id) return { ok: false, error: 'Missing exception id' }
  try {
    const ok = await withUser(session, db => fn === 'correct' ? correctException(db, id, note) : fn === 'dismiss' ? dismissException(db, id, note) : reopenException(db, id), { ip })
    if (!ok) return { ok: false, error: 'That exception is no longer open.' }
    log.info('evv.exception.' + fn, { id, uid: session.uid })
    revalidatePath('/staff/evv'); revalidatePath('/app/evv'); revalidatePath('/app/home')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function correctAction(_: ActionResult | null, formData: FormData) { return run(formData, 'correct') }
export async function dismissAction(_: ActionResult | null, formData: FormData) { return run(formData, 'dismiss') }
export async function reopenAction(formData: FormData) { await run(formData, 'reopen') }
