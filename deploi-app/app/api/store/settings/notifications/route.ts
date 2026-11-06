import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { getMyPrefs, setMyPrefs } from '@/lib/notify/preferences'

export const dynamic = 'force-dynamic'

/** How you get agent updates: email (on by default), text and voice note (off), and the daily digest option. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, prefs: await getMyPrefs(actor), smsProvider: (process.env.NOTIFY_SMS_PROVIDER ?? '').trim() || 'simulated' })
  } catch (e) { return errorResponse(e) }
}

/** { email?, text?, voice?, phone?, digest?: 'off' | 'daily' }: your own preferences only. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    return NextResponse.json({ ok: true, prefs: await setMyPrefs(actor, await readJson(req)) })
  } catch (e) { return errorResponse(e) }
}
