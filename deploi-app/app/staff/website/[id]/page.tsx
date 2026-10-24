import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getEngagement } from '@/lib/website/queries'
import {
  ACCESS_STATUSES, ACCESS_LABEL, FEASIBILITY, LABOR_KINDS, MAX_PAGES, STATUS_LABEL, moneyCents,
  NO_CREDIT_TEXT, MAINTENANCE_TEXT, TARGET_TEXT, BUDGET_BLOCK_TEXT,
} from '@/lib/website/states'
import {
  saveEngagementDetails, recordPayment, recordAcceptance, addLabor, addApprovedChange, removeApprovedChange,
  addBeforeAfter, recordCustomerApproval, recordPublicationVerification,
} from '@/lib/website/actions'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { StatusBadge, PaymentBadge } from '@/components/website/StatusBadge'
import { BudgetBar } from '@/components/website/BudgetBar'
import { TransitionButtons, TransitionHistory } from '@/components/website/Transitions'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Website engagement' }

const ERRORS: Record<string, string> = {
  'secret-field-refused': 'A field named like a credential was refused. Never enter passwords here; describe the approved access arrangement instead.',
  'invalid-access-status': 'Choose a valid access status.', 'invalid-feasibility': 'Choose a valid feasibility.', 'invalid-url': 'The website URL must start with http:// or https://.',
  'invalid-preview-url': 'The preview URL must start with http:// or https://.', 'invalid-payment-mode': 'Unknown payment mode.', 'payment-reference-required': 'A real payment needs a reference (invoice or receipt id).',
  'acceptance-incomplete': 'Acceptance evidence needs who accepted and how.', 'invalid-hours': 'Hours must be between 0.01 and 24.', 'invalid-kind': 'Choose a labor kind.',
  'change-required': 'Write the approved change.', 'before-after-incomplete': 'A before/after entry needs the page, a before reference and an after reference.',
  'approval-incomplete': 'Customer approval evidence needs the method, a reference and who approved.', 'checked-urls-required': 'List at least one checked URL.', 'invalid-index': 'Could not remove that item.',
}
const fmt = (v: string | null | undefined) => v ? new Date(v).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) : '—'
const Section = ({ id, title, children, hint }: { id: string; title: string; hint?: string; children: React.ReactNode }) => (
  <section aria-labelledby={id} className="rounded-[20px] border border-line p-5">
    <h2 id={id} className="text-lg">{title}</h2>
    {hint && <p className="mt-1 text-[14px] text-grey-h">{hint}</p>}
    <div className="mt-4">{children}</div>
  </section>
)

