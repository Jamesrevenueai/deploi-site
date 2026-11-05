/**
 * Everything Deploi can hold about one Shopify shopper, inside one shop's organization, and how a
 * `customers/data_request` exports it and a `customers/redact` erases it (lib/connectors/shopify/compliance.ts).
 *
 * The customer is matched on the email address in Shopify's payload (any case) and on the Shopify customer id
 * (`gid://shopify/Customer/<id>`) and order ids (`gid://shopify/Order/<id>`) wherever a record carries them,
 * always within the shop's own organization: another organization's rows are never read or changed.
 *
 * PRIVACY_COVERAGE names every table that can hold a shopper's data and what each step does with it;
 * PRIVACY_EXEMPT names every other table with a column that looks like personal data, and why it is not
 * shopper data. tests/privacy/coverage.test.ts fails when a new table with an email, address, customer,
 * recipient, phone or contact column is in neither list.
 *
 * Erasure deletes what is only about the customer (their mail), anonymizes what the business must keep
 * (accounting copies, opt-outs, case history, CRM work), and keeps the tamper-evident audit trail as it is:
 * that trail holds record ids, never addresses or message content, and is retained for audit.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db'
import { decryptSecret } from '../connectors/credentials'

export type Subject = { orgId: string; email: string | null; customerId: string | null; orderIds: string[] }
export type TableStep = { export: string; redact: string }

export const PRIVACY_COVERAGE: Record<string, TableStep> = {
  email_messages: { export: 'agent mail sent to, copied to or sent from the address, with its decrypted subject and text', redact: 'deleted' },
  email_inbound: { export: 'mail received from the address (or addressed to it), with its decrypted subject and text', redact: 'deleted' },
  email_suppressions: { export: 'that the address is suppressed (bounced, complained, unsubscribed), and since when', redact: 'kept as a one-way hash so the opt-out is still honoured' },
  email_thread_state: { export: 'nothing of its own: keyed by message id (the messages are exported)', redact: 'nothing to erase: removed with nothing but ids left' },
  office_leads: { export: 'the lead row for that address (name, company, status, touches)', redact: 'anonymized: address replaced by a hash, name and company removed, follow-up stopped' },
  office_meetings: { export: 'meetings with that address as the contact', redact: 'anonymized: contact address replaced by a hash' },
  office_invoices: { export: 'invoices billed to that address', redact: 'anonymized: billing address and customer name removed; amounts and dates kept for the accounts' },
  office_actions: { export: 'Office actions whose content names the customer', redact: 'the address and ids erased from the content; waiting actions cancelled' },
  library_actions: { export: 'agent library drafts and reports that name the customer, their customer id or their orders', redact: 'the address and ids erased from the content; waiting drafts withdrawn' },
  library_chat_messages: { export: 'chat messages to library agents that name the customer', redact: 'the address and ids erased from the text' },
  cases: { export: 'Resolution Engine cases whose text, evidence or records name the customer', redact: 'the address and ids erased from the text, evidence and records' },
  case_events: { export: 'case history entries that name the customer', redact: 'the address and ids erased from the summary and detail (the only change ever allowed to case history)' },
  engine_audit: { export: 'the number of audit entries that name the customer (expected none: entries hold record ids)', redact: 'kept unchanged: the tamper-evident audit trail is retained for audit; it holds record ids, not addresses or content' },
}

/** Tables with a personal-looking column that never hold a Shopify shopper's data, and why. */
export const PRIVACY_EXEMPT: Record<string, string> = {
  profiles: 'the merchant\'s own users (sign-in accounts), not shoppers',
  billing_customers: 'the merchant\'s own Stripe billing customer (the business paying Deploi), never a shopper',
  billing_trials: 'the merchant\'s own trial record (an e-mail hash for one trial per business), never a shopper',
  billing_notices: 'billing notices sent to the merchant\'s owner about Deploi\'s own invoices, never to a shopper',
  invites: 'invitations to the merchant\'s own team',
  legal_acceptances: 'the merchant users who accepted the terms (append-only legal evidence)',
  email_accounts: 'the agent mailboxes and connected merchant mailboxes themselves',
  billing_subscriptions: 'the merchant\'s own billing customer at the payment provider',
  weekly_summaries: 'the merchant\'s own report recipients',
  purchase_orders: 'suppliers named on purchase orders the merchant imported (business contacts, never shoppers)',
  supplier_requests: 'the supplier a restock request went to (business contact, never a shopper)',
  prospects: 'Deploi\'s own sales prospects (agencies), unrelated to any shop',
  referrals: 'the retired home-care agency product (no Shopify shop)',
  aides: 'the retired home-care agency product (no Shopify shop)',
  applicants: 'the retired home-care agency product (no Shopify shop)',
  clients: 'the retired home-care agency product (no Shopify shop)',
  engagements: 'the retired consulting product\'s agency contacts (no Shopify shop)',
}

