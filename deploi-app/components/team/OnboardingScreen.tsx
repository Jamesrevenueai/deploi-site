'use client'
/** Private-beta onboarding: connect the store, choose the plan to trial, switch on the first agents, done. */
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, useStore } from '@/components/store/bits'
import { TIER_NAME } from './format'
import type { OnboardingResponse, TierKey } from './types'

export function OnboardingScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<OnboardingResponse>('/api/store/onboarding'), 'onboarding')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const header = <PageHeader eyebrow={<span className="au-eyebrow"><Icon name="spark" size={13} />Private beta</span>} title="Set up your team" sub="Four steps. Nothing changes in your store until you approve it." />
  if (loading && !data) return <>{header}<Loading label="Loading" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const order = data.steps.map(s => s.key)
  const idx = order.indexOf(data.current)
  async function chooseTier(tier: TierKey) { setBusy(tier); setNote(null); try { await storeFetch('/api/store/plan', { method: 'POST', body: { tier } }); setNote(`Trialling ${TIER_NAME[tier]}. Now switch on your first agents.`) } catch (e) { setNote(asApiError(e).message) } finally { setBusy(null); await reload() } }
  async function finish() { setBusy('done'); setNote(null); try { await storeFetch('/api/store/onboarding', { method: 'POST', body: {} }); setNote('Done. Your team is ready.') } catch (e) { setNote(asApiError(e).message) } finally { setBusy(null); await reload() } }
  return (
    <>
      {header}
      {note && <div className="mb-4"><Banner icon="check">{note}</Banner></div>}
      <div className="au-panel p-4 md:p-5">
        {data.steps.map((s, i) => {
          const done = i < idx || data.current === 'done'
          const current = s.key === data.current
          return (
            <div key={s.key} className={`au-step ${done ? 'done' : ''} ${current ? 'current' : ''}`} data-step={s.key} data-state={done ? 'done' : current ? 'current' : 'todo'}>
              <div className="n">{done ? <Icon name="check" size={16} /> : i + 1}</div>
              <div>
                <div className="text-ink font-medium">{s.title}</div>
                <p className="pt-1 text-[14px] text-grey">{s.body}</p>
                {s.key === 'connect' && (current || done) && <p className="pt-2 text-[13px] text-grey-h">{data.store.connected ? <>Connected: {data.store.name}{data.store.synthetic ? ' (synthetic test store)' : ''}.</> : <>No store yet. <Link href={`${base}/connect`} className="text-ink underline">Install Deploi on your Shopify store</Link>.</>}</p>}
                {s.key === 'tier' && (current || done) && (
                  <div className="mt-3 flex flex-wrap gap-2">{data.tiers.map(t => <Button key={t.key} size="xs" variant={data.tier === t.key && data.state.tierChosen ? 'primary' : 'ghost'} onClick={() => chooseTier(t.key)} disabled={busy !== null} data-choose={t.key}>{t.name} · {t.agents.length} agents{t.buildYourOwn ? ' + your own' : ''}</Button>)}</div>
                )}
                {s.key === 'agents' && (current || done) && <p className="pt-2 text-[13px] text-grey-h">{data.agentsOn} agent{data.agentsOn === 1 ? '' : 's'} on. <Link href={`${base}/team`} className="text-ink underline">Open your team</Link> and flip a switch.</p>}
                {s.key === 'done' && current && !data.state.completedAt && <div className="mt-3"><Button size="sm" onClick={finish} disabled={busy !== null}><Icon name="check" size={15} />{busy === 'done' ? 'Finishing…' : 'Finish setup'}</Button></div>}
                {s.key === 'done' && data.state.completedAt ? <div className="mt-3"><Link href={`${base}/team`} className="btn sm">Go to your team<Icon name="arrow-right" size={14} /></Link></div> : null}
              </div>
            </div>
          )
        })}
      </div>
      <p className="pt-4 text-[13px] text-grey-h">Private beta is for up to five stores, as an unlisted Shopify app. The feedback button at the bottom right goes straight to us.</p>
    </>
  )
}
