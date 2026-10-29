import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { completeOnboarding, onboardingView } from '@/lib/library/onboarding'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try { return NextResponse.json({ ok: true, ...(await onboardingView(await resolveActor(req))) }) } catch (e) { return errorResponse(e) }
}
/** Marks onboarding complete once a store is connected and a plan chosen. */
export async function POST(req: Request) {
  try { return NextResponse.json({ ok: true, ...(await completeOnboarding(await resolveActor(req, { mutating: true }))) }) } catch (e) { return errorResponse(e) }
}
