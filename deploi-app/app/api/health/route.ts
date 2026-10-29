import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
export async function GET() {
  return NextResponse.json({ ok: true, auth: env.authMode, email: env.resendKey ? 'resend' : 'mock' })
}
