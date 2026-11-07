'use client'
/**
 * Setup (/store/setup), one path from a new sign-up to a working team: business → agreements (only while
 * LEGAL_GATE is on) → products → connect an app → find the work (discovery: "We found work your AI team can
 * handle.", the recommended team set up at drafts only, then granted by the owner) → done. Every step is saved
 * on the server, so the owner can leave and come back; pressing a button twice never creates a second agent.
 */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, useStore } from '@/components/store/bits'
import { PLATFORM_LABEL } from '@/components/store/format'
import { DiscoverFlow } from '@/components/discover/DiscoverFlow'
import { useProbes, ROUTES } from './probe'
import type { WizardOpResponse, WizardResponse, WizardView } from './types'

const FALLBACK_ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney']
function timeZones(current: string): string[] {
  let all: string[] = FALLBACK_ZONES
  try { const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf; if (f) all = f('timeZone') } catch { /* older browsers: the short list */ }
  return all.includes(current) || !current ? all : [current, ...all]
}

type Note = { tone: 'ok' | 'warn'; text: ReactNode } | null

export function OnboardingWizard() {
  const { base } = useStore()
  const { data, error, loading, reload, setData } = useLoad(() => storeFetch<WizardResponse>('/api/store/onboarding').then(r => r.wizard), 'wizard')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [editing, setEditing] = useState<WizardView['steps'][number]['key'] | null>(null)
  const header = <PageHeader eyebrow={<span className="au-eyebrow"><Icon name="spark" size={13} />Setup</span>} title="Set up Deploi" sub="A few steps. Nothing changes in your store or sends from your mailbox until you grant it, and every agent starts at drafts only." />
  if (loading && !data) return <>{header}<Loading label="Loading setup" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const w = data

  async function op<R>(key: string, body: Record<string, unknown>, ok?: (r: R) => ReactNode) {
    setBusy(key); setNote(null)
    try {
      const r = await storeFetch<WizardOpResponse<R>>('/api/store/onboarding', { method: 'POST', body })
      setData(r.wizard)
      setEditing(null)
      if (ok) setNote({ tone: 'ok', text: ok(r.result) })
    } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }

  const doneCount = w.steps.filter(s => s.state === 'done' || s.state === 'skipped').length
  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[14px] text-grey-h">
        <div className="h-2 w-48 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={w.steps.length} aria-valuenow={doneCount}>
          <div className="h-full bg-[var(--au-blue,#5b8cff)]" style={{ width: `${(doneCount / w.steps.length) * 100}%` }} />
        </div>
        <span>{doneCount} of {w.steps.length} done</span>
      </div>
      <div aria-live="polite">{note && <div className="mb-4"><Banner tone={note.tone === 'warn' ? 'warn' : undefined} icon={note.tone === 'ok' ? 'check' : undefined}>{note.text}</Banner></div>}</div>
      <ol className="au-panel p-4 md:p-5" aria-label="Setup steps">
        {w.steps.map((s, i) => {
          const open = s.state === 'current' || editing === s.key
          return (
            <li key={s.key} className={`au-step ${s.state === 'done' || s.state === 'skipped' ? 'done' : ''} ${s.state === 'current' ? 'current' : ''}`} data-step={s.key} data-state={s.state === 'skipped' ? 'done' : s.state} data-raw-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
              <div className="n" aria-hidden="true">{s.state === 'done' ? <Icon name="check" size={16} /> : s.state === 'skipped' ? <Icon name="skip" size={14} /> : i + 1}</div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><h2 className="text-ink text-[1rem] font-medium">{s.title}</h2>{s.state === 'skipped' && <Badge tone="muted">Skipped</Badge>}{s.state === 'done' && <span className="sr-only">done</span>}</div>
                <p className="pt-1 text-[14px] text-grey">{s.body}</p>
                <StepBody step={s.key} open={open} w={w} busy={busy} base={base} op={op} reload={reload} onEdit={() => setEditing(s.key)} />
              </div>
            </li>
          )
        })}
      </ol>
    </>
  )
}

type StepProps = {
  step: WizardView['steps'][number]['key']; open: boolean; w: WizardView; busy: string | null; base: string
  op: <R>(key: string, body: Record<string, unknown>, ok?: (r: R) => ReactNode) => Promise<void>
  reload: () => void | Promise<void>
  onEdit: () => void
}

