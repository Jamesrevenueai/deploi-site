/**
 * Assessment report PDF: black-on-white print version of Black Glass, ≤ 6 pages.
 * Rendered server-side with @react-pdf/renderer (Helvetica; Inter is not bundled).
 *
 * Pages: 1 cover · 2 the two traces · 3 three principal supported problems (category, grade, low/base/high, formula)
 *        4 evidence quality, baseline, assumptions and limitations · 5 recommended first workflow, success metric, pricing · 6 next steps
 */
import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { getPricing, range } from '../catalog/pricing'
import { DOOR_SCOPE, ASSUMPTIONS, money, categoryTotals, CATEGORY_LABEL, CATEGORY_HELP, GRADE_LABEL, LEAK_CATEGORIES, INPUT_STATUS_LABEL, type Leak, type InputKey } from '../leaks'
import { STEPS, TRACE_TITLES, elapsedLabel, type Trace, type TraceStepRow } from '../assessments/steps'
import { parseEvidence, provenanceSummary, INPUT_LABEL } from '../assessments/evidence'
import { recommendedService, successMetric } from '../assessments/recommend'
import type { AssessmentRow } from '../assessments/queries'

export const REPORT_MAX_PAGES = 6

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 10.5, color: '#666666', padding: 52, lineHeight: 1.4 },
  brand: { fontFamily: 'Helvetica-Bold', fontSize: 22, color: '#000', letterSpacing: -0.5 },
  h1: { fontFamily: 'Helvetica-Bold', fontSize: 30, color: '#000', letterSpacing: -0.6, lineHeight: 1.1, marginBottom: 10 },
  h1grey: { fontFamily: 'Helvetica-Bold', fontSize: 30, color: '#8A8A8A', letterSpacing: -0.6, lineHeight: 1.1 },
  h2: { fontFamily: 'Helvetica-Bold', fontSize: 18, color: '#000', letterSpacing: -0.3, marginBottom: 10 },
  h3: { fontFamily: 'Helvetica-Bold', fontSize: 11, color: '#000' },
  small: { fontSize: 8.5, color: '#8A8A8A' },
  tiny: { fontSize: 7.5, color: '#8A8A8A' },
  pill: { borderWidth: 1, borderColor: '#000', borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9, fontSize: 8.5, color: '#000', alignSelf: 'flex-start', marginBottom: 12 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#E6E6E6', paddingVertical: 6 },
  cell: { flex: 1 },
  cols: { flexDirection: 'row', gap: 18 },
  col: { flex: 1 },
  tl: { flexDirection: 'row', marginBottom: 5 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#000', marginTop: 3, marginRight: 8 },
  dotEmpty: { width: 7, height: 7, borderRadius: 4, borderWidth: 1, borderColor: '#8A8A8A', marginTop: 3, marginRight: 8 },
  leak: { borderWidth: 1, borderColor: '#000', borderRadius: 10, padding: 11, marginBottom: 9 },
  big: { fontFamily: 'Helvetica-Bold', fontSize: 20, color: '#000', letterSpacing: -0.5 },
  footer: { position: 'absolute', bottom: 26, left: 52, right: 52, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#8A8A8A' },
})

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const label = (k: string) => INPUT_LABEL[k as InputKey] ?? k.replace(/_/g, ' ')
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

function Footer({ agency }: { agency: string }) {
  return (
    <View style={s.footer} fixed>
      <Text>Deploi · Operations Assessment · {agency}</Text>
      <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </View>
  )
}

function Timeline({ trace, steps, redacted }: { trace: Trace; steps: TraceStepRow[]; redacted: boolean }) {
  const defs = STEPS[trace]
  return (
    <View style={s.col}>
      <Text style={s.h3}>{TRACE_TITLES[trace]}{redacted ? ' · redacted' : ''}</Text>
      <Text style={[s.small, { marginBottom: 6 }]}>{trace === 'referral' ? 'One referral from arrival to the follow-up that earns the next one.' : 'One visit from scheduling through EVV to the claim being paid or denied.'}</Text>
      {defs.map((d, i) => {
        const st = steps.find(x => x.trace === trace && x.step_key === d.key)
        const prev = i > 0 ? steps.find(x => x.trace === trace && x.step_key === defs[i - 1].key) : null
        const el = prev ? elapsedLabel(prev.occurred_at, st?.occurred_at ?? null) : null
        return (
          <View style={s.tl} key={d.key} wrap={false}>
            <View style={st?.occurred_at ? s.dot : s.dotEmpty} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 9.5, color: '#000' }}>{d.title}{st?.outcome ? ` · ${st.outcome}` : ''}</Text>
              <Text style={s.tiny}>{fmt(st?.occurred_at ?? null)}{st?.who ? ` · ${st.who}` : ''}{el ? ` · +${el}` : ''}</Text>
              {st?.what_went_wrong ? <Text style={{ fontSize: 8.5 }}>{clip(st.what_went_wrong, 140)}</Text> : null}
            </View>
          </View>
        )
      })}
    </View>
  )
}

