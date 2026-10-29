'use client'
/** Plan and usage (/store/plan): the three tiers with their agents and allowance, this month's usage, and the tier to trial. Prices show "coming soon" until approved. */
import { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, useStore } from '@/components/store/bits'
import { LIBRARY } from '@/lib/library/config'
import { TIER_NAME } from './format'
import type { PlanResponse, TierKey } from './types'

export function PlanScreen() {
  const { base } = useStore()
  const params = useSearchParams()
  const highlight = params.get('upgrade') as TierKey | null
  const { data, error, loading, reload } = useLoad(() => storeFetch<PlanResponse>('/api/store/plan'), 'plan')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const header = <PageHeader eyebrow={<span className="au-eyebrow"><Icon name="badge" size={13} />Plan and usage</span>} title="Plans" sub="The plan decides which agents you can switch on and how many actions a month are included. Private beta: pick the plan to trial, nothing is charged, and prices are coming soon." />
  if (loading && !data) return <>{header}<Loading label="Loading plans" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const u = data.usage
  async function choose(tier: TierKey) {
    setBusy(tier); setNote(null)
    try { const r = await storeFetch<{ from: TierKey; to: TierKey; switchedOff: string[] }>('/api/store/plan', { method: 'POST', body: { tier } }); setNote({ tone: 'ok', text: `You are on ${TIER_NAME[r.to]}.${r.switchedOff.length ? ` Switched off: ${r.switchedOff.map(k => LIBRARY.agents.find(a => a.key === k)?.name ?? k).join(', ')}.` : ''}` }) }
    catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null); await reload() }
  }
  return (
    <>
      {header}
      <div aria-live="polite">{note && <div className="mb-4"><Banner tone={note.tone === 'ok' ? 'info' : 'warn'} icon={note.tone === 'ok' ? 'check' : 'alert'}>{note.text}</Banner></div>}</div>
      <section className="au-panel p-4 md:p-5" aria-label="This month">
        <div className="flex flex-wrap items-center gap-2"><Badge tone="ok">{TIER_NAME[u.tier]}</Badge><span className="text-[14px] text-grey">{u.actionsUsed} of {u.allowance} actions used in {u.month}{u.overageActions ? ` · ${u.overageActions} over` : ''} · estimated model cost ${u.estimatedModelCostUsd.toFixed(2)}{u.measured ? ' (measured)' : ' (estimated)'}</span></div>
        <div className={`au-meter mt-3 ${u.overageActions ? 'over' : ''}`}><span style={{ width: `${Math.min(100, Math.round((u.actionsUsed / Math.max(1, u.allowance)) * 100))}%` }} /></div>
        {u.byAgent.length > 0 && <ul className="mt-3 flex flex-wrap gap-2 text-[12px]">{u.byAgent.map(b => <li key={b.agentKey}><Badge tone="muted">{LIBRARY.agents.find(a => a.key === b.agentKey)?.name ?? b.agentKey}: {b.actions}</Badge></li>)}</ul>}
      </section>
      <section className="mt-6 grid gap-4 md:grid-cols-3" aria-label="Plans">
        {data.tiers.map(t => (
          <div key={t.key} className={`au-plan ${t.key === u.tier ? 'current' : ''} ${highlight === t.key ? 'glow' : ''}`} data-tier={t.key}>
            <div className="flex items-center justify-between"><h2 className="text-[1.2rem]">{t.name}</h2>{t.key === u.tier && <Badge tone="ok">Current</Badge>}</div>
            <p className="text-[14px] text-grey">{t.tagline}</p>
            <div className="price">{data.pricingStatus === 'published' ? <>${t.proposedPriceUsd}<small>/month</small></> : <span className="au-gradient-text text-[1.3rem]">Coming soon</span>}</div>
            <dl className="au-kv"><dt>Included actions</dt><dd>{t.monthlyActions} a month</dd><dt>Over the allowance</dt><dd>{data.pricingStatus === 'published' ? `$${t.proposedOverageUsd.toFixed(2)} per action` : 'paid per action, price coming soon'}</dd><dt>Agents</dt><dd>{t.agents.length} of 12{t.buildYourOwn ? ' + build your own' : ''}</dd></dl>
            <ul className="flex flex-col gap-1 text-[13px] text-grey">{t.agents.map(k => { const a = LIBRARY.agents.find(x => x.key === k)!; return <li key={k} className="flex items-center gap-2"><span aria-hidden="true">{a.character.emoji}</span>{a.name}</li> })}{t.buildYourOwn && <li className="flex items-center gap-2"><span aria-hidden="true">🛠️</span>Build your own agent</li>}</ul>
            <div className="mt-auto pt-2">{t.key === u.tier ? <Button size="sm" variant="ghost" disabled>Your plan</Button> : <Button size="sm" onClick={() => choose(t.key)} disabled={busy !== null} data-choose={t.key}>{busy === t.key ? 'Switching…' : `Trial ${t.name}`}</Button>}</div>
          </div>
        ))}
      </section>
      <p className="pt-4 text-[13px] text-grey-h">Prices need the founder&rsquo;s approval before they are shown or charged. Every action is tracked now so the allowance and overage are right on day one. <Link href={`${base}/team`} className="text-ink underline">Back to your team</Link></p>
    </>
  )
}