/** Column names that look like personal data (the coverage test reads the catalog with this). */
export const PERSONAL_COLUMN = /(email|address|customer|recipient|phone|contact|attendee|shopper|first_name|last_name|full_name)/i

const bare = (a: string) => a.trim().toLowerCase()
/** One-way hash of an address within one organization (kept where the business must still recognise it). */
export const addressHash = (orgId: string, email: string) => createHash('sha256').update(`${orgId}|${bare(email)}`).digest('hex')
export const ERASED = '[erased]'

/** The literal strings that identify the customer in free text and JSON (lower case). */
export function subjectTokens(s: Subject): string[] {
  const t: string[] = []
  if (s.email) t.push(bare(s.email))
  if (s.customerId && /^\d{1,20}$/.test(s.customerId)) t.push(`gid://shopify/customer/${s.customerId}`)
  for (const o of s.orderIds) if (/^\d{1,20}$/.test(o)) t.push(`gid://shopify/order/${o}`)
  return [...new Set(t)].filter(x => x.length >= 3)
}
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** One case-insensitive pattern for every token (used by regexp_replace with the 'gi' flags). */
const tokenPattern = (tokens: string[]) => tokens.map(escapeRe).join('|')
/** SQL: does this text (a column cast to text) name any token? $N is the tokens array. */
const names = (expr: string, n: number) => `exists (select 1 from unnest($${n}::text[]) tok where position(tok in lower(${expr})) > 0)`

function decrypt(keyId: string, ciphertext: string, aad: string): unknown {
  if (!ciphertext || keyId === 'pending' || keyId === 'redacted') return null
  try { return JSON.parse(decryptSecret(keyId, ciphertext, aad)) } catch { return { unreadable: true } }
}

type Row = Record<string, unknown>
export type CustomerExport = {
  format: 'deploi.customer_data.v1'; generatedAt: string; shop: string
  subject: { email: string | null; shopifyCustomerId: string | null; orderIds: string[] }
  matching: string; tables: Record<string, Row[]>; counts: Record<string, number>; notes: string[]
}

