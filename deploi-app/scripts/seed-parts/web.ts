/**
 * Web stream seed (phase 16): two synthetic Website Improvement leads with their engagements.
 *  - Riverbend Family Dental: status improving, two labor rows, transition history.
 *  - Hilltop Physical Therapy: status inquiry (fresh lead from the site form).
 * Idempotent (deterministic ids). Synthetic practices only; no real sites, people or passwords.
 */
import type { SeedCtx } from './index'
import { uuidFrom } from '../../lib/ids'
import { targetDate } from '../../lib/website/states'

type Row = Record<string, unknown>
async function upsert(c: SeedCtx['c'], table: string, rows: Row[]) {
  for (const row of rows) {
    const cols = Object.keys(row)
    const updates = cols.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(',')
    await c.query(`insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) on conflict (id) do update set ${updates}`, cols.map(k => row[k]))
  }
  return rows.length
}
const daysAgo = (d: number, h = 10) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, 0, 0, 0); return x.toISOString() }

export async function seedArea({ c, counts }: SeedCtx) {
  const P_IMPROVING = uuidFrom('prospect:web-riverbend')
  const P_INQUIRY = uuidFrom('prospect:web-hilltop')
  counts.web_prospects = await upsert(c, 'prospects', [
    { id: P_IMPROVING, agency_name: 'Riverbend Family Dental', owner_name: 'Noor Haddad', email: 'noor@riverbendfamilydental.example', phone: '+16145554101',
      city: 'Columbus', county: 'Franklin', state: 'OH', programs: [], source: 'site', stage: 'contacted', owner_notes: null, email_invalid: false,
      biggest_leak: null, next_step: 'Share preview link', follow_up_at: null, agency_id: null,
      service_interest: 'website_improvement', tags: ['Website Improvement'], website_url: 'https://riverbend-dental.example',
      website_goal: 'More new-patient calls from the Services and Contact pages',
      website_details: JSON.stringify({ platform: 'WordPress', pages: ['Home', 'Services', 'Contact'], access_status: 'have_login', approval_contact: 'Noor Haddad, office manager' }) },
    { id: P_INQUIRY, agency_name: 'Hilltop Physical Therapy', owner_name: 'Sam Lindqvist', email: 'sam@hilltoppt.example', phone: '+16145554102',
      city: 'Hilliard', county: 'Franklin', state: 'OH', programs: [], source: 'site', stage: 'new', owner_notes: null, email_invalid: false,
      biggest_leak: null, next_step: null, follow_up_at: null, agency_id: null,
      service_interest: 'website_improvement', tags: ['Website Improvement'], website_url: 'https://hilltop-pt.example',
      website_goal: 'Make it obvious how to book an evaluation on mobile',
      website_details: JSON.stringify({ platform: 'Squarespace', pages: ['Home', 'Book'], access_status: 'need_to_find', approval_contact: 'Sam Lindqvist, owner' }) },
  ])
  await upsert(c, 'touches', [
    { id: uuidFrom('touch:web-riverbend:0'), prospect_id: P_IMPROVING, channel: 'site', direction: 'inbound', subject: 'Lead from site', body: 'Our Services page is hard to read on phones and nobody finds the contact form.', at: daysAgo(12), meta: JSON.stringify({ source: 'site', service_interest: 'website_improvement' }) },
    { id: uuidFrom('touch:web-hilltop:0'), prospect_id: P_INQUIRY, channel: 'site', direction: 'inbound', subject: 'Lead from site', body: 'Patients say they cannot find how to book on their phone.', at: daysAgo(1), meta: JSON.stringify({ source: 'site', service_interest: 'website_improvement' }) },
  ])

  const E_IMPROVING = uuidFrom('website_engagement:riverbend')
  const E_INQUIRY = uuidFrom('website_engagement:hilltop')
  counts.website_engagements = await upsert(c, 'website_engagements', [
    { id: E_IMPROVING, prospect_id: P_IMPROVING, agency_id: null, status: 'improving', website_url: 'https://riverbend-dental.example', platform: 'WordPress',
      goal: 'More new-patient calls from the Services and Contact pages', pages: JSON.stringify(['Home', 'Services', 'Contact']),
      requested_changes: 'Clearer services list with plain-language headings; a visible “Call” button on mobile; shorter contact form.',
      known_issues: 'Services page uses a three-column table that collapses badly on phones.',
      access_status: 'have_login', access_arrangement: 'Invited as Editor to the WordPress site (deploi delivery address); no shared credentials.',
      approval_contact: 'Noor Haddad, office manager',
      feasibility: JSON.stringify({ status: 'feasible', note: 'Standard WordPress theme; edits fit in five hours.', confirmed_at: daysAgo(9), confirmed_by: uuidFrom('user:hello') }),
      price_cents: 50000, payment_status: 'paid', payment_is_mock: false, paid_at: daysAgo(8),
      scope_confirmed_at: daysAgo(10), accepted_at: daysAgo(9),
      acceptance_evidence: JSON.stringify({ accepted_by: 'Noor Haddad', method: 'email reply', reference: 'Re: Website improvement scope (synthetic)', at: daysAgo(9), recorded_by: uuidFrom('user:hello'), payment_reference: 'INV-SYN-1042' }),
      access_received_at: daysAgo(7), content_received_at: daysAgo(7).slice(0, 10), preview_url: null, preview_ready_at: null,
      customer_approved_at: null, customer_approval_evidence: null, published_at: null, publication_verified_at: null, publication_verification: null,
      backup_plan: 'WordPress revision history on each page plus an exported copy of the three pages before editing.', rollback_note: null, handoff_summary: null,
      before_after: JSON.stringify([{ page: 'Services', before_ref: 'export/services-before.html (synthetic)', after_ref: 'draft in WordPress revisions', note: 'single-column list on mobile' }]),
      approved_changes: JSON.stringify(['Single-column services list with plain-language headings', 'Sticky “Call now” button on mobile', 'Contact form reduced to name, phone, reason']),
      revision_round: 0, revision_status: null, target_date: null, maintenance_requested: true },
    { id: E_INQUIRY, prospect_id: P_INQUIRY, agency_id: null, status: 'inquiry', website_url: 'https://hilltop-pt.example', platform: 'Squarespace',
      goal: 'Make it obvious how to book an evaluation on mobile', pages: JSON.stringify(['Home', 'Book']),
      requested_changes: 'Add a clear “Book an evaluation” path from the home page.', known_issues: 'Booking link is buried in the footer.',
      access_status: 'need_to_find', access_arrangement: null, approval_contact: 'Sam Lindqvist, owner', feasibility: JSON.stringify({ status: 'unconfirmed' }),
      price_cents: 50000, payment_status: 'unpaid', payment_is_mock: true, paid_at: null, scope_confirmed_at: null, accepted_at: null, acceptance_evidence: null,
      access_received_at: null, content_received_at: null, preview_url: null, preview_ready_at: null, customer_approved_at: null, customer_approval_evidence: null,
      published_at: null, publication_verified_at: null, publication_verification: null, backup_plan: null, rollback_note: null, handoff_summary: null,
      before_after: '[]', approved_changes: '[]', revision_round: 0, revision_status: null, target_date: null, maintenance_requested: false },
  ])
  // target date for the improving one: 5 business days after the later of paid/access/content (same function the app uses)
  await c.query('update website_engagements set target_date = $2::date where id = $1',
    [E_IMPROVING, targetDate({ paid_at: daysAgo(8), access_received_at: daysAgo(7), content_received_at: daysAgo(7).slice(0, 10) })])

  counts.website_labor = await upsert(c, 'website_labor', [
    { id: uuidFrom('website_labor:riverbend:1'), website_engagement_id: E_IMPROVING, hours: 1.0, kind: 'review', note: 'Mobile review of the three pages; notes in approved changes.', logged_by: uuidFrom('user:hello'), logged_at: daysAgo(6) },
    { id: uuidFrom('website_labor:riverbend:2'), website_engagement_id: E_IMPROVING, hours: 1.5, kind: 'implementation', note: 'Services page rebuilt as a single-column list; call button added.', logged_by: uuidFrom('user:hello'), logged_at: daysAgo(4) },
  ])
  const steps: [string | null, string, number][] = [[null, 'inquiry', 12], ['inquiry', 'scope_confirmed', 10], ['scope_confirmed', 'accepted', 9], ['accepted', 'payment_confirmed', 8], ['payment_confirmed', 'access_received', 7], ['access_received', 'improving', 6]]
  counts.website_transitions = await upsert(c, 'website_transitions', steps.map(([from, to, d], i) => ({
    id: uuidFrom(`website_transition:riverbend:${i}`), website_engagement_id: E_IMPROVING, from_status: from, to_status: to, actor_id: uuidFrom('user:hello'), at: daysAgo(d, 11), note: i === 0 ? 'Lead from site form' : null,
  })))
}
