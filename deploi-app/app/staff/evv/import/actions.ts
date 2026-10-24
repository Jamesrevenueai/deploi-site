'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { ingestVisits, summarize } from '@/lib/evv/ingest'
import { detectMapping, normalizeRow, missingRequired, SANDATA_PRESET, FIELDS, type Mapping } from '@/lib/evv/mappers'
import { parseCsv, fileSha256, findPriorImport, recordAlreadyImported, trimErrors, type RowError } from '@/lib/imports'
import { log } from '@/lib/log'
import type { VisitInput } from '@/lib/evv/types'
import { isBaaSigned } from '@/lib/baa/gate'

const MAX_ROWS = 20000

/** Step 1: parse the upload, hash it, auto-map, and stage it for review. Identical content to a committed import is refused with a notice. */
export async function stageImport(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const agencyId = String(formData.get('agency') ?? '')
  const source = String(formData.get('source') ?? 'generic') === 'sandata' ? 'sandata' : 'generic'
  const file = formData.get('file')
  if (!agencyId || !(file instanceof File) || file.size === 0) redirect(`/staff/evv/import?agency=${agencyId}&error=file-required`)
  const text = await file.text()
  const { headers, rows } = parseCsv(text)
  if (!headers.length || !rows.length) redirect(`/staff/evv/import?agency=${agencyId}&error=empty-csv`)
  const mapping = detectMapping(headers, source === 'sandata' ? SANDATA_PRESET : undefined)
  const signed = await withUser(session, db => isBaaSigned(db, agencyId), { ip })
  if (!signed) redirect(`/staff/evv/import?agency=${agencyId}&error=baa-not-signed`)
  const sha = fileSha256(text)
  const outcome = await withUser(session, async db => {
    const prior = await findPriorImport(db, 'evv_visits', agencyId, sha)
    if (prior) {
      const id = await recordAlreadyImported(db, 'evv_visits', agencyId, { filename: file.name.slice(0, 200), sha, rowCount: rows.length, createdBy: session.uid, priorId: prior.id })
      return { already: true as const, id, priorAt: prior.created_at }
    }
    const r = await db.one<{ id: string }>(
      `insert into evv_imports (agency_id, source, filename, status, headers, mapping, raw, row_count, file_sha256, created_by)
       values ($1,$2,$3,'staged',$4,$5,$6,$7,$8,$9) returning id`,
      [agencyId, source, file.name.slice(0, 200), JSON.stringify(headers), JSON.stringify(mapping), JSON.stringify(rows.slice(0, MAX_ROWS)), Math.min(rows.length, MAX_ROWS), sha, session.uid])
    return { already: false as const, id: r!.id }
  }, { ip })
  if (outcome.already) {
    log.info('evv.import.already_imported', { id: outcome.id, agencyId })
    redirect(`/staff/evv/import?agency=${agencyId}&already=${encodeURIComponent(outcome.priorAt.slice(0, 10))}`)
  }
  log.info('evv.import.staged', { id: outcome.id, agencyId, rows: rows.length, source })
  redirect(`/staff/evv/import?agency=${agencyId}&id=${outcome.id}`)
}

/** Step 2: apply the (possibly corrected) mapping and write visits + exceptions; row errors and revisions are recorded on the import. */
export async function commitImport(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const id = String(formData.get('id') ?? '')
  const mapping: Mapping = {}
  for (const f of FIELDS) { const v = String(formData.get(`map_${f}`) ?? ''); if (v) mapping[f] = v }
  const missing = missingRequired(mapping)
  const staged = await withUser(session, db => db.one<{ agency_id: string; source: 'sandata' | 'generic'; raw: Record<string, string>[]; state: string; timezone: string }>(
    `select i.agency_id, i.source, i.raw, g.state, g.timezone from evv_imports i join agencies g on g.id = i.agency_id where i.id = $1 and i.status = 'staged'`, [id]), { ip })
  if (!staged) redirect('/staff/evv/import?error=import-not-found')
  if (missing.length) redirect(`/staff/evv/import?agency=${staged.agency_id}&id=${id}&error=map-${missing.join('-')}`)
  if (!(await withUser(session, db => isBaaSigned(db, staged.agency_id), { ip }))) redirect(`/staff/evv/import?agency=${staged.agency_id}&id=${id}&error=baa-not-signed`)

  const inputs: VisitInput[] = []
  const rowErrors: RowError[] = []
  staged.raw.forEach((r, i) => {
    const n = normalizeRow(r, mapping, staged.timezone)
    if (n) inputs.push({ ...n, row: i + 1 })
    else {
      const k = mapping.vendor_visit_key ? (r[mapping.vendor_visit_key] ?? '').trim() : ''
      rowErrors.push({ row: i + 1, field: k ? 'service_code' : 'vendor_visit_key', message: k ? 'service code is required' : 'visit key is required' })
    }
  })
  const counts = await withUser(session, async db => {
    const c = await ingestVisits(db, staged.agency_id, inputs, { source: staged.source, state: staged.state, importId: id })
    c.rows = staged.raw.length; c.skipped += rowErrors.length
    c.errors = [...rowErrors, ...c.errors].sort((a, b) => a.row - b.row)
    await db.query(`update evv_imports set status = 'committed', mapping = $2, imported = $3, updated = $4, exceptions_opened = $5, duplicates = $6, skipped = $7, row_errors = $8, raw = '[]'::jsonb, committed_at = now() where id = $1`,
      [id, JSON.stringify(mapping), c.imported, c.updated, c.exceptionsOpened, c.duplicates, c.skipped, JSON.stringify(trimErrors(c.errors))])
    return c
  }, { ip })
  log.info('evv.import.committed', { id, ...counts, errors: counts.errors.length })
  revalidatePath('/staff/evv'); revalidatePath('/app/evv'); revalidatePath('/app/home')
  redirect(`/staff/evv/import?agency=${staged.agency_id}&done=${encodeURIComponent(summarize(counts))}&report=${id}`)
}

export async function discardImport(formData: FormData) {
  const session = await requireRole('staff')
  const id = String(formData.get('id') ?? '')
  const agency = String(formData.get('agency') ?? '')
  await withUser(session, db => db.query(`update evv_imports set status = 'discarded', raw = '[]'::jsonb where id = $1 and status = 'staged'`, [id]))
  redirect(`/staff/evv/import?agency=${agency}`)
}