/** Everything held for the subject in the organization, table by table (content decrypted for the customer). */
export async function collectCustomerData(db: Db, s: Subject, shop: string): Promise<CustomerExport> {
  const tokens = subjectTokens(s)
  const email = s.email ? bare(s.email) : null
  const tables: Record<string, Row[]> = {}
  const notes: string[] = []
  if (!tokens.length) return { format: 'deploi.customer_data.v1', generatedAt: new Date().toISOString(), shop, subject: { email, shopifyCustomerId: s.customerId, orderIds: s.orderIds }, matching: 'nothing to match on', tables, counts: {}, notes: ['The request named no email address, customer id or order.'] }

  const sent = email ? await db.query<Row & { id: string; key_id: string; content_ciphertext: string }>(
    `select id, created_at, task_key, status, from_address, to_addresses, cc_addresses, accepted_at, meta, key_id, content_ciphertext, body_purged_at from email_messages
     where org_id = $1 and (lower(from_address) = $2 or $2 = any(select lower(x) from unnest(to_addresses || cc_addresses) x)) order by created_at`, [s.orgId, email]) : []
  tables.email_messages = sent.map(({ key_id, content_ciphertext, ...m }) => ({ ...m, content: m.body_purged_at ? { erased: 'the body was removed by your retention settings' } : decrypt(key_id, content_ciphertext, `email-message:${m.id}`) }))
  const received = email ? await db.query<Row & { id: string; key_id: string; content_ciphertext: string }>(
    `select id, received_at, from_address, to_addresses, cc_addresses, classification, status, attachment_count, key_id, content_ciphertext, body_purged_at from email_inbound
     where org_id = $1 and (lower(from_address) = $2 or $2 = any(select lower(x) from unnest(to_addresses || cc_addresses) x)) order by received_at`, [s.orgId, email]) : []
  tables.email_inbound = received.map(({ key_id, content_ciphertext, ...m }) => ({ ...m, content: m.body_purged_at ? { erased: 'the body was removed by your retention settings' } : decrypt(key_id, content_ciphertext, `email-inbound:${m.id}`) }))
  tables.email_suppressions = email ? await db.query(`select reason, created_at from email_suppressions where org_id = $1 and (address = $2 or address = $3)`, [s.orgId, email, `sha256:${addressHash(s.orgId, email)}`]) : []
  tables.office_leads = email ? await db.query(`select id, email, first_name, company, lifecycle_stage, status, stop_reason, touches, last_touch_at, replied_at, created_at from office_leads where org_id = $1 and lower(email) = $2`, [s.orgId, email]) : []
  tables.office_meetings = email ? await db.query(`select id, contact_email, status, proposed_slots, chosen_slot, calendar_link, created_at from office_meetings where org_id = $1 and lower(contact_email) = $2`, [s.orgId, email]) : []
  tables.office_invoices = email ? await db.query(`select id, doc_number, customer_name, bill_email, currency, total_amt, balance, txn_date, due_date, status, reminders_sent from office_invoices where org_id = $1 and lower(bill_email) = $2`, [s.orgId, email]) : []
  tables.office_actions = await db.query(`select id, kind, purpose, status, payload, result, created_at from office_actions where org_id = $1 and ${names('payload::text || coalesce(result::text, \'\')', 2)}`, [s.orgId, tokens])
  tables.library_actions = await db.query(`select id, agent_key, action_type, title, summary, evidence, payload, status, proof, created_at from library_actions where org_id = $1 and ${names(`title || ' ' || summary || evidence::text || payload::text || coalesce(proof::text, '')`, 2)}`, [s.orgId, tokens])
  tables.library_chat_messages = await db.query(`select id, agent_key, role, text, created_at from library_chat_messages where org_id = $1 and ${names(`text || coalesce(outcome::text, '')`, 2)}`, [s.orgId, tokens])
  tables.cases = await db.query(`select id, ref, kind, title, problem, status, status_reason, evidence, records, outcome, opened_at, closed_at from cases where org_id = $1 and ${names(caseText, 2)}`, [s.orgId, tokens])
  tables.case_events = await db.query(`select e.id::text, c.ref as case_ref, e.at, e.type, e.summary, e.detail from case_events e join cases c on c.id = e.case_id where e.org_id = $1 and ${names(`e.summary || e.detail::text`, 2)} order by e.id`, [s.orgId, tokens])
  const audit = await db.one<{ n: number }>(`select count(*)::int as n from engine_audit where org_id = $1 and ${names('detail::text', 2)}`, [s.orgId, tokens])
  tables.engine_audit = audit?.n ? [{ entries_naming_the_customer: audit.n, note: 'audit entries are retained unchanged for audit' }] : []
  if (!email) notes.push('No email address was given: only records carrying the Shopify customer or order ids were searched.')
  notes.push('Deploi does not read Shopify customers or orders; mail, agent drafts, cases and Office records are where a customer can appear.')
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, k === 'engine_audit' ? (audit?.n ?? 0) : v.length]))
  return { format: 'deploi.customer_data.v1', generatedAt: new Date().toISOString(), shop, subject: { email, shopifyCustomerId: s.customerId, orderIds: s.orderIds },
    matching: 'email address (any case) and the Shopify customer and order ids, within this shop\'s organization only', tables, counts, notes }
}

const caseText = `title || ' ' || problem || ' ' || coalesce(why_it_matters, '') || ' ' || coalesce(status_reason, '') || ' ' || coalesce(next_action, '') || evidence::text || records::text || coalesce(outcome::text, '')`