function StepBody(p: StepProps) {
  const { step, w, open } = p
  if (step === 'business') return open ? <BusinessStep {...p} /> : w.business.saved ? <p className="pt-2 text-[13px] text-grey-h">{w.business.name} · {w.business.timezone} <EditButton {...p} /></p> : null
  if (step === 'products') return open ? <ProductsStep {...p} /> : w.productsChosen ? <p className="pt-2 text-[13px] text-grey-h">{productWords(w)} <EditButton {...p} /></p> : null
  if (step === 'connect') return <ConnectStep {...p} />
  if (step === 'agreements') return <AgreementsStep {...p} />
  if (step === 'discover') return open ? <DiscoverStep {...p} /> : w.discovery.ran ? <p className="pt-2 text-[13px] text-grey-h">{w.discovery.activeAgents} agent{w.discovery.activeAgents === 1 ? '' : 's'} working at drafts only. <Link href={`${p.base}/discover`} className="text-ink underline">Open discovery</Link></p> : null
  return <DoneStep {...p} />
}

function productWords(w: WizardView) {
  const parts = [w.products.includes('commerce') ? `Deploi Commerce (${PLATFORM_LABEL[w.commercePlatform ?? 'shopify']})` : null, w.products.includes('office') ? 'Deploi Office' : null].filter(Boolean)
  return parts.join(' and ') || 'No products'
}

/** Reopen an earlier step; saving it again keeps the rest of the setup. */
function EditButton({ onEdit, busy, step }: StepProps) {
  return <button type="button" className="ml-2 text-ink underline" onClick={onEdit} disabled={busy !== null} aria-label={`Change ${step === 'business' ? 'business details' : 'products'}`}>Change</button>
}

function BusinessStep({ w, busy, op }: StepProps) {
  const [name, setName] = useState(w.business.name)
  const [tz, setTz] = useState(w.business.timezone || 'UTC')
  const zones = timeZones(tz)
  return (
    <form className="mt-3 flex max-w-[520px] flex-col gap-3" onSubmit={e => { e.preventDefault(); void op('business', { op: 'business', name, timezone: tz }) }}>
      <Field label="Business name" htmlFor="ob-name"><Input id="ob-name" value={name} maxLength={120} required onChange={e => setName(e.target.value)} autoComplete="organization" /></Field>
      <Field label="Time zone" htmlFor="ob-tz" hint="Agent schedules and the weekly summary use it."><Select id="ob-tz" value={tz} onChange={e => setTz(e.target.value)}>{zones.map(z => <option key={z} value={z}>{z}</option>)}</Select></Field>
      <div><Button type="submit" size="sm" disabled={busy !== null || !name.trim()}>{busy === 'business' ? 'Saving…' : 'Save and continue'}</Button></div>
    </form>
  )
}

function ProductsStep({ w, busy, op }: StepProps) {
  const [commerce, setCommerce] = useState(w.productsChosen ? w.products.includes('commerce') : true)
  const [office, setOffice] = useState(w.productsChosen ? w.products.includes('office') : false)
  const [platform, setPlatform] = useState<'shopify' | 'woocommerce'>(w.commercePlatform ?? (w.store.platform === 'woocommerce' ? 'woocommerce' : 'shopify'))
  const box = 'flex gap-3 rounded-[16px] border border-line p-4 cursor-pointer focus-within:ring-2 focus-within:ring-accent'
  return (
    <form className="mt-3 flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void op('products', { op: 'products', commerce, office, platform }) }}>
      <fieldset className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <legend className="sr-only">Products</legend>
        <label className={box}>
          <input type="checkbox" className="mt-1 h-4 w-4" checked={commerce} onChange={e => setCommerce(e.target.checked)} />
          <span><span className="block font-medium text-ink">Deploi Commerce</span><span className="block pt-1 text-[14px] text-grey">Agents that find stock and listing problems in your store and fix only what you grant.</span></span>
        </label>
        <label className={box}>
          <input type="checkbox" className="mt-1 h-4 w-4" checked={office} onChange={e => setOffice(e.target.checked)} />
          <span><span className="block font-medium text-ink">Deploi Office</span><span className="block pt-1 text-[14px] text-grey">Lead follow-up and scheduling with HubSpot and Google Calendar, at drafts only until you grant more.</span></span>
        </label>
      </fieldset>
      {commerce && (
        <fieldset className="flex flex-wrap gap-4 text-[15px]">
          <legend className="pb-2 text-[14px] text-grey">Your store platform</legend>
          {(['shopify', 'woocommerce'] as const).map(p => (
            <label key={p} className="inline-flex items-center gap-2 text-ink"><input type="radio" name="platform" value={p} checked={platform === p} onChange={() => setPlatform(p)} />{PLATFORM_LABEL[p]}</label>
          ))}
        </fieldset>
      )}
      <div><Button type="submit" size="sm" disabled={busy !== null || (!commerce && !office)}>{busy === 'products' ? 'Saving…' : 'Save and continue'}</Button></div>
      {!commerce && !office && <p className="text-[13px] text-warn">Choose at least one product.</p>}
    </form>
  )
}