export default async function WebsiteEngagementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const data = await withUser(session, db => getEngagement(db, id), { ip: await requestIp() })
  if (!data) notFound()
  const { engagement: e, labor, transitions, budget, economics } = data
  const pages = Array.isArray(e.pages) ? e.pages : []
  const ev = (e.customer_approval_evidence ?? null) as { method?: string; reference?: string; approved_by?: string; at?: string } | null
  const acc = (e.acceptance_evidence ?? null) as { accepted_by?: string; method?: string; reference?: string; at?: string; payment_reference?: string } | null
  const ver = (e.publication_verification ?? null) as { checked_urls?: string[]; at?: string; notes?: string } | null
  const feas = e.feasibility ?? {}

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/staff/website" className="inline-flex items-center gap-1"><Icon name="arrow-right" size={12} className="rotate-180" /> Website Improvement</Link>}
        title={e.agency_name ?? 'Website engagement'}
        sub={<>{e.owner_name ?? 'No contact name'}{e.prospect_email ? ` · ${e.prospect_email}` : ''}<br />{e.website_url ? <a href={e.website_url} target="_blank" rel="noopener noreferrer" className="underline">{e.website_url}</a> : 'No site URL yet'}{e.platform ? ` · ${e.platform}` : ''} · {moneyCents(e.price_cents)} one-time</>}
        actions={<>
          <StatusBadge status={e.status} />
          <PaymentBadge status={e.payment_status} isMock={e.payment_is_mock} />
          {e.revision_round > 0 && <Badge tone="muted">revision round {e.revision_round}</Badge>}
          {e.prospect_id && <Button variant="ghost" size="sm" href={`/staff/pipeline/${e.prospect_id}`}>Prospect</Button>}
        </>}
      />

      {sp.saved && <div className="mb-5"><Banner icon="check"><strong>Saved.</strong>{sp.removed ? ` ${sp.removed} password-like segment${sp.removed === '1' ? '' : 's'} replaced with [removed]; passwords are never stored.` : ''}</Banner></div>}
      {sp.labor && <div className="mb-5"><Banner icon="check"><strong>Labor logged.</strong></Banner></div>}
      {sp.approval && <div className="mb-5"><Banner icon="check"><strong>Customer approval evidence recorded.</strong></Banner></div>}
      {sp.verified && <div className="mb-5"><Banner icon="check"><strong>Publication verification recorded.</strong></Banner></div>}
      {sp.payment === 'real' && <div className="mb-5"><Banner icon="check"><strong>Payment recorded.</strong> Nothing was charged from here; this records a payment that happened elsewhere.</Banner></div>}
      {sp.payment === 'mock' && <div className="mb-5"><Banner tone="warn"><strong>Mock payment recorded (simulated).</strong> It is visible as mock_paid and never satisfies the payment gate.</Banner></div>}
      {sp.moved && <div className="mb-5"><Banner icon="check"><strong>Moved to {STATUS_LABEL[sp.moved as keyof typeof STATUS_LABEL] ?? sp.moved}.</strong></Banner></div>}
      {sp.blocked && <div className="mb-5"><Banner tone="warn"><strong>Transition refused.</strong> {sp.blocked}</Banner></div>}
      {sp.error && <div className="mb-5"><Banner tone="warn"><strong>Could not save.</strong> {ERRORS[sp.error] ?? sp.error.replace(/-/g, ' ')}</Banner></div>}
      {budget.level === 'blocked' && <div className="mb-5"><Banner tone="warn"><strong>Labor budget reached.</strong> {BUDGET_BLOCK_TEXT}</Banner></div>}

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <div className="flex flex-col gap-5">
          <Section id="workflow" title="Workflow" hint="Only legal next steps are shown. A blocked step shows why; the server checks the same gate.">
            <TransitionButtons e={e} />
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-grey-h md:grid-cols-3">
              <div><dt>Scope confirmed</dt><dd className="text-grey">{fmt(e.scope_confirmed_at)}</dd></div>
              <div><dt>Accepted</dt><dd className="text-grey">{fmt(e.accepted_at)}</dd></div>
              <div><dt>Paid</dt><dd className="text-grey">{fmt(e.paid_at)}{e.paid_at && e.payment_is_mock ? ' (simulated)' : ''}</dd></div>
              <div><dt>Access received</dt><dd className="text-grey">{fmt(e.access_received_at)}</dd></div>
              <div><dt>Content received</dt><dd className="text-grey">{e.content_received_at ? String(e.content_received_at).slice(0, 10) : '—'}</dd></div>
              <div><dt>Preview ready</dt><dd className="text-grey">{fmt(e.preview_ready_at)}</dd></div>
              <div><dt>Customer approved</dt><dd className="text-grey">{fmt(e.customer_approved_at)}</dd></div>
              <div><dt>Published</dt><dd className="text-grey">{fmt(e.published_at)}</dd></div>
              <div><dt>Verified</dt><dd className="text-grey">{fmt(e.publication_verified_at)}</dd></div>
            </dl>
            <p className="mt-3 text-[14px] text-grey"><strong className="text-ink">Target date: {e.target_date ? String(e.target_date).slice(0, 10) : 'not set yet'}.</strong> {TARGET_TEXT}</p>
          </Section>

          <Section id="details" title="Qualification and delivery details" hint="Up to three pages. Never enter a password anywhere on this page; describe the approved access arrangement only.">
            <form action={saveEngagementDetails} className="grid gap-4 md:grid-cols-2">
              <input type="hidden" name="id" value={e.id} />
              <Field label="Website URL" htmlFor="website_url"><Input id="website_url" name="website_url" defaultValue={e.website_url ?? ''} placeholder="https://" /></Field>
              <Field label="Platform" htmlFor="platform"><Input id="platform" name="platform" defaultValue={e.platform ?? ''} placeholder="WordPress, Squarespace, Wix…" /></Field>
              <div className="md:col-span-2"><Field label="Goal" htmlFor="goal"><Textarea id="goal" name="goal" rows={2} defaultValue={e.goal ?? ''} /></Field></div>
              {[1, 2, 3].map(i => (
                <Field key={i} label={`Page ${i}${i === 1 ? ' (required for scope)' : ''}`} htmlFor={`page_${i}`}><Input id={`page_${i}`} name={`page_${i}`} defaultValue={pages[i - 1] ?? ''} placeholder={i === 1 ? 'Home' : i === 2 ? 'Services' : 'Contact'} /></Field>
              ))}
              <p className="text-[13px] text-grey-h md:self-end">Maximum {MAX_PAGES} pages; one revision round.</p>
              <div className="md:col-span-2"><Field label="Requested changes" htmlFor="requested_changes"><Textarea id="requested_changes" name="requested_changes" rows={3} defaultValue={e.requested_changes ?? ''} /></Field></div>
              <div className="md:col-span-2"><Field label="Known issues" htmlFor="known_issues"><Textarea id="known_issues" name="known_issues" rows={2} defaultValue={e.known_issues ?? ''} /></Field></div>
              <Field label="Access status" htmlFor="access_status">
                <Select id="access_status" name="access_status" defaultValue={e.access_status}>{ACCESS_STATUSES.map(a => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}</Select>
              </Field>
              <Field label="Approval contact" htmlFor="approval_contact"><Input id="approval_contact" name="approval_contact" maxLength={200} defaultValue={e.approval_contact ?? ''} /></Field>
              <div className="md:col-span-2">
                <Field label="Access arrangement (how access was arranged, e.g. “invited as editor”; never a secret)" htmlFor="access_arrangement" hint="Approved methods: an editor invite to a Deploi address, agency-managed access, or a screen-share session. Passwords are refused and never stored.">
                  <Textarea id="access_arrangement" name="access_arrangement" rows={2} defaultValue={e.access_arrangement ?? ''} />
                </Field>
              </div>
              <Field label="Feasibility (confirm before accepting payment)" htmlFor="feasibility">
                <Select id="feasibility" name="feasibility" defaultValue={feas.status ?? 'unconfirmed'}>{FEASIBILITY.map(f => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}</Select>
              </Field>
              <Field label="Feasibility note" htmlFor="feasibility_note" hint={feas.confirmed_at ? `Confirmed ${fmt(feas.confirmed_at)}` : 'Not confirmed yet'}><Input id="feasibility_note" name="feasibility_note" defaultValue={feas.note ?? ''} /></Field>
              <div className="md:col-span-2"><Field label="Backup / rollback plan (required before Improving)" htmlFor="backup_plan"><Textarea id="backup_plan" name="backup_plan" rows={2} defaultValue={e.backup_plan ?? ''} placeholder="e.g. exported page copies and a platform revision snapshot before editing" /></Field></div>
              <Field label="Preview URL" htmlFor="preview_url"><Input id="preview_url" name="preview_url" defaultValue={e.preview_url ?? ''} placeholder="https://staging…" /></Field>
              <Field label="Rollback note (when the platform has no staging: direct edit with rollback note)" htmlFor="rollback_note"><Input id="rollback_note" name="rollback_note" defaultValue={e.rollback_note ?? ''} /></Field>
              <Field label="Content received on" htmlFor="content_received_at"><Input id="content_received_at" name="content_received_at" type="date" defaultValue={e.content_received_at ? String(e.content_received_at).slice(0, 10) : ''} /></Field>
              <Field label="Revision status" htmlFor="revision_status"><Input id="revision_status" name="revision_status" defaultValue={e.revision_status ?? ''} placeholder="e.g. round 1 feedback received" /></Field>
              <div className="md:col-span-2"><Field label="Handoff summary (required before Completed)" htmlFor="handoff_summary"><Textarea id="handoff_summary" name="handoff_summary" rows={3} defaultValue={e.handoff_summary ?? ''} /></Field></div>
              <div className="md:col-span-2">
                <label className="flex items-start gap-2 text-[14px] text-ink"><input type="checkbox" name="maintenance_requested" defaultChecked={e.maintenance_requested} className="mt-1" /> <span>Maintenance requested <span className="block text-[13px] text-grey-h">{MAINTENANCE_TEXT}</span></span></label>
              </div>
              <div className="md:col-span-2"><Button type="submit">Save details</Button></div>
            </form>
          </Section>

          <Section id="approved" title="Approved changes" hint="What the customer agreed to. Scope does not shrink silently: a smaller scope is agreed, not assumed.">
            {e.approved_changes.length === 0 ? <p className="text-grey text-[15px]">None recorded.</p> : (
              <ul className="flex flex-col gap-2">
                {e.approved_changes.map((c, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 rounded-2xl border border-line p-3 text-[15px]">
                    <span>{c}</span>
                    <form action={removeApprovedChange}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="index" value={i} /><button className="btn ghost xs" type="submit" aria-label="Remove"><Icon name="x" size={14} /></button></form>
                  </li>
                ))}
              </ul>
            )}
            <form action={addApprovedChange} className="mt-3 flex flex-col gap-2 min-[560px]:flex-row">
              <input type="hidden" name="id" value={e.id} />
              <Input name="change" placeholder="e.g. Clearer services list on Home" aria-label="Approved change" maxLength={500} />
              <Button type="submit" variant="ghost" size="sm" className="shrink-0">Add</Button>
            </form>
          </Section>

          <Section id="beforeafter" title="Before / after references" hint="Links or text references only; nothing is uploaded here.">
            {e.before_after.length === 0 ? <p className="text-grey text-[15px]">None yet.</p> : (
              <div className="table-wrap"><table className="dg-table"><thead><tr><th>Page</th><th>Before</th><th>After</th><th>Note</th></tr></thead>
                <tbody>{e.before_after.map((b, i) => <tr key={i}><td className="ink">{b.page}</td><td>{b.before_ref}</td><td>{b.after_ref}</td><td>{b.note ?? '—'}</td></tr>)}</tbody></table></div>
            )}
            <form action={addBeforeAfter} className="mt-3 grid gap-2 md:grid-cols-4">
              <input type="hidden" name="id" value={e.id} />
              <Input name="page" placeholder="Page" aria-label="Page" />
              <Input name="before_ref" placeholder="Before (link or reference)" aria-label="Before reference" />
              <Input name="after_ref" placeholder="After (link or reference)" aria-label="After reference" />
              <Input name="note" placeholder="Note" aria-label="Note" />
              <div className="md:col-span-4"><Button type="submit" variant="ghost" size="sm">Add reference</Button></div>
            </form>
          </Section>

          <Section id="approval" title="Customer approval evidence" hint="Required before Customer approved and before anything is published.">
            {ev && Object.keys(ev).length > 0 ? (
              <div className="mb-3 rounded-2xl border border-line p-3 text-[14px]"><Badge tone="ok">recorded</Badge> <span className="text-ink">{ev.approved_by}</span> approved by {ev.method} ({ev.reference}) on {fmt(ev.at)}.</div>
            ) : <p className="mb-3 text-[14px] text-warn">No approval evidence yet. Publication is refused until it is recorded.</p>}
            <form action={recordCustomerApproval} className="grid gap-3 md:grid-cols-2">
              <input type="hidden" name="id" value={e.id} />
              <Field label="Method" htmlFor="ap_method"><Input id="ap_method" name="method" placeholder="email reply, signed note, call summary…" /></Field>
              <Field label="Reference" htmlFor="ap_ref"><Input id="ap_ref" name="reference" placeholder="e.g. email subject + date, ticket id" /></Field>
              <Field label="Approved by" htmlFor="ap_by"><Input id="ap_by" name="approved_by" placeholder="name and role" /></Field>
              <Field label="When" htmlFor="ap_at"><Input id="ap_at" name="at" type="datetime-local" /></Field>
              <div className="md:col-span-2"><Button type="submit" variant="ghost" size="sm">Record approval evidence</Button></div>
            </form>
          </Section>

          <Section id="verification" title="Publication verification" hint="After publishing: which URLs were checked and what was seen. Required before Completed.">
            {ver && (ver.checked_urls?.length ?? 0) > 0 ? (
              <div className="mb-3 rounded-2xl border border-line p-3 text-[14px]"><Badge tone="ok">verified</Badge> {ver.checked_urls!.length} URL{ver.checked_urls!.length === 1 ? '' : 's'} checked on {fmt(ver.at)}.{ver.notes ? ` ${ver.notes}` : ''}
                <ul className="mt-2 list-disc pl-5 text-grey">{ver.checked_urls!.map(u => <li key={u}>{u}</li>)}</ul></div>
            ) : <p className="mb-3 text-[14px] text-grey">Not verified yet.</p>}
            <form action={recordPublicationVerification} className="flex flex-col gap-3">
              <input type="hidden" name="id" value={e.id} />
              <Field label="Checked URLs (one per line)" htmlFor="checked_urls"><Textarea id="checked_urls" name="checked_urls" rows={3} /></Field>
              <Field label="Notes" htmlFor="ver_notes"><Input id="ver_notes" name="notes" placeholder="forms delivered, links work, mobile layout checked" /></Field>
              <div><Button type="submit" variant="ghost" size="sm">Record verification</Button></div>
            </form>
          </Section>
        </div>

        <div className="flex flex-col gap-5">
          <Section id="payment" title="Payment" hint={`${moneyCents(e.price_cents)} one-time. ${NO_CREDIT_TEXT}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[14px]"><PaymentBadge status={e.payment_status} isMock={e.payment_is_mock} />{e.paid_at && <span className="text-grey-h">{fmt(e.paid_at)}</span>}{acc?.payment_reference && <span className="text-grey-h">ref {acc.payment_reference}</span>}</div>
            <p className="mb-3 text-[13px] text-grey-h">Feasibility: <span className={feas.status === 'feasible' ? 'text-ok' : 'text-warn'}>{feas.status ?? 'unconfirmed'}</span>. Payment is only confirmed after feasibility is confirmed.</p>
            <form action={recordPayment} className="flex flex-col gap-3 rounded-2xl border border-line p-3">
              <input type="hidden" name="id" value={e.id} />
              <input type="hidden" name="mode" value="real" />
              <Field label="Record payment" hint="Records a payment that happened elsewhere (invoice or receipt). Nothing is charged from here." htmlFor="pay_ref"><Input id="pay_ref" name="reference" placeholder="invoice or receipt id" /></Field>
              <div><Button type="submit" variant="ghost" size="sm" disabled={e.payment_status === 'paid' && !e.payment_is_mock}>Record payment</Button></div>
            </form>
            <form action={recordPayment} className="mt-3 flex flex-col gap-2 rounded-2xl border border-dashed border-line p-3">
              <input type="hidden" name="id" value={e.id} />
              <input type="hidden" name="mode" value="mock" />
              <p className="text-[13px] text-grey-h"><Badge tone="warn">simulated</Badge> A mock payment shows as mock_paid (simulated) and never satisfies the payment gate.</p>
              <div><Button type="submit" variant="ghost" size="sm" disabled={e.payment_status === 'paid' && !e.payment_is_mock}>Record mock payment (simulated)</Button></div>
            </form>
          </Section>

          <Section id="acceptance" title="Acceptance evidence" hint="Who accepted the scope and how. Required before Accepted.">
            {acc?.accepted_by ? <div className="mb-3 rounded-2xl border border-line p-3 text-[14px]"><Badge tone="ok">recorded</Badge> {acc.accepted_by} via {acc.method}{acc.reference ? ` (${acc.reference})` : ''} on {fmt(acc.at)}.</div> : <p className="mb-3 text-[14px] text-grey">Not recorded.</p>}
            <form action={recordAcceptance} className="flex flex-col gap-3">
              <input type="hidden" name="id" value={e.id} />
              <Field label="Accepted by" htmlFor="acc_by"><Input id="acc_by" name="accepted_by" /></Field>
              <Field label="Method" htmlFor="acc_method"><Input id="acc_method" name="method" placeholder="email reply, call, signed quote" /></Field>
              <Field label="Reference" htmlFor="acc_ref"><Input id="acc_ref" name="reference" /></Field>
              <div><Button type="submit" variant="ghost" size="sm">Record acceptance</Button></div>
            </form>
          </Section>

          <Section id="labor" title="Labor log and budget" hint="Five total staff hours including review, implementation, testing and revisions.">
            <BudgetBar budget={budget} />
            <form action={addLabor} className="mt-4 grid grid-cols-[1fr_1fr] gap-2">
              <input type="hidden" name="id" value={e.id} />
              <Input name="hours" type="number" step="0.25" min="0.25" max="24" placeholder="Hours" aria-label="Hours" required />
              <Select name="kind" defaultValue="implementation" aria-label="Kind">{LABOR_KINDS.map(k => <option key={k} value={k}>{k}</option>)}</Select>
              <div className="col-span-2"><Input name="note" placeholder="Note" aria-label="Note" maxLength={1000} /></div>
              <div className="col-span-2"><Button type="submit" variant="ghost" size="sm">Log hours</Button></div>
            </form>
            {labor.length > 0 && (
              <ul className="mt-4 flex flex-col gap-2 text-[14px]">
                {labor.map(l => <li key={l.id} className="flex flex-wrap gap-2 rounded-2xl border border-line p-3"><span className="text-ink">{Number(l.hours).toFixed(2)} h</span><Badge tone="muted">{l.kind}</Badge><span className="text-grey-h">{fmt(l.logged_at)}</span>{l.note && <span className="w-full text-grey">{l.note}</span>}</li>)}
              </ul>
            )}
          </Section>

          <Section id="economics" title="Delivery cost and contribution" hint="Internal only; never shown to clients.">
            <dl className="grid grid-cols-2 gap-y-1 text-[14px]">
              <dt className="text-grey-h">Price</dt><dd className="text-ink">{moneyCents(economics.price_cents)}</dd>
              <dt className="text-grey-h">Hours logged</dt><dd className="text-ink">{economics.hours.toFixed(2)}</dd>
              <dt className="text-grey-h">Internal rate</dt><dd className="text-ink">{economics.rate_cents === null ? 'rates not configured' : `${moneyCents(economics.rate_cents)}/h`}</dd>
              <dt className="text-grey-h">Delivery cost</dt><dd className="text-ink">{economics.cost_cents === null ? '—' : moneyCents(economics.cost_cents)}</dd>
              <dt className="text-grey-h">Contribution</dt><dd className={economics.contribution_cents !== null && economics.contribution_cents < 0 ? 'text-danger' : 'text-ink'}>{economics.contribution_cents === null ? '—' : moneyCents(economics.contribution_cents)}</dd>
            </dl>
          </Section>

          <Section id="history" title="Transition history">
            <TransitionHistory rows={transitions} />
          </Section>
        </div>
      </div>
    </>
  )
}