/** Erase the subject from the organization. Idempotent: a second run finds nothing more to change. */
export async function redactCustomerData(db: Db, s: Subject): Promise<Record<string, number>> {
  const tokens = subjectTokens(s)
  const out: Record<string, number> = {}
  if (!tokens.length) return out
  const email = s.email ? bare(s.email) : null
  const pat = tokenPattern(tokens)
  const rx = (expr: string) => `regexp_replace(${expr}, $3, '${ERASED}', 'gi')`
  if (email) {
    const hash = addressHash(s.orgId, email)
    const token = `erased-${hash.slice(0, 24)}@erased.invalid`
    // the customer's mail is only about them: deleted (records that pointed at it keep their own ids)
    out.email_inbound = (await db.query(`delete from email_inbound where org_id = $1 and (lower(from_address) = $2 or $2 = any(select lower(x) from unnest(to_addresses || cc_addresses) x)) returning id`, [s.orgId, email])).length
    out.email_messages = (await db.query(`delete from email_messages where org_id = $1 and (lower(from_address) = $2 or $2 = any(select lower(x) from unnest(to_addresses || cc_addresses) x)) returning id`, [s.orgId, email])).length
    // an opt-out must keep working: kept as a hash that only this address produces (lib/email/suppression.ts)
    const hashed = `sha256:${hash}`
    const kept = await db.query(`update email_suppressions set address = $3, detail = null where org_id = $1 and address = $2 and not exists (select 1 from email_suppressions x where x.org_id = $1 and x.address = $3) returning id`, [s.orgId, email, hashed])
    const dup = await db.query(`delete from email_suppressions where org_id = $1 and address = $2 returning id`, [s.orgId, email])
    out.email_suppressions = kept.length + dup.length
    out.office_leads = (await db.query(`update office_leads set email = $3, first_name = null, company = null, status = case when status = 'active' then 'stopped' else status end,
      stop_reason = 'customer data erased at the shop''s request', next_touch_at = null where org_id = $1 and lower(email) = $2 returning id`, [s.orgId, email, token])).length
    out.office_meetings = (await db.query(`update office_meetings set contact_email = $3 where org_id = $1 and lower(contact_email) = $2 returning id`, [s.orgId, email, token])).length
    out.office_invoices = (await db.query(`update office_invoices set bill_email = null, customer_name = null where org_id = $1 and lower(bill_email) = $2 returning id`, [s.orgId, email])).length
  }
  out.office_actions = (await db.query(`update office_actions set payload = ${rx('payload::text')}::jsonb, result = case when result is null then null else ${rx('result::text')}::jsonb end,
      status = case when status in ('draft','awaiting_approval','queued') then 'cancelled' else status end,
      status_reason = case when status in ('draft','awaiting_approval','queued') then 'customer data erased at the shop''s request' else status_reason end
    where org_id = $1 and ${names('payload::text || coalesce(result::text, \'\')', 2)} returning id`, [s.orgId, tokens, pat])).length
  out.library_actions = (await db.query(`update library_actions set title = ${rx('title')}, summary = ${rx('summary')}, evidence = ${rx('evidence::text')}::jsonb, payload = ${rx('payload::text')}::jsonb,
      proof = case when proof is null then null else ${rx('proof::text')}::jsonb end,
      status = case when status = 'draft' then 'expired' else status end, status_reason = case when status = 'draft' then 'customer data erased at the shop''s request' else status_reason end
    where org_id = $1 and ${names(`title || ' ' || summary || evidence::text || payload::text || coalesce(proof::text, '')`, 2)} returning id`, [s.orgId, tokens, pat])).length
  out.library_chat_messages = (await db.query(`update library_chat_messages set text = ${rx('text')}, outcome = case when outcome is null then null else ${rx('outcome::text')}::jsonb end
    where org_id = $1 and ${names(`text || coalesce(outcome::text, '')`, 2)} returning id`, [s.orgId, tokens, pat])).length
  out.cases = (await db.query(`update cases set title = ${rx('title')}, problem = ${rx('problem')}, why_it_matters = ${rx('why_it_matters')}, status_reason = ${rx('status_reason')}, next_action = ${rx('next_action')},
      evidence = ${rx('evidence::text')}::jsonb, records = ${rx('records::text')}::jsonb, outcome = case when outcome is null then null else ${rx('outcome::text')}::jsonb end
    where org_id = $1 and ${names(caseText, 2)} returning id`, [s.orgId, tokens, pat])).length
  // case history is append-only; erasing an address is the one change the database allows (migration 052)
  await db.query(`select set_config('deploi.privacy_redaction', 'on', true)`)
  out.case_events = (await db.query(`update case_events set summary = ${rx('summary')}, detail = ${rx('detail::text')}::jsonb where org_id = $1 and ${names('summary || detail::text', 2)} returning id`, [s.orgId, tokens, pat])).length
  await db.query(`select set_config('deploi.privacy_redaction', 'off', true)`)
  out.engine_audit_retained = (await db.one<{ n: number }>(`select count(*)::int as n from engine_audit where org_id = $1 and ${names('detail::text', 2)}`, [s.orgId, tokens]))?.n ?? 0
  return out
}
