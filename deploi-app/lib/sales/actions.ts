'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '../auth'
import { withUser } from '../db'
import { isStage, advances, type Stage } from './stages'
import { parseCsv, applyMapping, importRows, guessMapping, IMPORT_FIELDS, type Mapping } from './csv'

export async function setStage(prospectId: string, stage: string) {
  const session = await requireRole('staff')
  if (!isStage(stage)) throw new Error('invalid stage')
  await withUser(session, async db => {
    await db.query('update prospects set stage = $2 where id = $1', [prospectId, stage])
    if (stage === 'build_sold') {
      // Section 5 credit rule: the assessment fee is credited toward a build sold inside the 60-day window.
      await db.query(
        `update agencies set assessment_credit_applied_at = now()
         where id = (select agency_id from prospects where id = $1)
           and assessment_credit_cents > 0 and assessment_credit_applied_at is null
           and (assessment_credit_expires_at is null or assessment_credit_expires_at >= now())`, [prospectId])
    }
  }, { ip: await requestIp() })
  revalidatePath('/staff/pipeline')
  revalidatePath(`/staff/pipeline/${prospectId}`)
  return { ok: true }
}

export async function setStageForm(formData: FormData) {
  const id = String(formData.get('id') ?? '')
  const stage = String(formData.get('stage') ?? '')
  await setStage(id, stage)
  const back = String(formData.get('back') ?? '') || `/staff/pipeline/${id}`
  redirect(back)
}

export type LogCallInput = { outcome: 'held' | 'no_answer' | 'voicemail' | 'rescheduled'; biggest_leak?: string; next_step?: string; follow_up_at?: string; notes?: string }

export async function logCall(prospectId: string, input: LogCallInput) {
  const session = await requireRole('staff')
  const outcome = input.outcome
  if (!['held', 'no_answer', 'voicemail', 'rescheduled'].includes(outcome)) throw new Error('invalid outcome')
  const leak = input.biggest_leak?.trim() || null
  const next = input.next_step?.trim() || null
  const follow = input.follow_up_at?.trim() || null
  await withUser(session, async db => {
    const body = [outcome === 'held' ? 'Call held.' : outcome === 'no_answer' ? 'No answer.' : outcome === 'voicemail' ? 'Left voicemail.' : 'Rescheduled.',
      leak ? `Biggest leak: ${leak}` : null, next ? `Next: ${next}` : null, input.notes?.trim() || null].filter(Boolean).join(' ')
    await db.query(`insert into touches (prospect_id, channel, direction, subject, body, meta) values ($1,'call','outbound',$2,$3,$4)`,
      [prospectId, outcome === 'held' ? 'Discovery call' : 'Call attempt', body, JSON.stringify({ outcome, biggest_leak: leak, next_step: next, follow_up_at: follow })])
    const cur = await db.one<{ stage: Stage }>('select stage from prospects where id = $1', [prospectId])
    const stage: Stage | null = outcome === 'held' && cur && advances(cur.stage, 'call_held') ? 'call_held' : null
    await db.query(
      `update prospects set biggest_leak = coalesce($2, biggest_leak), next_step = coalesce($3, next_step), follow_up_at = coalesce($4::date, follow_up_at), stage = coalesce($5::prospect_stage, stage) where id = $1`,
      [prospectId, leak, next, follow, stage])
  }, { ip: await requestIp() })
  revalidatePath(`/staff/pipeline/${prospectId}`)
  revalidatePath('/staff/pipeline')
  revalidatePath('/staff/conversations')
  return { ok: true }
}

export async function logCallForm(formData: FormData) {
  const id = String(formData.get('id') ?? '')
  await logCall(id, {
    outcome: String(formData.get('outcome') ?? '') as LogCallInput['outcome'],
    biggest_leak: String(formData.get('biggest_leak') ?? ''),
    next_step: String(formData.get('next_step') ?? ''),
    follow_up_at: String(formData.get('follow_up_at') ?? ''),
    notes: String(formData.get('notes') ?? ''),
  })
  redirect(`/staff/pipeline/${id}?logged=1`)
}

export type ImportPreview = { step: 'map'; csvText: string; headers: string[]; sample: Record<string, string>[]; total: number; mapping: Mapping; error?: string }
export type ImportDone = { step: 'done'; imported: number; skipped: number; rejected: number }
export type ImportState = { step: 'upload'; error?: string } | ImportPreview | ImportDone

export async function importStep(_prev: ImportState, formData: FormData): Promise<ImportState> {
  await requireRole('staff')
  const step = String(formData.get('step') ?? 'upload')
  if (step === 'upload') {
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) return { step: 'upload', error: 'Choose a CSV file.' }
    if (file.size > 5 * 1024 * 1024) return { step: 'upload', error: 'CSV must be under 5 MB.' }
    const csvText = await file.text()
    const { headers, rows } = parseCsv(csvText)
    if (!headers.length || !rows.length) return { step: 'upload', error: 'No rows found in that CSV.' }
    return { step: 'map', csvText, headers, sample: rows.slice(0, 3), total: rows.length, mapping: guessMapping(headers) }
  }
  const csvText = String(formData.get('csvText') ?? '')
  const mapping: Mapping = {}
  for (const f of IMPORT_FIELDS) { const h = String(formData.get(`map_${f}`) ?? ''); if (h) mapping[f] = h }
  const { headers, rows } = parseCsv(csvText)
  if (!mapping.agency_name) return { step: 'map', csvText, headers, sample: rows.slice(0, 3), total: rows.length, mapping, error: 'Map the agency name column.' }
  const { rows: mapped, rejected } = applyMapping(rows, mapping, String(formData.get('source') ?? '') || 'csv')
  const session = await requireRole('staff')
  const res = await withUser(session, db => importRows(db, mapped), { ip: await requestIp() })
  revalidatePath('/staff/pipeline')
  return { step: 'done', imported: res.imported, skipped: res.skipped + rejected, rejected }
}
