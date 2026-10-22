'use server'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { anon } from '@/lib/db'
import { requestIp } from '@/lib/auth'
import { log } from '@/lib/log'

const Request = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  agency_name: z.string().trim().max(200).optional().default(''),
  /** honeypot */
  website: z.string().optional(),
})

/** "Get started": joins the waitlist through the same public lead function the site uses. */
export async function joinWaitlist(formData: FormData) {
  const parsed = Request.safeParse({
    name: formData.get('name') ?? '',
    email: formData.get('email') ?? '',
    agency_name: formData.get('agency_name') ?? '',
    website: formData.get('website') ?? '',
  })
  if (!parsed.success) redirect('/signup?error=check-your-name-and-email')
  const r = parsed.data
  if (r.website) redirect('/signup?sent=1')
  try {
    const ip = await requestIp()
    await anon(db => db.one('select public_create_lead($1,$2,$3,$4,$5,$6,$7,$8,$9) as id',
      [r.name, r.email.toLowerCase(), r.agency_name, null, 'Get started (app signup page)', 'site', null, null, 'OH']), { ip })
    log.info('signup.waitlist')
  } catch (e) {
    log.error('signup.waitlist.failed', { error: (e as Error).message })
    redirect('/signup?error=could-not-save-try-again')
  }
  redirect('/signup?sent=1')
}
