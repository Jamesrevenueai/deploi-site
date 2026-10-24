import { NextResponse } from 'next/server'
import { isImportKind, templateCsv } from './index'

/** CSV template response for an import kind; 404 for an unknown kind. Kept out of the route file (routes may only export handlers). */
export function templateResponse(kind: string): NextResponse {
  if (!isImportKind(kind)) return NextResponse.json({ ok: false, error: 'unknown import kind' }, { status: 404 })
  return new NextResponse(templateCsv(kind), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="deploi-${kind}-template.csv"`, 'cache-control': 'no-store' },
  })
}
