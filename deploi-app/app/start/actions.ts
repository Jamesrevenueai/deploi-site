'use server'
import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { isEngineError } from '@/lib/engine/errors'
import { createOwnOrganization } from '@/lib/platform/signup'

/** First run: create the signed-in person's own organization (they are its owner), then continue setup. */
export async function createOrganizationAction(fd: FormData) {
  const s = await requireSession()
  try {
    await createOwnOrganization(s, { name: fd.get('name'), timezone: fd.get('timezone') })
  } catch (e) {
    if (isEngineError(e)) redirect(`/start?error=${encodeURIComponent(e.message.slice(0, 120))}`)
    throw e
  }
  redirect('/store/setup')
}
