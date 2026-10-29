'use client'
/** Small shared pieces for the merchant screens: context, badges, loading / error / blocked states. */
import { createContext, useContext, type ReactNode } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Icon } from '@/components/ui/Icon'
import { OUTCOME_LABEL, type Outcome } from '@/lib/engine/outcomes'
import { OUTCOME_TONE, SEVERITY_LABEL, SEVERITY_TONE } from './format'
import type { StoreApiError } from './api'

type Ctx = { base: '/store' | '/shopify'; embedded: boolean }
const StoreCtx = createContext<Ctx>({ base: '/store', embedded: false })

export function StoreProvider({ base, children }: { base: Ctx['base']; children: ReactNode }) {
  return <StoreCtx.Provider value={{ base, embedded: base === '/shopify' }}>{children}</StoreCtx.Provider>
}
export function useStore() { return useContext(StoreCtx) }

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>
}
export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge tone={SEVERITY_TONE[severity] ?? 'muted'}>{SEVERITY_LABEL[severity] ?? severity}</Badge>
}
export function SyntheticBadge() {
  return <Badge tone="warn">Synthetic test store</Badge>
}

export function Section({ title, sub, children, actions, id }: { title: ReactNode; sub?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="mt-8 fade-up" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id ? `${id}-h` : undefined} className="text-[1.15rem]">{title}</h2>
          {sub && <p className="pt-1 text-[14px] text-grey-h">{sub}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** Bordered panel used for cards that are not image cards */
export function Panel({ children, className = '', tone }: { children: ReactNode; className?: string; tone?: 'warn' | 'ok' | 'danger' }) {
  const border = tone === 'warn' ? 'border-[#4a3a1a]' : tone === 'ok' ? 'border-[#1f3a2a]' : tone === 'danger' ? 'border-[#4a2222]' : 'border-line'
  return <div className={`rounded-[20px] border ${border} p-4 md:p-5 min-w-0 ${className}`}>{children}</div>
}

export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[15px] sm:grid-cols-[minmax(140px,max-content)_1fr]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-grey-h">{k}</dt>
          <dd className="m-0 min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Loading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-[20px] border border-line bg-[#0A0A0A]" />
      ))}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: StoreApiError; onRetry?: () => void }) {
  const { embedded } = useStore()
  const known: Record<string, [string, ReactNode]> = {
    unauthenticated: ['Signed out', embedded ? 'Reload the app from your Shopify admin.' : <>Your session ended. <Link href="/login"><span className="underline text-ink">Sign in again</span></Link>.</>],
    invalid_session_token: ['Shopify did not confirm this session', 'Reload the app from your Shopify admin.'],
    not_installed: ['Installation not finished', 'This store has not finished installing Deploi. Open the app from your Shopify admin to finish installing it.'],
    not_a_merchant: ['No store on this account', 'This account is not linked to a store organization. Ask the store owner to invite you.'],
    shopify_not_configured: ['Shopify app not configured', 'The Shopify app credentials are not set on this Deploi environment.'],
    bad_origin: ['Request refused', 'The request did not come from the Deploi app. Reload the page and try again.'],
    network: ['Could not reach Deploi', 'Check your connection and try again.'],
    forbidden: ['Not allowed', error.message],
  }
  const [title, body] = known[error.code] ?? ['Something went wrong', error.message]
  return (
    <div className="fade-up" role="alert">
      <Banner tone="warn"><strong>{title}.</strong> {body}</Banner>
      {onRetry && <button type="button" className="btn ghost sm mt-3" onClick={onRetry}><Icon name="bolt" size={15} />Try again</button>}
    </div>
  )
}

/** Shown when the organization has no active store connection yet */
export function NoStore() {
  const { base, embedded } = useStore()
  return (
    <div className="rounded-[20px] border border-line p-6 fade-up">
      <div className="text-ink font-medium">No store connected</div>
      <p className="pt-2 text-[15px] text-grey">
        {embedded
          ? 'Deploi has not finished connecting to this store. Reload the app from your Shopify admin.'
          : 'Deploi works with one connected store. Install (or reinstall) the Shopify app from your Shopify admin; once it is connected, your store shows up here.'}
      </p>
      {!embedded && <Link href={`${base}/connect`} className="btn ghost sm mt-4">Store setup<Icon name="arrow-right" size={15} /></Link>}
    </div>
  )
}

/** Filter chip row (links or buttons) */
export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-2 text-[14px]" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} aria-pressed={value === v}
          className={`badge cursor-pointer ${value === v ? '' : 'muted'}`} style={{ padding: '6px 12px' }}>{l}</button>
      ))}
    </div>
  )
}
