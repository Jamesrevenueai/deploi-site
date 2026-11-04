'use client'
/**
 * Setup wizard: business → products → connect → agreements → your first agents (created at drafts only,
 * granted only by the owner) → first scan → done. Every step is saved on the server, so the owner can
 * leave and come back; pressing a button twice never creates a second agent.
 */
import { useEffect, useState, type ReactNode } from 'react'
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
import { AuthorizationSummaryView } from '@/components/store/Agents'
import { PLATFORM_LABEL, templateToolWords } from '@/components/store/format'
import { probe, useProbes, ROUTES } from './probe'
import type { AutoSetupResult, WizardOpResponse, WizardResponse, WizardView } from './types'

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
  async function grant(agentId: string, policyId: string, policyHash: string, name: string) {
    setBusy(`grant:${agentId}`); setNote(null)
    try {
      await storeFetch(`/api/store/agents/${agentId}/grant`, { method: 'POST', body: { policyId, policyHash } })
      setNote({ tone: 'ok', text: <>{name} granted at drafts only. It shows you the exact change; it never makes it.</> })
      await reload()
    } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }

  const doneCount = w.steps.filter(s => s.state === 'done' || s.state === 'skipped').length
  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[14px] text-grey-h">
        <div className="h-2 w-48 overflow-hidden rounded-full bg-[#141a2b]" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={w.steps.length} aria-valuenow={doneCount}>
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
                <StepBody step={s.key} open={open} w={w} busy={busy} base={base} op={op} grant={grant} onEdit={() => setEditing(s.key)} />
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
  grant: (agentId: string, policyId: string, policyHash: string, name: string) => Promise<void>
  onEdit: () => void
}

function StepBody(p: StepProps) {
  const { step, w, open } = p
  if (step === 'business') return open ? <BusinessStep {...p} /> : w.business.saved ? <p className="pt-2 text-[13px] text-grey-h">{w.business.name} · {w.business.timezone} <EditButton {...p} /></p> : null
  if (step === 'products') return open ? <ProductsStep {...p} /> : w.productsChosen ? <p className="pt-2 text-[13px] text-grey-h">{productWords(w)} <EditButton {...p} /></p> : null
  if (step === 'connect') return <ConnectStep {...p} />
  if (step === 'agreements') return open ? <AgreementsStep {...p} /> : null
  if (step === 'agents') return open || w.agents.some(a => a.agentId) ? <AgentsStep {...p} /> : null
  if (step === 'scan') return open ? <ScanStep {...p} /> : w.scan ? <p className="pt-2 text-[13px] text-grey-h">Read {w.scan.resourcesScanned} variant{w.scan.resourcesScanned === 1 ? '' : 's'} · {w.scan.issuesOpened} new issue{w.scan.issuesOpened === 1 ? '' : 's'}.</p> : null
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
  const box = 'flex gap-3 rounded-[16px] border border-line p-4 cursor-pointer focus-within:ring-2 focus-within:ring-white/60'
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
      {office && <li data-connect="office">{avail(ROUTES.officeConnections, 'Connect HubSpot and Google Calendar in Deploi Office', ROUTES.officeConnections)} <span className="text-grey-h">(optional now; Office agents are set up there)</span></li>}
    </ul>
  )
}

function AgreementsStep({ busy, op }: StepProps) {
  const [check, setCheck] = useState<{ state: 'checking' | 'missing' | 'needed' | 'clear'; items: string[] }>({ state: 'checking', items: [] })
  useEffect(() => {
    let live = true
    void probe(ROUTES.legalApi).then(r => {
      if (!live) return
      if (r.availability === 'missing') return setCheck({ state: 'missing', items: [] })
      const j = (r.json ?? {}) as Record<string, unknown>
      const missing = Array.isArray(j.missing) ? j.missing.map(x => (typeof x === 'string' ? x : String((x as Record<string, unknown>)?.title ?? (x as Record<string, unknown>)?.key ?? 'agreement'))) : null
      if (r.status === 200 && (j.satisfied === true || (missing && missing.length === 0))) setCheck({ state: 'clear', items: [] })
      else setCheck({ state: 'needed', items: missing ?? [] })
    })
    return () => { live = false }
  }, [])
  useEffect(() => { if (check.state === 'clear') void op('agreements', { op: 'agreements', status: 'satisfied' }) }, [check.state]) // eslint-disable-line react-hooks/exhaustive-deps
  if (check.state === 'checking') return <p className="pt-2 text-[13px] text-grey-h" role="status">Checking your agreements…</p>
  if (check.state === 'missing') return (
    <div className="mt-2 flex flex-col gap-2 text-[14px]">
      <p className="text-grey-h">Agreements are not available in this deployment yet. You will be asked to accept them before anything is charged.</p>
      <div><Button size="sm" variant="ghost" onClick={() => void op('agreements', { op: 'agreements', status: 'skipped' })} disabled={busy !== null}>Continue</Button></div>
    </div>
  )
  if (check.state === 'clear') return <p className="pt-2 text-[13px] text-grey-h" role="status">All agreements accepted.</p>
  return (
    <div className="mt-2 flex flex-col gap-2 text-[14px]">
      {check.items.length > 0 && <ul className="list-disc pl-5 text-grey">{check.items.map(x => <li key={x}>{x}</li>)}</ul>}
      <div className="flex flex-wrap gap-2"><Link href={ROUTES.legal} className="btn sm">Read and accept<Icon name="arrow-right" size={14} /></Link></div>
    </div>
  )
}

