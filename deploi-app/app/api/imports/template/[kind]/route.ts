/** Downloadable CSV template per import kind (staff only). Headers are the documented fields in lib/imports/specs.ts. */
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { templateResponse } from '@/lib/imports/template-response'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const session = await getSession()
  if (!session || session.role !== 'staff') return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { kind } = await ctx.params
  return templateResponse(kind)
}
