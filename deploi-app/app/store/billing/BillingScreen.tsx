'use client'
/**
 * Billing (/store/billing): the current plan and status, trial days left, usage against the allowance
 * (actions, emails, AI spend), invoices and the payment method (from Stripe, with the hosted invoice and
 * portal links), changing plan with Stripe's preview before confirming, and cancelling or reactivating.
 * Shopify App Store stores see their Shopify subscription and change it in Shopify. Prices come from the plans
 * table and are labelled "Pilot pricing" while they are hypotheses. While BILLING_MODE is off the page says the
 * private beta is free.
 */
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'

type PlanOption = { key: string; name: string; suite: string; priceCents: number; currency: string; pilot: boolean; trialDays: number; available: boolean; refusal: string | null; current: boolean; pending: boolean }
type BillingResp = {
  mode: 'off' | 'test' | 'live'; configured: boolean; hasPortal: boolean; provider: 'stripe' | 'shopify'
  billing: { provider: 'stripe' | 'shopify'; status: string; plan: string | null; readOnly: boolean; reason: string | null; graceEndsAt: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }
  subscription: { status: string; planKey: string | null; trialEnd: string | null; trialDaysLeft: number | null; cancelReason: string | null; cancelRequestedAt: string | null; pendingPlanKey: string | null; pendingChangeAt: string | null; endedAt: string | null } | null
  paymentFailure: { count: number; lastFailedAt: string | null; nextAttemptAt: string | null; amountDueCents: number | null; currency: string | null; hostedInvoiceUrl: string | null } | null
  trial: { eligible: boolean; refusal: string | null; outcome: string | null; endsAt: string | null }
  plan: { tier: string; key: string; label: string; priced: boolean; writesAllowed: boolean; limits: { maxAgents: number; maxCompetitorStores: number; monthlyActions: number; monthlyEmails: number; officeSeats: number; officeConnections: number; aiBudgetUsd: number } }
  plans: PlanOption[]; pricingLabel: string | null
  usage: { actions: number; actionsLimit: number | null; emails: number; emailsLimit: number | null; resetsAt: string; enforced: boolean; aiSpendUsd: number; aiBudgetUsd: number | null }
  shopify: { planHandle: string | null; status: string | null; currentPeriodEnd: string | null; isTest: boolean; plansUrl: string | null } | null
}
type Account = { invoices: { id: string; number: string | null; status: string; amountDueCents: number; amountPaidCents: number; currency: string; created: string; hostedUrl: string | null; pdfUrl: string | null }[]; paymentMethod: { brand: string; last4: string; expMonth: number | null; expYear: number | null } | null }
type Preview = { changeId: string; direction: 'upgrade' | 'downgrade'; to: { name: string; priceCents: number; pilot: boolean }; amountDueCents: number; currency: string; prorationCents: number; effectiveAt: string | null; lines: { description: string; amountCents: number; proration: boolean }[]; summary: string }