export function ReportDocument({ a, steps }: { a: AssessmentRow; steps: TraceStepRow[] }) {
  const leaks: Leak[] = (a.leaks ?? []).slice(0, 3)
  const door = a.recommended_door ?? 'growth'
  const scope = DOOR_SCOPE[door]
  const totals = categoryTotals(leaks)
  const evidence = parseEvidence(a.evidence)
  const prov = provenanceSummary(leaks)
  const svc = recommendedService(leaks, door)
  const metric = successMetric(svc)
  const pricing = getPricing()
  const baseline = Object.entries(evidence.inputs).filter(([, e]) => e?.status === 'measured').map(([k]) => k)
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const illustrative = leaks.filter(l => l.illustrative)
  return (
    <Document title={`Operations Assessment — ${a.agency_name}`} author="Deploi AI" creator="Deploi AI">
      {/* 1. cover */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.brand}>deploi</Text>
        <View style={{ marginTop: 140 }}>
          <Text style={s.pill}>Operations Assessment</Text>
          <Text style={s.h1grey}>{a.agency_name}</Text>
          <Text style={s.h1}>Where it leaks, in dollars.</Text>
          <Text>One referral and one visit traced end to end. Three problems sized with their evidence grade. One workflow recommended first.</Text>
          <Text style={[s.small, { marginTop: 16 }]}>Prepared for {a.owner_name ?? 'the owner'} · {generated}</Text>
        </View>
        <View style={{ position: 'absolute', bottom: 66, left: 52, right: 52 }}>
          {LEAK_CATEGORIES.filter(c => totals[c] > 0).map(c => (
            <View key={c} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
              <Text style={s.small}>{CATEGORY_LABEL[c]}</Text>
              <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 12, color: '#000' }}>{money(totals[c])} / yr</Text>
            </View>
          ))}
          <Text style={s.tiny}>Base estimates, shown by category because they are different kinds of money. Low and high bounds are on page 3.</Text>
        </View>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 2. the two traces */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>What we traced</Text>
        <View style={s.cols}>
          <Timeline trace="referral" steps={steps} redacted={evidence.redacted} />
          <Timeline trace="visit" steps={steps} redacted={evidence.redacted} />
        </View>
        <Text style={[s.tiny, { marginTop: 10 }]}>Trace step fields are optional and may be aggregated or redacted; no patient information is recorded. The traces corroborate the problems below; they never set a frequency on their own.</Text>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 3. three principal supported problems */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Three principal supported problems</Text>
        {leaks.length === 0 ? <Text>Leaks have not been calculated yet.</Text> : leaks.map((l, i) => (
          <View style={s.leak} key={l.key} wrap={false}>
            <Text style={s.small}>Problem {i + 1} · {l.door} · {l.category ? CATEGORY_LABEL[l.category] : 'uncategorised'} · evidence grade {l.grade ? GRADE_LABEL[l.grade] : 'n/a'}{l.illustrative ? ' · illustrative (single traced event)' : ''}</Text>
            <Text style={s.h3}>{l.label}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
              <Text style={s.big}>{money(l.base ?? l.dollars_per_year)} / yr</Text>
              <Text style={s.small}>low {money(l.low ?? l.base ?? l.dollars_per_year)} · high {money(l.high ?? l.base ?? l.dollars_per_year)}</Text>
            </View>
            <Text style={s.small}>Formula: {l.formula}</Text>
            {l.assumptions ? <Text style={s.tiny}>Low: {l.assumptions.low}. Base: {l.assumptions.base}. High: {l.assumptions.high}.</Text> : null}
            {l.frequency_basis ? <Text style={s.tiny}>Frequency basis: {l.frequency_basis.kind === 'records' ? `records, ${l.frequency_basis.description}` : l.frequency_basis.description}</Text> : null}
          </View>
        ))}
        {leaks.length > 0 && <Text style={s.tiny}>{leaks.map(l => `${l.label}: ${l.category ? CATEGORY_HELP[l.category] : ''}`).join(' ')}</Text>}
        <Footer agency={a.agency_name} />
      </Page>
      {/* 4. evidence quality, baseline, assumptions and limitations */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Evidence quality</Text>
        <View style={s.row}><Text style={s.cell}>Evidence period</Text><Text style={[s.cell, { color: '#000' }]}>{evidence.period_start && evidence.period_end ? `${evidence.period_start} to ${evidence.period_end}` : 'not supplied'}</Text></View>
        <View style={s.row}><Text style={s.cell}>Sample size</Text><Text style={[s.cell, { color: '#000' }]}>{evidence.sample_size != null ? String(evidence.sample_size) : 'not supplied'}</Text></View>
        <View style={s.row}><Text style={s.cell}>Source reference</Text><Text style={[s.cell, { color: '#000' }]}>{evidence.source_reference ?? 'not supplied'}</Text></View>
        <View style={s.row}><Text style={s.cell}>Supplied by</Text><Text style={[s.cell, { color: '#000' }]}>{evidence.supplied_by ?? 'not supplied'}</Text></View>
        {(['measured', 'owner_reported', 'assumed'] as const).map(st => (
          <View style={s.row} key={st}><Text style={s.cell}>{INPUT_STATUS_LABEL[st]} inputs</Text><Text style={[s.cell, { color: '#000' }]}>{prov[st].length ? prov[st].map(label).join(', ') : '—'}</Text></View>
        ))}
        <View style={s.row}><Text style={s.cell}>Missing data</Text><Text style={[s.cell, { color: '#000' }]}>{evidence.missing.length ? evidence.missing.map(label).join(', ') : 'none'}</Text></View>
        <View style={s.row}><Text style={s.cell}>Customer corrections</Text><Text style={[s.cell, { color: '#000' }]}>{evidence.corrections.length ? evidence.corrections.map(c => `${label(c.field)}: ${c.previous || '—'} → ${c.corrected} (${c.by})`).join('; ') : 'none'}</Text></View>
        <Text style={[s.h3, { marginTop: 14 }]}>Baseline</Text>
        <Text style={s.small}>{baseline.length ? `Measured inputs that form the baseline: ${baseline.map(label).join(', ')}.` : 'No measured inputs yet. The baseline is set during the build from the first export, before any workflow runs.'}</Text>
        <Text style={[s.h3, { marginTop: 14 }]}>Assumptions</Text>
        <Text style={s.small}>
          On-time response {ASSUMPTIONS.on_time_hours} h; {ASSUMPTIONS.lost_share_per_hour * 100}% of referrals lost per hour of delay (range {ASSUMPTIONS.lost_share_per_hour_low * 100}–{ASSUMPTIONS.lost_share_per_hour_high * 100}%, cap {ASSUMPTIONS.lost_share_cap * 100}%);
          {' '}{ASSUMPTIONS.unfilled_share * 100}% of open-shift hours never filled (range {ASSUMPTIONS.unfilled_share_low * 100}–{ASSUMPTIONS.unfilled_share_high * 100}%) at ${ASSUMPTIONS.billed_rate_per_hour}/h and {ASSUMPTIONS.margin_share * 100}% margin;
          {' '}{money(ASSUMPTIONS.replacement_cost_per_aide)} to replace an aide (range {money(ASSUMPTIONS.replacement_cost_low)}–{money(ASSUMPTIONS.replacement_cost_high)});
          {' '}{ASSUMPTIONS.unrecovered_share * 100}% of denied dollars never recovered (range {ASSUMPTIONS.unrecovered_share_low * 100}–{ASSUMPTIONS.unrecovered_share_high * 100}%), the rest counted once as delayed payment;
          {' '}office time at ${ASSUMPTIONS.default_admin_hourly_cost}/h loaded unless supplied. Without broader records the low and high bounds are widened by ×{ASSUMPTIONS.illustrative_widening}.
        </Text>
        <Text style={[s.h3, { marginTop: 14 }]}>Limitations</Text>
        <Text style={s.small}>
          Estimates, not guarantees. {illustrative.length ? `${illustrative.map(l => l.label).join('; ')}: illustrative, sized from owner-reported averages because no broader records were supplied. ` : ''}
          Delayed payment is never counted as loss. Staff hours are capacity released, not cash, unless an expenditure change is recorded. Turnover is a replacement-cost estimate.
          The referral leak counts referrals never won; the denial leak is sized on billed revenue supplied as an input, so no dollar is counted twice. Grade A rests on measured exports, B on what the owner reported, C on an assumption.
        </Text>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 5. recommended first workflow, success metric, pricing */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Recommended first workflow</Text>
        <Text style={s.pill}>{door}</Text>
        <Text style={s.h3}>{scope.title}</Text>
        {scope.scope.map(x => <Text key={x}>• {x}</Text>)}
        <Text style={[s.h3, { marginTop: 12 }]}>First workflow: {svc.name}</Text>
        <Text style={s.small}>{svc.description}</Text>
        <Text style={[s.small, { marginTop: 4 }]}>Setup delivers: {svc.setupDeliverables.slice(0, 4).join('; ')}.</Text>
        {metric && (
          <View style={{ marginTop: 10 }}>
            <Text style={s.h3}>Proposed success metric: {metric.label}</Text>
            <Text style={s.small}>{metric.definition}</Text>
          </View>
        )}
        <Text style={{ marginTop: 8 }}>Built on the scheduler, EVV and phone line you already use. Live in weeks. Your systems stay.</Text>
        <Text style={[s.h2, { marginTop: 22 }]}>Pricing</Text>
        <View style={s.row}><Text style={s.cell}>Step 1 · Operations Assessment</Text><Text style={[s.cell, { color: '#000' }]}>{range(pricing.assessment)}{a.fee_cents ? ` (fee ${money(a.fee_cents / 100)}; the credit applies to a qualifying build under the configured terms: ${pricing.assessment.creditTermDays} days, never a standalone service)` : ''}</Text></View>
        <View style={s.row}><Text style={s.cell}>Step 2 · Build</Text><Text style={[s.cell, { color: '#000' }]}>{range(pricing.build)} · includes {pricing.build.includes.slice(0, 4).join(', ').toLowerCase()}, {pricing.build.fixPeriodDays}-day fix period</Text></View>
        <View style={s.row}><Text style={s.cell}>Step 3 · Monthly management</Text><Text style={[s.cell, { color: '#000' }]}>{range(pricing.management)} / mo · {pricing.management.initialTermMonths}-month initial term</Text></View>
        <Text style={[s.small, { marginTop: 8 }]}>Exact scope determines the final quote. The lowest price never includes all workers, unlimited volume, continuous support or custom integrations.</Text>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 6. next steps */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Next steps</Text>
        {[
          'Pick the first workflow. We recommend the one above; you choose.',
          'Sign the Business Associate Agreement before any client data moves.',
          'Build: connected to your systems, with a how-to guide and the fix period.',
          'Run: a morning report every day with referrals answered, shifts filled, exceptions fixed and units left.',
        ].map((x, i) => <Text key={x} style={{ marginBottom: 6 }}>{i + 1}. {x}</Text>)}
        <Text style={{ marginTop: 20 }}>Questions: hello@getdeploi.com</Text>
        <Footer agency={a.agency_name} />
      </Page>
    </Document>
  )
}

export async function buildReportPdf(a: AssessmentRow, steps: TraceStepRow[]): Promise<Buffer> {
  const buf = await renderToBuffer(<ReportDocument a={a} steps={steps} />)
  return Buffer.from(buf)
}