function AgentsStep({ w, busy, op, grant, base, open }: StepProps) {
  const [read, setRead] = useState<Record<string, boolean>>({})
  if (!w.productsChosen) return null
  if (!w.products.includes('commerce')) return <p className="pt-2 text-[14px] text-grey-h">Deploi Office agents are set up in <Link href={ROUTES.office} className="text-ink underline">Deploi Office</Link>.</p>
  if (!w.store.connected) return <p className="pt-2 text-[14px] text-grey-h">Connect your store first; the agents work on it.</p>
  const missing = w.agents.filter(a => !a.agentId).length
  return (
    <div className="mt-3 flex flex-col gap-3">
      {missing > 0 && open && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void op<AutoSetupResult>('agents', { op: 'agents' }, r => r.failed.length ? <>Set up {r.created.length + r.existing.length} of {w.agents.length}. Not set up: {r.failed.map(f => `${f.key.replace(/_/g, ' ')} (${f.message})`).join('; ')}.</> : <>Your agents are ready at drafts only. Read what each may do, then grant it.</>)} disabled={busy !== null}>
            <Icon name="bolt" size={15} />{busy === 'agents' ? 'Setting up…' : missing === w.agents.length ? `Set up ${w.agents.length} recommended agents` : `Set up the ${missing} remaining agent${missing === 1 ? '' : 's'}`}
          </Button>
          <span className="text-[13px] text-grey-h">Created at drafts only. Nothing runs until you grant each one.</span>
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2" aria-label="Recommended agents">
        {w.agents.map(a => (
          <li key={a.key} className="rounded-[20px] border border-line p-4" data-agent-key={a.key} data-agent-status={a.status}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[1.05rem]">{a.agentId ? <Link href={`${base}/agents/${a.agentId}`} className="underline-offset-4 hover:underline">{a.name}</Link> : a.name}</h3>
              <span className="flex flex-wrap gap-2"><Badge tone="muted">Drafts only</Badge><Badge tone={a.status === 'active' ? 'ok' : a.status === 'not_created' ? 'muted' : 'warn'}>{a.status === 'active' ? 'Granted' : a.status === 'not_created' ? 'Not set up' : a.status === 'draft' ? 'Waiting for your grant' : a.status}</Badge></span>
            </div>
            <p className="pt-2 text-[14px] text-grey"><span className="text-ink">Its job: </span>{a.job}</p>
            <div className="flex flex-wrap gap-2 pt-2">{a.tools.filter(t => t !== 'email' || w.mailboxes).map(t => <Badge key={t} tone="muted">{templateToolWords(t as 'shopify' | 'email' | 'public_web')}</Badge>)}</div>
            {(a.pending?.summary ?? a.summary) && (
              <details className="mt-3" open={a.status === 'draft'}>
                <summary className="cursor-pointer text-[14px] text-ink">What it may do</summary>
                <div className="mt-2"><AuthorizationSummaryView summary={(a.pending?.summary ?? a.summary)!} /></div>
              </details>
            )}
            {a.status === 'draft' && a.pending && (
              <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
                <label className="inline-flex items-start gap-2 text-[14px] text-ink">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={Boolean(read[a.key])} onChange={e => setRead({ ...read, [a.key]: e.target.checked })} />
                  I have read what {a.name} may do. It shows changes and drafts; it never makes or sends them.
                </label>
                <div><Button size="sm" onClick={() => void grant(a.agentId!, a.pending!.policyId, a.pending!.policyHash, a.name)} disabled={busy !== null || !read[a.key]} aria-label={`Grant ${a.name} at drafts only`}><Icon name="check" size={15} />{busy === `grant:${a.agentId}` ? 'Granting…' : 'Grant at drafts only'}</Button></div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {open && !w.agentsSkipped && <div><Button size="xs" variant="ghost" onClick={() => void op('agents-skip', { op: 'agents-skip' })} disabled={busy !== null}>Skip for now</Button></div>}
    </div>
  )
}

function ScanStep({ busy, op }: StepProps) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button size="sm" onClick={() => void op<{ resourcesScanned: number; issuesOpened: number }>('scan', { op: 'scan' }, r => <>First scan finished: read {r.resourcesScanned} variants and found {r.issuesOpened} new issue{r.issuesOpened === 1 ? '' : 's'}. Nothing was changed.</>)} disabled={busy !== null}>
        <Icon name="search" size={15} />{busy === 'scan' ? 'Scanning…' : 'Run the first scan'}
      </Button>
      <span className="text-[13px] text-grey-h">Reads only. It can take a minute on a large catalogue.</span>
    </div>
  )
}

function DoneStep({ w, busy, op, base }: StepProps) {
  if (w.completedAt) return <div className="mt-3"><Link href={`${base}/control-room`} className="btn sm">Open the Control Room<Icon name="arrow-right" size={14} /></Link></div>
  if (w.current !== 'done') return null
  return <div className="mt-3"><Button size="sm" onClick={() => void op('complete', { op: 'complete' }, () => 'Done. Your team is ready.')} disabled={busy !== null}><Icon name="check" size={15} />{busy === 'complete' ? 'Finishing…' : 'Finish setup'}</Button></div>
}