const REASONS: [string, string][] = [['too_expensive', 'Too expensive'], ['missing_features', 'Missing features I need'], ['unused', 'Not using it enough'], ['switched_service', 'Switched to another service'], ['too_complex', 'Too complicated'], ['low_quality', 'Quality was not good enough'], ['customer_service', 'Support experience'], ['other', 'Something else']]
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : '')
function money(cents: number, currency = 'usd') {
  const sym = currency === 'usd' ? '$' : currency === 'eur' ? '€' : currency === 'gbp' ? '£' : `${currency.toUpperCase()} `
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${sym}${abs % 100 === 0 ? abs / 100 : (abs / 100).toFixed(2)}`
}
const STATUS_WORD: Record<string, string> = { none: 'No subscription', trialing: 'Trial', active: 'Active', past_due: 'Payment failed', unpaid: 'Unpaid', canceled: 'Ended', incomplete: 'Not started', paused: 'Paused', not_required: 'Free beta' }

function Meter({ label, used, limit, unit = '' }: { label: string; used: number; limit: number | null; unit?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="mt-3" aria-label={label}>
      <div className="flex justify-between text-[13px]"><span>{label}</span><span className="text-grey">{limit === null ? `${unit}${used} (not limited in the beta)` : `${unit}${used} of ${unit}${limit}`}</span></div>
      {limit !== null && <div className="mt-1 h-2 rounded-full bg-[var(--c-line)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className={`h-2 rounded-full ${pct >= 90 ? 'bg-[var(--c-warn)]' : 'bg-[var(--c-accent)]'}`} style={{ width: `${pct}%` }} /></div>}
    </div>
  )
}

export function BillingScreen() {
  const params = useSearchParams()
  const returned = params.get('checkout')
  const { data, error, loading, reload } = useLoad(() => storeFetch<BillingResp>('/api/billing'), 'billing')
  const [account, setAccount] = useState<Account | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const portalOpened = useRef(false)

  const stripeBilled = data && data.mode !== 'off' && data.provider === 'stripe'
  useEffect(() => {
    if (!stripeBilled || !data?.hasPortal) return
    storeFetch<Account>('/api/billing/account').then(setAccount).catch(e => setAccountError(asApiError(e).message))
  }, [stripeBilled, data?.hasPortal])
  useEffect(() => {
    // a link in a billing e-mail (?portal=1) opens Stripe's portal straight away
    if (params.get('portal') === '1' && stripeBilled && data?.hasPortal && !portalOpened.current) { portalOpened.current = true; void redirect('/api/billing/portal') }
  })

  const header = <PageHeader title="Billing" sub="Your plan, what it includes, invoices, and where to change it." />
  if (loading && !data) return <>{header}<Loading label="Loading billing" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const b = data.billing
  const sub = data.subscription
  const current = data.plans.find(p => p.current)
  const live = sub && ['active', 'trialing'].includes(sub.status)
  const canStart = !sub || ['canceled', 'incomplete'].includes(b.status) || b.status === 'none'

  async function redirect(path: string, body?: unknown, key = path) {
    setBusy(key); setNote(null)
    try { const r = await storeFetch<{ url: string }>(path, { method: 'POST', body: body ?? {} }); window.location.assign(r.url) }
    catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }); setBusy(null) }
  }
  async function act<T>(key: string, path: string, body: unknown, then: (r: T) => void) {
    setBusy(key); setNote(null)
    try { then(await storeFetch<T>(path, { method: 'POST', body })) } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }
  const startPreview = (plan: string) => act<{ preview: Preview }>(`preview:${plan}`, '/api/billing/change', { action: 'preview', plan }, r => setPreview(r.preview))
  const confirm = () => preview && act<{ message: string }>('confirm', '/api/billing/change', { action: 'confirm', changeId: preview.changeId }, r => { setPreview(null); setNote({ tone: 'info', text: r.message }); reload() })
  const keepPlan = () => act('keep', '/api/billing/change', { action: 'cancel_pending' }, () => { setNote({ tone: 'info', text: 'The scheduled change was dropped: you stay on your current plan.' }); reload() })
  const cancel = () => act<{ endsAt: string | null }>('cancel', '/api/billing/cancel', { reason, comment }, r => { setCancelOpen(false); setNote({ tone: 'info', text: `Your subscription will end on ${day(r.endsAt) || 'the end of the period'}. Everything works until then, and your data is kept after it.` }); reload() })
  const reactivate = () => act('reactivate', '/api/billing/reactivate', {}, () => { setNote({ tone: 'info', text: 'Reactivated: your subscription continues.' }); reload() })

  const l = data.plan.limits
  return (
    <>
      {header}
      {data.mode === 'test' && <div className="mb-4"><Banner tone="warn">Test mode: Stripe test cards only. Nothing is charged.</Banner></div>}
      {returned === 'success' && <div className="mb-4"><Banner icon="check">Thanks. Your subscription starts as soon as Stripe confirms it (usually a few seconds).</Banner></div>}
      {note && <div className="mb-4" aria-live="polite"><Banner tone={note.tone}>{note.text}</Banner></div>}

      {data.mode === 'off' ? (
        <section className="au-panel p-4"><p className="text-[14px]">The private beta is free. Nothing is charged and no payment details are needed. Paid plans start after the beta; you will see the price and agree to it before any charge.</p></section>
      ) : data.provider === 'shopify' ? (
        <section className="au-panel p-4" aria-label="Shopify subscription">
          <h2 className="text-[1.05rem]">Billed through Shopify</h2>
          <p className="mt-2 text-[14px]">Your store pays for Deploi through Shopify, so plans are chosen, changed and cancelled in the Shopify admin, not here.</p>
          <dl className="au-kv mt-3">
            <dt>Shopify plan</dt><dd>{data.shopify?.planHandle ?? 'No plan chosen yet'}{data.shopify?.isTest ? ' (test charge)' : ''}</dd>
            <dt>Status</dt><dd>{data.shopify?.status ?? 'none'}</dd>
            {data.shopify?.currentPeriodEnd && <><dt>Current period ends</dt><dd>{day(data.shopify.currentPeriodEnd)}</dd></>}
          </dl>
          <div className="mt-3">
            {data.shopify?.plansUrl
              ? <Button size="sm" href={data.shopify.plansUrl} external>Change plan in Shopify</Button>
              : <p className="text-[13px] text-grey">Open the Shopify admin: Apps, Deploi, then the plan page.</p>}
          </div>
        </section>
      ) : (
        <>
          <section className="au-panel p-4" aria-label="Subscription">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={b.readOnly ? 'danger' : b.status === 'past_due' ? 'warn' : b.status === 'trialing' ? 'info' : 'ok'}>{STATUS_WORD[b.status] ?? b.status}</Badge>
              {current && <Badge tone="muted">{current.name}</Badge>}
              {current && <span className="text-[13px]">{money(current.priceCents, current.currency)}/month{current.pilot && <> · <span data-testid="pilot-label">Pilot pricing</span></>}</span>}
            </div>
            {sub?.status === 'trialing' && sub.trialDaysLeft !== null && <p className="mt-2 text-[14px]" data-testid="trial-days"><strong>{sub.trialDaysLeft} day{sub.trialDaysLeft === 1 ? '' : 's'} left</strong> in your trial (ends {day(sub.trialEnd)}). Add a payment method before then to keep your agents running.</p>}
            {b.currentPeriodEnd && b.status !== 'canceled' && sub?.status !== 'trialing' && <p className="mt-2 text-[14px]">{b.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on {day(b.currentPeriodEnd)}.</p>}
            {b.reason && <p className="mt-2 text-[14px]">{b.reason}</p>}
            {b.readOnly && <p className="mt-1 text-[13px] text-grey">Read-only: agents do not change your store or send email. Everything stays visible.</p>}
            {sub?.pendingPlanKey && (
              <div className="mt-3 text-[14px]">
                Switching to <strong>{data.plans.find(p => p.key === sub.pendingPlanKey)?.name ?? sub.pendingPlanKey}</strong> on {day(sub.pendingChangeAt)}.{' '}
                <Button size="xs" variant="ghost" type="button" disabled={busy !== null} onClick={keepPlan}>Keep current plan</Button>
              </div>
            )}
            {b.cancelAtPeriodEnd && b.status !== 'canceled' && (
              <div className="mt-3 text-[14px]" data-testid="cancel-scheduled">
                Your subscription ends on {day(b.currentPeriodEnd)}. Your data is kept; after that date the account is read-only.{' '}
                <Button size="sm" type="button" disabled={busy !== null} onClick={reactivate}>{busy === 'reactivate' ? 'Reactivating' : 'Reactivate'}</Button>
              </div>
            )}
            {!data.configured && <p className="mt-2 text-[13px] text-grey">Billing is not configured in this environment.</p>}
          </section>

          {data.paymentFailure && (
            <section className="au-panel mt-4 p-4" aria-label="Payment failed">
              <h2 className="text-[1.05rem]">Payment did not go through</h2>
              <p className="mt-2 text-[14px]">
                {data.paymentFailure.amountDueCents !== null && <>{money(data.paymentFailure.amountDueCents, data.paymentFailure.currency ?? 'usd')} is due. </>}
                {data.paymentFailure.nextAttemptAt ? `Stripe will retry on ${day(data.paymentFailure.nextAttemptAt)}.` : 'Stripe will not retry automatically.'}
                {b.graceEndsAt && !b.readOnly && <> Your agents keep full service until {day(b.graceEndsAt)}.</>}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" type="button" disabled={busy !== null} onClick={() => redirect('/api/billing/portal')}>Update payment method</Button>
                {data.paymentFailure.hostedInvoiceUrl && <Button size="sm" variant="ghost" href={data.paymentFailure.hostedInvoiceUrl} external>Pay the invoice</Button>}
              </div>
            </section>
          )}

          <section className="au-panel mt-4 p-4" aria-label="Plans">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-[1.05rem]">{canStart ? 'Choose a plan' : 'Change plan'}</h2>
              {data.pricingLabel && <Badge tone="warn">{data.pricingLabel}</Badge>}
            </div>
            {data.pricingLabel && <p className="mt-1 text-[13px] text-grey">Pilot pricing: these prices are proposals during the pilot and may change before launch. You always see the price before you agree to it.</p>}
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {data.plans.map(p => (
                <div key={p.key} className={`au-panel p-3 ${p.current ? 'glow' : ''}`} data-plan={p.key}>
                  <div className="flex items-center justify-between gap-2"><strong>{p.name}</strong>{p.current && <Badge tone="ok">Current</Badge>}{p.pending && <Badge tone="info">Scheduled</Badge>}</div>
                  <div className="mt-1 text-[1.2rem] ink">{money(p.priceCents, p.currency)}<span className="text-[13px] text-grey">/month</span></div>
                  {p.pilot && <div className="text-[12px] text-grey">Pilot pricing</div>}
                  {canStart && p.trialDays > 0 && data.trial.eligible && <div className="mt-1 text-[13px]">{p.trialDays}-day free trial</div>}
                  <div className="mt-2">
                    {canStart ? (
                      <Button size="sm" type="button" disabled={!p.available || busy !== null} onClick={() => redirect('/api/billing/checkout', { plan: p.key }, p.key)}>
                        {busy === p.key ? 'Opening Stripe' : p.trialDays > 0 && data.trial.eligible ? `Start ${p.trialDays}-day trial` : `Subscribe to ${p.name}`}
                      </Button>
                    ) : live && !p.current ? (
                      <Button size="sm" variant="ghost" type="button" disabled={!p.available || busy !== null || b.cancelAtPeriodEnd} onClick={() => startPreview(p.key)}>
                        {busy === `preview:${p.key}` ? 'Getting preview' : current && p.priceCents < current.priceCents ? `Downgrade to ${p.name}` : `Upgrade to ${p.name}`}
                      </Button>
                    ) : null}
                  </div>
                  {!p.available && p.refusal && <p className="mt-1 text-[12px] text-grey">{p.refusal}</p>}
                </div>
              ))}
            </div>
            {canStart && !data.trial.eligible && data.trial.refusal && data.plans.some(p => p.trialDays > 0) && <p className="mt-2 text-[13px] text-grey">No trial: {data.trial.refusal}.</p>}
            {preview && (
              <div className="au-panel glow mt-4 p-4" role="dialog" aria-label="Plan change preview">
                <h3 className="text-[1rem]">{preview.direction === 'upgrade' ? 'Upgrade' : 'Downgrade'} to {preview.to.name}</h3>
                <p className="mt-2 text-[14px]">{preview.summary}</p>
                {preview.lines.length > 0 && (
                  <table className="dg-table mt-3"><tbody>
                    {preview.lines.map((x, i) => <tr key={i}><td>{x.description}{x.proration ? ' (prorated)' : ''}</td><td className="text-right">{money(x.amountCents, preview.currency)}</td></tr>)}
                    <tr><td><strong>Next invoice</strong></td><td className="text-right" data-testid="preview-total"><strong>{money(preview.amountDueCents, preview.currency)}</strong></td></tr>
                  </tbody></table>
                )}
                <p className="mt-2 text-[12px] text-grey">Figures from Stripe&rsquo;s preview. {preview.to.pilot ? 'Pilot pricing. ' : ''}The new plan&rsquo;s limits apply once Stripe confirms the change.</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" type="button" disabled={busy !== null} onClick={confirm}>{busy === 'confirm' ? 'Confirming' : `Confirm ${preview.direction}`}</Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setPreview(null)}>Back</Button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <section className="au-panel mt-4 p-4" aria-label="Usage">
        <h2 className="text-[1.05rem]">{data.plan.label}: usage this month</h2>
        <Meter label="Agent actions" used={data.usage.actions} limit={data.usage.actionsLimit} />
        <Meter label="Emails" used={data.usage.emails} limit={data.usage.emailsLimit} />
        <Meter label="AI spend (USD)" used={data.usage.aiSpendUsd} limit={data.usage.aiBudgetUsd} unit="$" />
        <dl className="au-kv mt-3">
          <dt>Agents</dt><dd>{l.maxAgents}</dd>
          <dt>Watched competitor stores</dt><dd>{l.maxCompetitorStores}</dd>
          <dt>Office seats / connections</dt><dd>{l.officeSeats} / {l.officeConnections}</dd>
        </dl>
        {data.usage.enforced && <p className="mt-2 text-[13px] text-grey">Counts reset on {day(data.usage.resetsAt)} (UTC). When the actions are used, agents hold their work for your approval until then or until you upgrade; nothing is dropped.</p>}
      </section>

      {stripeBilled && data.hasPortal && (
        <section className="au-panel mt-4 p-4" aria-label="Payment method and invoices">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[1.05rem]">Payment method and invoices</h2>
            <Button size="sm" variant="ghost" type="button" disabled={busy !== null} onClick={() => redirect('/api/billing/portal')}>{busy === '/api/billing/portal' ? 'Opening' : 'Manage in Stripe'}</Button>
          </div>
          {accountError ? <p className="mt-2 text-[13px]">{accountError}</p> : !account ? <p className="mt-2 text-[13px] text-grey">Loading from Stripe…</p> : (
            <>
              <p className="mt-2 text-[14px]" data-testid="payment-method">{account.paymentMethod ? `${account.paymentMethod.brand.toUpperCase()} ending ${account.paymentMethod.last4}${account.paymentMethod.expMonth ? `, expires ${String(account.paymentMethod.expMonth).padStart(2, '0')}/${account.paymentMethod.expYear}` : ''}` : 'No payment method on file.'}</p>
              {account.invoices.length === 0 ? <p className="mt-2 text-[13px] text-grey">No invoices yet.</p> : (
                <div className="table-wrap mt-3">
                  <table className="dg-table">
                    <thead><tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Status</th><th></th></tr></thead>
                    <tbody>{account.invoices.map(i => (
                      <tr key={i.id}>
                        <td>{day(i.created)}</td><td>{i.number ?? i.id}</td><td>{money(i.status === 'paid' ? i.amountPaidCents : i.amountDueCents, i.currency)}</td>
                        <td><Badge tone={i.status === 'paid' ? 'ok' : i.status === 'open' ? 'warn' : 'muted'}>{i.status}</Badge></td>
                        <td>{i.hostedUrl && <a href={i.hostedUrl} target="_blank" rel="noopener noreferrer" className="underline">View</a>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {stripeBilled && live && !b.cancelAtPeriodEnd && (
        <section className="au-panel mt-4 p-4" aria-label="Cancel subscription">
          <h2 className="text-[1.05rem]">Cancel subscription</h2>
          {!cancelOpen ? (
            <>
              <p className="mt-2 text-[14px]">Cancelling stops renewal. Everything keeps working until {day(b.currentPeriodEnd) || 'the end of the period'}; after that the account is read-only and your data is kept. Deleting the account is separate, in Settings.</p>
              <div className="mt-3"><Button size="sm" variant="ghost" type="button" onClick={() => setCancelOpen(true)}>Cancel subscription</Button></div>
            </>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <label className="text-[14px]" htmlFor="cancel-reason">Why are you cancelling?</label>
              <select id="cancel-reason" className="select" value={reason} onChange={e => setReason(e.target.value)}>
                <option value="">Choose a reason</option>
                {REASONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <label className="text-[14px]" htmlFor="cancel-comment">Anything we should know? (optional)</label>
              <textarea id="cancel-comment" className="textarea" rows={2} maxLength={500} value={comment} onChange={e => setComment(e.target.value)} />
              <div className="flex gap-2">
                <Button size="sm" variant="danger" type="button" disabled={!reason || busy !== null} onClick={cancel}>{busy === 'cancel' ? 'Cancelling' : 'Cancel at period end'}</Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setCancelOpen(false)}>Keep subscription</Button>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  )
}
