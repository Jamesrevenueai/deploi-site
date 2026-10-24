'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { log } from '@/lib/log'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const optInt = (v: string) => (v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN)

/** Create or update one EVV rule set. Staff only; the row is written as the signed-in user so RLS and audit apply. */
export async function saveRuleSet(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const id = str(formData, 'id')
  const agencyId = str(formData, 'agency_id') || null
  const jurisdiction = str(formData, 'jurisdiction').toUpperCase()
  const program = str(formData, 'program') || null
  const payer = str(formData, 'payer') || null
  const effectiveFrom = str(formData, 'effective_from') || null
  const effectiveTo = str(formData, 'effective_to') || null
  const windowDays = optInt(str(formData, 'correction_window_days'))
  const unitMinutes = optInt(str(formData, 'unit_minutes')) ?? 15
  const rounding = str(formData, 'unit_rounding')
  const tolerance = optInt(str(formData, 'duration_tolerance_min')) ?? 15
  const sourceName = str(formData, 'source_name') || null
  const sourceUrl = str(formData, 'source_url') || null
  const sourceVersion = str(formData, 'source_version') || null
  const verified = formData.get('verified') === 'on'
  const notes = str(formData, 'notes') || null
  const back = `/staff/evv/rules${id ? `?edit=${id}` : ''}`
  if (!/^[A-Z]{2}$/.test(jurisdiction)) redirect(`${back}${id ? '&' : '?'}error=jurisdiction-must-be-a-two-letter-state`)
  if (Number.isNaN(windowDays) || (windowDays != null && windowDays < 0)) redirect(`${back}${id ? '&' : '?'}error=correction-window-must-be-a-whole-number-of-days-or-blank`)
  if (!Number.isInteger(unitMinutes) || unitMinutes <= 0) redirect(`${back}${id ? '&' : '?'}error=unit-minutes-must-be-positive`)
  if (!['nearest', 'down', 'up'].includes(rounding)) redirect(`${back}${id ? '&' : '?'}error=rounding-must-be-nearest-down-or-up`)
  if (!Number.isInteger(tolerance) || tolerance < 0) redirect(`${back}${id ? '&' : '?'}error=tolerance-must-be-zero-or-more`)
  if (verified && !sourceName) redirect(`${back}${id ? '&' : '?'}error=a-verified-rule-needs-a-source-name`)
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) redirect(`${back}${id ? '&' : '?'}error=effective-to-is-before-effective-from`)

  const params = [agencyId, program, payer, jurisdiction, effectiveFrom, effectiveTo, windowDays, unitMinutes, rounding, tolerance, sourceName, sourceUrl, sourceVersion, verified, notes]
  const saved = await withUser(session, async db => {
    if (id) {
      const r = await db.one<{ id: string }>(
        `update evv_rule_sets set agency_id = $2, program = $3, payer = $4, jurisdiction = $5, effective_from = $6, effective_to = $7, correction_window_days = $8, unit_minutes = $9, unit_rounding = $10,
           duration_tolerance_min = $11, source_name = $12, source_url = $13, source_version = $14, verified = $15, notes = $16 where id = $1 returning id`, [id, ...params])
      return r?.id ?? null
    }
    const r = await db.one<{ id: string }>(
      `insert into evv_rule_sets (agency_id, program, payer, jurisdiction, effective_from, effective_to, correction_window_days, unit_minutes, unit_rounding, duration_tolerance_min, source_name, source_url, source_version, verified, notes, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`, [...params, session.uid])
    return r?.id ?? null
  }, { ip })
  log.info('evv.rule_set.saved', { id: saved, agency_id: agencyId, jurisdiction, verified })
  revalidatePath('/staff/evv'); revalidatePath('/staff/evv/rules'); revalidatePath('/app/evv')
  redirect(`/staff/evv/rules?saved=${saved ?? ''}`)
}

export async function deleteRuleSet(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  await withUser(session, db => db.query('delete from evv_rule_sets where id = $1', [id]), { ip: await requestIp() })
  log.info('evv.rule_set.deleted', { id })
  revalidatePath('/staff/evv'); revalidatePath('/staff/evv/rules')
  redirect('/staff/evv/rules?deleted=1')
}
