'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { log } from '@/lib/log'
import { saveRate } from '@/lib/economics/queries'
import { RATE_KEYS, LABOR_KINDS, COST_KINDS, REVENUE_KINDS, REVENUE_STATUSES, REF_TYPES, type RateKey } from '@/lib/economics/calc'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const oneOf = <T extends readonly string[]>(list: T, v: string): T[number] | null => ((list as readonly string[]).includes(v) ? (v as T[number]) : null)
const uuid = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : null)
const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
/** dollars text ("85", "85.50", "-12") -> integer cents; null when not a number */
const cents = (v: string) => { const n = Number(v.replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null }

export async function saveRates(formData: FormData) {
  const session = await requireRole('staff')
  const updates: [RateKey, number][] = []
  for (const key of RATE_KEYS) {
    const v = str(formData, `rate_${key}`)
    if (!v) continue
    const c = cents(v)
    if (c === null || c < 0) redirect(`/staff/economics/rates?error=${key.replace(/_/g, '-')}-must-be-a-non-negative-amount`)
    updates.push([key, c])
  }
  await withUser(session, async db => { for (const [k, c] of updates) await saveRate(db, k, c, session.uid) }, { ip: await requestIp() })
  log.info('economics.rates.saved', { count: updates.length })
  revalidatePath('/staff/economics')
  redirect('/staff/economics/rates?saved=1')
}

export async function logLabor(formData: FormData) {
  const session = await requireRole('staff')
  const kind = oneOf(LABOR_KINDS, str(formData, 'kind'))
  const refType = oneOf(REF_TYPES, str(formData, 'ref_type')) ?? 'general'
  const hours = Number(str(formData, 'hours'))
  const agencyId = uuid(str(formData, 'agency_id'))
  const loggedOn = date(str(formData, 'logged_on')) ?? new Date().toISOString().slice(0, 10)
  if (!kind) redirect('/staff/economics/log?error=labor-kind-required')
  if (!Number.isFinite(hours) || hours <= 0 || hours > 999) redirect('/staff/economics/log?error=hours-must-be-between-0-and-999')
  await withUser(session, db => db.query(
    'insert into labor_entries (agency_id, ref_type, ref_id, kind, hours, note, logged_by, logged_on) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [agencyId, refType, str(formData, 'ref_id') || null, kind, hours, str(formData, 'note') || null, session.uid, loggedOn]), { ip: await requestIp() })
  log.info('economics.labor.logged', { kind, hours, agencyId })
  revalidatePath('/staff/economics')
  redirect('/staff/economics/log?saved=labor')
}

export async function logCost(formData: FormData) {
  const session = await requireRole('staff')
  const kind = oneOf(COST_KINDS, str(formData, 'kind'))
  const refType = oneOf(REF_TYPES, str(formData, 'ref_type')) ?? 'general'
  const agencyId = uuid(str(formData, 'agency_id'))
  const incurredOn = date(str(formData, 'incurred_on')) ?? new Date().toISOString().slice(0, 10)
  let amount = cents(str(formData, 'amount'))
  if (!kind) redirect('/staff/economics/log?error=cost-kind-required')
  if (amount === null || amount === 0) redirect('/staff/economics/log?error=amount-required')
  // credits and refunds reduce cost: stored negative whatever sign was typed
  if (kind === 'credit' || kind === 'refund') amount = -Math.abs(amount)
  else amount = Math.abs(amount)
  await withUser(session, db => db.query(
    'insert into cost_entries (agency_id, ref_type, ref_id, kind, amount_cents, note, incurred_on, logged_by) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [agencyId, refType, str(formData, 'ref_id') || null, kind, amount, str(formData, 'note') || null, incurredOn, session.uid]), { ip: await requestIp() })
  log.info('economics.cost.logged', { kind, amount, agencyId })
  revalidatePath('/staff/economics')
  redirect('/staff/economics/log?saved=cost')
}

export async function logRevenue(formData: FormData) {
  const session = await requireRole('staff')
  const kind = oneOf(REVENUE_KINDS, str(formData, 'kind'))
  const refType = oneOf(REF_TYPES, str(formData, 'ref_type')) ?? 'agency'
  const agencyId = uuid(str(formData, 'agency_id'))
  const isMock = formData.get('is_mock') === 'on'
  let status = oneOf(REVENUE_STATUSES, str(formData, 'status')) ?? 'projected'
  if (isMock) status = 'mock'
  const amount = cents(str(formData, 'amount'))
  const collectedOn = status === 'collected' ? (date(str(formData, 'collected_on')) ?? new Date().toISOString().slice(0, 10)) : date(str(formData, 'collected_on'))
  if (!kind) redirect('/staff/economics/log?error=revenue-kind-required')
  if (!agencyId) redirect('/staff/economics/log?error=agency-required')
  if (amount === null || amount <= 0) redirect('/staff/economics/log?error=amount-must-be-positive')
  await withUser(session, db => db.query(
    'insert into revenue_entries (agency_id, ref_type, ref_id, kind, amount_cents, status, is_mock, collected_on, note, logged_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [agencyId, refType, str(formData, 'ref_id') || null, kind, amount, status, isMock || status === 'mock', collectedOn, str(formData, 'note') || null, session.uid]), { ip: await requestIp() })
  log.info('economics.revenue.logged', { kind, amount, status, mock: isMock, agencyId })
  revalidatePath('/staff/economics')
  redirect('/staff/economics/log?saved=revenue')
}
