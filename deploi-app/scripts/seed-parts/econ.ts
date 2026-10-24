/**
 * Econ seed: synthetic internal rates, a few labor/cost/revenue rows for Buckeye (one mock revenue row to
 * prove it is excluded from collected revenue) and two service tickets. Idempotent (deterministic ids).
 */
import { uuidFrom } from '../../lib/ids'
import type { SeedPart } from './index'

const d = (daysAgo: number) => { const x = new Date(); x.setDate(x.getDate() - daysAgo); return x.toISOString().slice(0, 10) }

export const seedArea: SeedPart = async ({ c, agencyA, counts }) => {
  const staff = uuidFrom('user:hello')
  // rates: insert defaults only (never overwrite an edited rate)
  for (const [key, label] of [['assessment_labor', 'Assessment labor'], ['build_labor', 'Build labor'], ['review_labor', 'Review labor'], ['support_labor', 'Support labor'], ['troubleshooting_labor', 'Troubleshooting labor']]) {
    await c.query('insert into internal_rates (key, label, hourly_cents) values ($1, $2, 8500) on conflict (key) do nothing', [key, label])
  }
  const eng = uuidFrom('engagement:buckeye:referral_response') // matches the engage seed when it exists; otherwise a plain reference
  const labor = [
    { id: uuidFrom('labor:0'), agency_id: agencyA, ref_type: 'engagement', ref_id: eng, kind: 'build', hours: 12.5, note: 'Referral inbox + templates configured', logged_on: d(20) },
    { id: uuidFrom('labor:1'), agency_id: agencyA, ref_type: 'agency', ref_id: null, kind: 'review', hours: 3.25, note: 'Daily proposal review', logged_on: d(3) },
    { id: uuidFrom('labor:2'), agency_id: agencyA, ref_type: 'agency', ref_id: null, kind: 'support', hours: 1.5, note: 'Import question', logged_on: d(2) },
    { id: uuidFrom('labor:3'), agency_id: agencyA, ref_type: 'agency', ref_id: null, kind: 'troubleshooting', hours: 0.75, note: 'CSV header mismatch', logged_on: d(1) },
    { id: uuidFrom('labor:4'), agency_id: agencyA, ref_type: 'assessment', ref_id: uuidFrom('assessment:buckeye'), kind: 'assessment', hours: 6, note: 'Traces and report', logged_on: d(40) },
  ]
  for (const l of labor) await c.query(
    `insert into labor_entries (id, agency_id, ref_type, ref_id, kind, hours, note, logged_by, logged_on) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set hours = excluded.hours, kind = excluded.kind, logged_on = excluded.logged_on, note = excluded.note`,
    [l.id, l.agency_id, l.ref_type, l.ref_id, l.kind, l.hours, l.note, staff, l.logged_on])
  const costs = [
    { id: uuidFrom('cost:0'), agency_id: agencyA, ref_type: 'agency', ref_id: null, kind: 'hosting', amount_cents: 2500, note: 'Share of hosting', incurred_on: d(2) },
    { id: uuidFrom('cost:1'), agency_id: agencyA, ref_type: 'agency', ref_id: null, kind: 'model_usage', amount_cents: 1800, note: 'Model calls', incurred_on: d(2) },
    { id: uuidFrom('cost:2'), agency_id: agencyA, ref_type: 'engagement', ref_id: eng, kind: 'third_party', amount_cents: 4000, note: 'Inbox forwarding tool', incurred_on: d(20) },
    { id: uuidFrom('cost:3'), agency_id: agencyA, ref_type: 'agency', ref_id: null, kind: 'credit', amount_cents: -500, note: 'Vendor credit', incurred_on: d(1) },
  ]
  for (const x of costs) await c.query(
    `insert into cost_entries (id, agency_id, ref_type, ref_id, kind, amount_cents, note, incurred_on, logged_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set amount_cents = excluded.amount_cents, kind = excluded.kind, incurred_on = excluded.incurred_on, note = excluded.note`,
    [x.id, x.agency_id, x.ref_type, x.ref_id, x.kind, x.amount_cents, x.note, x.incurred_on, staff])
  const revenue = [
    { id: uuidFrom('rev:0'), ref_type: 'assessment', ref_id: uuidFrom('assessment:buckeye'), kind: 'assessment_fee', amount_cents: 150000, status: 'collected', is_mock: false, collected_on: d(35), note: 'Assessment fee' },
    { id: uuidFrom('rev:1'), ref_type: 'engagement', ref_id: eng, kind: 'setup_fee', amount_cents: 300000, status: 'collected', is_mock: false, collected_on: d(18), note: 'Build fee' },
    { id: uuidFrom('rev:2'), ref_type: 'engagement', ref_id: eng, kind: 'monthly_fee', amount_cents: 75000, status: 'collected', is_mock: false, collected_on: d(2), note: 'Month 1 management fee' },
    { id: uuidFrom('rev:3'), ref_type: 'engagement', ref_id: eng, kind: 'monthly_fee', amount_cents: 75000, status: 'projected', is_mock: false, collected_on: null, note: 'Month 2 (projected)' },
    { id: uuidFrom('rev:4'), ref_type: 'agency', ref_id: null, kind: 'other', amount_cents: 99900, status: 'mock', is_mock: true, collected_on: d(1), note: 'MOCK demo payment: must never count as collected' },
  ]
  for (const r of revenue) await c.query(
    `insert into revenue_entries (id, agency_id, ref_type, ref_id, kind, amount_cents, status, is_mock, collected_on, note, logged_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set amount_cents = excluded.amount_cents, status = excluded.status, is_mock = excluded.is_mock, collected_on = excluded.collected_on, note = excluded.note`,
    [r.id, agencyA, r.ref_type, r.ref_id, r.kind, r.amount_cents, r.status, r.is_mock, r.collected_on, r.note, staff])
  const tickets = [
    { id: uuidFrom('ticket:0'), title: 'EVV import rejects the new Sandata column order', detail: 'Export from the vendor changed its header order; the mapping preset needs an update.', severity: 'high', classification: 'defect', owner: 'Deploi Staff', status: 'in_progress', next_action: 'Update the Sandata preset and re-run the staged import', resolution: null },
    { id: uuidFrom('ticket:1'), title: 'Add a second approver for referral replies', detail: 'Agency asks for a backup approver while the scheduler is on leave.', severity: 'medium', classification: 'support_request', owner: null, status: 'open', next_action: 'Confirm who the backup approver is', resolution: null },
  ]
  for (const t of tickets) await c.query(
    `insert into service_tickets (id, agency_id, engagement_ref, title, detail, severity, classification, owner, status, next_action, resolution, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (id) do update set title = excluded.title, detail = excluded.detail, severity = excluded.severity, classification = excluded.classification, owner = excluded.owner, status = excluded.status, next_action = excluded.next_action, resolution = excluded.resolution, resolved_at = null`,
    [t.id, agencyA, eng, t.title, t.detail, t.severity, t.classification, t.owner, t.status, t.next_action, t.resolution, staff])
  counts.econ_labor = labor.length; counts.econ_costs = costs.length; counts.econ_revenue = revenue.length; counts.service_tickets = tickets.length
}
