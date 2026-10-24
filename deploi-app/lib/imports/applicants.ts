/**
 * Applicant CSV import on the shared toolkit: validation with row numbers, in-file and existing-record
 * duplicates (phone, then first+last name), content-hash re-import detection, provenance in `imports`.
 * Runs inside withUser(staff) so RLS and the audit trigger apply.
 */
import type { Db } from '../db'
import { log } from '../log'
import { IMPORT_SPECS } from './specs'
import { parseCsv, detectMapping, fileSha256, missingRequired, type Mapping } from './csv'
import { validateRows, type RowError } from './validate'
import { findPriorImport, recordAlreadyImported, trimErrors } from './provenance'

export type ApplicantImportResult = {
  importId: string; status: 'committed' | 'already_imported'; rowCount: number; imported: number; skipped: number; duplicates: number; errors: RowError[]; notice: string | null
}

export async function runApplicantImport(db: Db, opts: { agencyId: string; text: string; filename: string | null; createdBy: string | null; mapping?: Mapping }): Promise<ApplicantImportResult> {
  const spec = IMPORT_SPECS.applicants
  const { headers, rows } = parseCsv(opts.text)
  const sha = fileSha256(opts.text)
  const prior = await findPriorImport(db, 'applicants', opts.agencyId, sha)
  if (prior) {
    const importId = await recordAlreadyImported(db, 'applicants', opts.agencyId, { filename: opts.filename, sha, rowCount: rows.length, createdBy: opts.createdBy, priorId: prior.id })
    log.info('applicants.import.already', { agency_id: opts.agencyId, import_id: importId, prior_id: prior.id })
    return { importId, status: 'already_imported', rowCount: rows.length, imported: 0, skipped: rows.length, duplicates: 0, errors: [], notice: `already imported on ${prior.created_at.slice(0, 10)}` }
  }
  const mapping = opts.mapping ?? detectMapping(spec, headers)
  const errors: RowError[] = []
  for (const f of missingRequired(spec, mapping)) errors.push({ row: 0, field: f, message: `no column maps to required field ${f}` })
  const v = errors.length ? { valid: [], errors: [], duplicatesInFile: 0 } : validateRows(spec, rows, mapping)
  errors.push(...v.errors)
  let imported = 0, duplicates = v.duplicatesInFile
  const importRow = await db.one<{ id: string }>(
    `insert into imports (agency_id, kind, source, filename, status, headers, mapping, row_count, file_sha256, created_by) values ($1,'applicants','csv',$2,'staged',$3,$4,$5,$6,$7) returning id`,
    [opts.agencyId, opts.filename, JSON.stringify(headers), JSON.stringify(mapping), rows.length, sha, opts.createdBy])
  const importId = importRow!.id
  for (const r of v.valid) {
    const val = r.values
    const phone = (val.phone as string | null) ?? null
    const dup = phone
      ? await db.one('select id from applicants where agency_id = $1 and phone = $2', [opts.agencyId, phone])
      : await db.one('select id from applicants where agency_id = $1 and lower(first_name) = lower($2) and lower(last_name) = lower($3)', [opts.agencyId, val.first_name, val.last_name])
    if (dup) { duplicates++; errors.push({ row: r.row, field: phone ? 'phone' : 'last_name', message: `already on file (${phone ? 'same phone' : 'same name'}), skipped` }); continue }
    await db.query(
      `insert into applicants (agency_id, first_name, last_name, phone, email, applied_at, source, status, import_id) values ($1,$2,$3,$4,$5,coalesce($6::date, current_date),$7,'new',$8)`,
      [opts.agencyId, val.first_name, val.last_name, phone, val.email ?? null, val.applied_at ?? null, (val.source as string | null) || 'csv', importId])
    imported++
  }
  const skipped = rows.length - imported
  errors.sort((a, b) => a.row - b.row)
  await db.query(`update imports set status = 'committed', imported = $2, skipped = $3, duplicates = $4, row_errors = $5, committed_at = now() where id = $1`,
    [importId, imported, skipped, duplicates, JSON.stringify(trimErrors(errors))])
  log.info('applicants.imported', { agency_id: opts.agencyId, import_id: importId, rows: rows.length, imported, skipped, duplicates, errors: errors.length })
  return { importId, status: 'committed', rowCount: rows.length, imported, skipped, duplicates, errors, notice: null }
}
