import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getConversationGate } from '@/lib/sales/conversations'
import { INTEGRATIONS, INTEGRATION_LEVEL_LABEL } from '@/lib/catalog/integrations'
import { CONNECTORS } from '@/lib/evv/connectors'
import { loadRuleSets, pickRuleSet, ruleSourceLabel, DEADLINE_NOT_CONFIGURED } from '@/lib/evv/window'
import { lastSuccessfulImport } from '@/lib/imports/provenance'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/Icon'
import { EvvView, type Tab } from '@/components/evv/EvvView'
import { ImportFreshness } from '@/components/actions/ImportFreshness'

export const metadata = { title: 'EVV exceptions' }
export const dynamic = 'force-dynamic'

export default async function StaffEvv({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const tab = (['open', 'corrected', 'hold'].includes(sp.tab ?? '') ? sp.tab : 'open') as Tab
  const { agencies, gate } = await withUser(session, async db => ({
    agencies: await db.query<{ id: string; name: string; state: string }>('select id, name, state from agencies order by name'),
    gate: await getConversationGate(db),
  }), { ip })
  const agencyId = agencies.find(a => a.id === sp.agency)?.id ?? agencies.find(a => a.name.startsWith('Buckeye'))?.id ?? agencies[0]?.id
  const agency = agencies.find(a => a.id === agencyId)

  const detail = agencyId ? await withUser(session, async db => {
    const rules = await loadRuleSets(db, agencyId, agency?.state)
    const programs = await db.query<{ program: string | null }>('select distinct program from clients where agency_id = $1 order by program nulls last', [agencyId])
    const today = new Date()
    const resolution = programs.map(p => ({ program: p.program, rule: pickRuleSet(rules, { agencyId, state: agency?.state, program: p.program, payer: null, date: today }) }))
    return { rules, resolution, freshness: await lastSuccessfulImport(db, 'evv_visits', agencyId) }
  }, { ip }) : null

  const evvIntegrations = INTEGRATIONS.filter(i => i.kind === 'evv')

  return (
    <>
      <PageHeader
        title="EVV exceptions"
        sub="Visits checked against EVV and the authorization, sorted by the correction window. Deadlines come only from a configured rule set; everything here is advisory."
        actions={<><Button variant="ghost" size="sm" href="/staff/evv/rules"><Icon name="list" size={15} />EVV rules</Button><Button href={`/staff/evv/import?agency=${agencyId ?? ''}`} size="sm"><Icon name="upload" size={16} />Import visits</Button></>}
      />

      <form method="get" className="mb-5 flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value={tab} />
        <label htmlFor="agency" className="text-[14px] text-grey-h">Agency</label>
        <div className="w-full max-w-xs"><Select id="agency" name="agency" defaultValue={agencyId}>{agencies.map(a => <option key={a.id} value={a.id}>{a.name} · {a.state}</option>)}</Select></div>
        <button className="btn ghost xs" type="submit">Switch</button>
      </form>

      {detail && (
        <div className="mb-5 grid gap-3 md:grid-cols-2">
          <section className="rounded-[20px] border border-line p-4">
            <div className="flex items-center justify-between gap-2"><h2 className="text-[15px] text-ink font-medium">Correction deadlines · {agency?.state}</h2><Link href="/staff/evv/rules" className="text-[13px] underline text-ink">Manage</Link></div>
            {detail.rules.length === 0 ? (
              <p className="mt-2 text-[14px] text-grey"><Badge tone="muted">{DEADLINE_NOT_CONFIGURED}</Badge> No EVV rule set applies to this agency. Exceptions show no deadline until one is added and verified; no default is assumed.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1 text-[14px]">
                {detail.resolution.map(r => (
                  <li key={r.program ?? '—'} className="flex flex-wrap items-center gap-2">
                    <span className="text-grey-h min-w-[9ch]">{r.program ?? 'no program'}</span>
                    {r.rule ? <><span className="text-ink">{r.rule.correction_window_days == null ? 'window not set' : `${r.rule.correction_window_days} days`}</span><span className="text-grey-h">· {r.rule.unit_minutes}-min units, {r.rule.unit_rounding}</span>{!r.rule.verified && <Badge tone="warn">unverified</Badge>}<span className="text-[12px] text-grey-h">{ruleSourceLabel(r.rule)}</span></>
                      : <Badge tone="muted">{DEADLINE_NOT_CONFIGURED}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-[20px] border border-line p-4">
            <h2 className="text-[15px] text-ink font-medium">Vendor connectors</h2>
            <p className="mt-1 text-[13px] text-grey-h">Every vendor runs on CSV export. Live connectors are stubs and stay blocked behind the discovery-call gate: {gate.held}/{gate.goal} held owner conversations (<Link href="/staff/conversations" className="underline text-ink">conversations</Link>).</p>
            <ul className="mt-2 flex flex-col gap-1 text-[13px]">
              {evvIntegrations.map(i => {
                const c = CONNECTORS.find(x => x.vendor === i.key)
                return (
                  <li key={i.key} className="flex flex-wrap items-center gap-2">
                    <span className="text-ink">{i.name}</span>
                    <Badge tone="none">{INTEGRATION_LEVEL_LABEL[i.level]}</Badge>
                    <Badge tone="muted">live connector: {gate.open ? 'gate open, not built' : 'stub, blocked'}{c ? ` · ${c.status === 'first' ? 'first in line' : 'next'}` : ''}</Badge>
                  </li>
                )
              })}
            </ul>
          </section>
        </div>
      )}
      {detail && <div className="mb-5"><ImportFreshness kind="evv_visits" info={detail.freshness} href={`/staff/evv/import?agency=${agencyId}`} /></div>}
      {detail?.freshness.stale && <div className="mb-5"><Banner tone="warn" icon="clock"><strong>EVV data may be stale.</strong> The last successful visit import is {detail.freshness.days == null ? 'missing' : `${detail.freshness.days} days old (limit ${detail.freshness.thresholdDays})`}. Exceptions below reflect the data as of that import.</Banner></div>}

      {agencyId ? <EvvView session={session} agencyId={agencyId} tab={tab} basePath="/staff/evv" extraQuery={`&agency=${agencyId}`} /> : null}
      <p className="mt-6 text-[13px] text-grey-h">Red at 7 days or less. &ldquo;Deadline not configured&rdquo; means no rule set matched; it is never replaced with a default number.</p>
    </>
  )
}
