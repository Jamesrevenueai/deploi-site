'use server'
/**
 * Staff operations console actions. Each one re-checks the staff session, calls lib/ops/staff.ts (which audits it)
 * and returns to the page with a short notice. There is deliberately no approve, grant or resume action.
 */
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth'
import type { Actor } from '@/lib/engine/actor'
import { acknowledgeAlert, cancelJob, requeueJob, staffClearOrgStop, staffStopOrg } from '@/lib/ops/staff'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()

async function staff(): Promise<Extract<Actor, { kind: 'staff' }>> {
  const session = await requireRole('staff')
  return { kind: 'staff', session, label: `staff:${session.email}` }
}

async function run(back: string, fn: () => Promise<unknown>, ok: string): Promise<never> {
  let msg = ok
  try { await fn() } catch (e) { msg = `Not done: ${(e as Error).message}` }
  revalidatePath('/staff/ops')
  const u = new URL(back || '/staff/ops', 'http://x')
  u.searchParams.set('notice', msg.slice(0, 200))
  redirect(`${u.pathname}?${u.searchParams.toString()}`)
}

const back = (fd: FormData) => { const b = str(fd, 'back'); return b.startsWith('/staff/ops') ? b : '/staff/ops' }

export async function requeueJobAction(fd: FormData) {
  const a = await staff()
  return run(back(fd), () => requeueJob(a, str(fd, 'id'), str(fd, 'reason')), 'The job is queued again.')
}
export async function cancelJobAction(fd: FormData) {
  const a = await staff()
  return run(back(fd), () => cancelJob(a, str(fd, 'id'), str(fd, 'reason')), 'The job is cancelled.')
}
export async function stopOrgAction(fd: FormData) {
  const a = await staff()
  return run(back(fd), () => staffStopOrg(a, str(fd, 'org'), str(fd, 'reason')), 'All agents of the organization are stopped.')
}
export async function clearOrgStopAction(fd: FormData) {
  const a = await staff()
  return run(back(fd), () => staffClearOrgStop(a, str(fd, 'org'), str(fd, 'reason')), 'The stop is off. Agents stay paused until the customer resumes them.')
}
export async function acknowledgeAlertAction(fd: FormData) {
  const a = await staff()
  return run(back(fd), () => acknowledgeAlert(a, str(fd, 'id')), 'Alert acknowledged.')
}