function ConnectStep({ w, base }: StepProps) {
  const probes = useProbes(w.productsChosen ? [ROUTES.woocommerceConnect, ROUTES.officeConnections] : [])
  if (!w.productsChosen && !w.store.connected) return null
  const commerce = w.products.includes('commerce') || !w.productsChosen
  const office = w.products.includes('office')
  const avail = (path: string, label: string, href: string) => probes[path] === 'missing'
    ? <span className="text-grey-h">{label}: not available in this deployment yet.</span>
    : <Link href={href} className="text-ink underline">{label}</Link>
  return (
    <ul className="mt-2 flex flex-col gap-2 text-[14px]">
      {commerce && (
        <li data-connect="store">
          {w.store.connected
            ? <span className="text-grey-h"><Icon name="check" size={14} className="inline" /> Connected: {PLATFORM_LABEL[w.store.platform ?? 'shopify'] ?? w.store.platform} · {w.store.name}{w.store.synthetic ? ' (synthetic test store)' : ''}.</span>
            : w.commercePlatform === 'woocommerce'
              ? avail(ROUTES.woocommerceConnect, 'Connect your WooCommerce store', ROUTES.woocommerceConnect)
              : <Link href={`${base}/connect`} className="text-ink underline">Install Deploi on your Shopify store</Link>}
        </li>
      )}
      {office && (
        <li data-connect="office">
          {w.office.connected.length > 0 || w.office.mailboxes > 0
            ? <span className="text-grey-h"><Icon name="check" size={14} className="inline" /> Connected: {[...w.office.connected.map(p => OFFICE_LABEL[p] ?? p), ...(w.office.mailboxes ? [`${w.office.mailboxes} mailbox${w.office.mailboxes === 1 ? '' : 'es'}`] : [])].join(', ')}. </span>
            : null}
          {avail(ROUTES.officeConnections, w.office.connected.length ? 'Connect more Office tools' : 'Connect HubSpot, Google Calendar, QuickBooks or a mailbox', `${ROUTES.officeConnections}?from=setup`)}
        </li>
      )}
    </ul>
  )
}

const OFFICE_LABEL: Record<string, string> = { hubspot: 'HubSpot', google_calendar: 'Google Calendar', quickbooks: 'QuickBooks' }

/** Read from the real acceptances (LEGAL_GATE on); with the gate off the step is not needed here. */
function AgreementsStep({ w, open }: StepProps) {
  if (w.legal.gate === 'off') return <p className="pt-2 text-[13px] text-grey-h">Not required in this environment. You can read them any time in <Link href={ROUTES.legal} className="text-ink underline">Agreements</Link>.</p>
  if (w.legal.missing.length === 0) return <p className="pt-2 text-[13px] text-grey-h" role="status">All agreements accepted.</p>
  if (!open) return null
  return (
    <div className="mt-2 flex flex-col gap-2 text-[14px]">
      <p className="text-grey">Still to accept: {w.legal.missing.length}.</p>
      <div className="flex flex-wrap gap-2"><Link href={`${ROUTES.legal}?from=setup`} className="btn sm">Read and accept<Icon name="arrow-right" size={14} /></Link></div>
    </div>
  )
}

/** Discovery inside the setup: run it, set up the recommended team at drafts only, grant it. */
function DiscoverStep({ w, busy, op, reload }: StepProps) {
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="setup-discover">
      <DiscoverFlow embedded onChange={() => void reload()} />
      {!w.discovery.skipped && <div><Button size="xs" variant="ghost" onClick={() => void op('discover-skip', { op: 'discover-skip' })} disabled={busy !== null}>Not now</Button></div>}
    </div>
  )
}

function DoneStep({ w, busy, op, base }: StepProps) {
  if (w.completedAt) return <div className="mt-3"><Link href={base} className="btn sm">Go to the Command center<Icon name="arrow-right" size={14} /></Link></div>
  if (w.current !== 'done') return null
  return <div className="mt-3"><Button size="sm" onClick={() => void op('complete', { op: 'complete' }, () => 'Done. Your team is ready.')} disabled={busy !== null}><Icon name="check" size={15} />{busy === 'complete' ? 'Finishing…' : 'Finish setup'}</Button></div>
}
