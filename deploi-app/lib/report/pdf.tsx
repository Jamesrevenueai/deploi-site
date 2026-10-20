/**
 * Assessment report PDF: black-on-white print version of Black Glass, ≤ 6 pages.
 * Rendered server-side with @react-pdf/renderer (Helvetica; Inter is not bundled).
 */
import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { env } from '../env'
import { DOOR_SCOPE, ASSUMPTIONS, money, type Leak } from '../leaks'
import { STEPS, TRACE_TITLES, elapsedLabel, type Trace, type TraceStepRow } from '../assessments/steps'
import type { AssessmentRow } from '../assessments/queries'

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 11, color: '#666666', padding: 56, lineHeight: 1.45 },
  brand: { fontFamily: 'Helvetica-Bold', fontSize: 22, color: '#000', letterSpacing: -0.5 },
  h1: { fontFamily: 'Helvetica-Bold', fontSize: 30, color: '#000', letterSpacing: -0.6, lineHeight: 1.1, marginBottom: 10 },
  h1grey: { fontFamily: 'Helvetica-Bold', fontSize: 30, color: '#8A8A8A', letterSpacing: -0.6, lineHeight: 1.1 },
  h2: { fontFamily: 'Helvetica-Bold', fontSize: 18, color: '#000', letterSpacing: -0.3, marginBottom: 12 },
  h3: { fontFamily: 'Helvetica-Bold', fontSize: 12, color: '#000' },
  small: { fontSize: 9, color: '#8A8A8A' },
  pill: { borderWidth: 1, borderColor: '#000', borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, fontSize: 9, color: '#000', alignSelf: 'flex-start', marginBottom: 14 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#E6E6E6', paddingVertical: 7 },
  cell: { flex: 1 },
  timeline: { marginTop: 6 },
  tl: { flexDirection: 'row', marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#000', marginTop: 4, marginRight: 10 },
  dotEmpty: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: '#8A8A8A', marginTop: 4, marginRight: 10 },
  leak: { borderWidth: 1, borderColor: '#000', borderRadius: 12, padding: 14, marginBottom: 12 },
  big: { fontFamily: 'Helvetica-Bold', fontSize: 24, color: '#000', letterSpacing: -0.5 },
  footer: { position: 'absolute', bottom: 28, left: 56, right: 56, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#8A8A8A' },
})

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

function Footer({ agency }: { agency: string }) {
  return (
    <View style={s.footer} fixed>
      <Text>Deploi · Operations Assessment · {agency}</Text>
      <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
    </View>
  )
}

function Timeline({ trace, steps }: { trace: Trace; steps: TraceStepRow[] }) {
  const defs = STEPS[trace]
  return (
    <View style={s.timeline}>
      {defs.map((d, i) => {
        const st = steps.find(x => x.trace === trace && x.step_key === d.key)
        const prev = i > 0 ? steps.find(x => x.trace === trace && x.step_key === defs[i - 1].key) : null
        const el = prev ? elapsedLabel(prev.occurred_at, st?.occurred_at ?? null) : null
        return (
          <View style={s.tl} key={d.key} wrap={false}>
            <View style={st?.occurred_at ? s.dot : s.dotEmpty} />
            <View style={{ flex: 1 }}>
              <Text style={s.h3}>{d.title}{st?.outcome ? ` · ${st.outcome}` : ''}</Text>
              <Text style={s.small}>{fmt(st?.occurred_at ?? null)}{st?.who ? ` · ${st.who}` : ''}{el ? ` · +${el}` : ''}</Text>
              {st?.what_went_wrong ? <Text>What went wrong: {st.what_went_wrong}</Text> : null}
            </View>
          </View>
        )
      })}
    </View>
  )
}

export function ReportDocument({ a, steps }: { a: AssessmentRow; steps: TraceStepRow[] }) {
  const leaks: Leak[] = a.leaks ?? []
  const door = a.recommended_door ?? 'growth'
  const scope = DOOR_SCOPE[door]
  const total = leaks.reduce((x, l) => x + l.dollars_per_year, 0)
  const pricing = env.pricing
  const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  return (
    <Document title={`Operations Assessment — ${a.agency_name}`} author="Deploi" creator="Deploi">
      {/* 1. cover */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.brand}>deploi</Text>
        <View style={{ marginTop: 150 }}>
          <Text style={s.pill}>Operations Assessment</Text>
          <Text style={s.h1grey}>{a.agency_name}</Text>
          <Text style={s.h1}>Where it leaks, in dollars.</Text>
          <Text>One referral and one visit traced end to end. Three leaks sized. One door recommended first.</Text>
          <Text style={[s.small, { marginTop: 18 }]}>Prepared for {a.owner_name ?? 'the owner'} · {generated}</Text>
        </View>
        <View style={{ position: 'absolute', bottom: 70, left: 56 }}>
          <Text style={s.big}>{money(total)} / yr</Text>
          <Text style={s.small}>estimated across the three biggest leaks</Text>
        </View>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 2. referral trace */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>{TRACE_TITLES.referral}</Text>
        <Text style={{ marginBottom: 8 }}>One real referral, from the moment it arrived to the follow-up that makes the referrer send the next one.</Text>
        <Timeline trace="referral" steps={steps} />
        <Footer agency={a.agency_name} />
      </Page>
      {/* 3. visit trace */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>{TRACE_TITLES.visit}</Text>
        <Text style={{ marginBottom: 8 }}>One real visit, from scheduling through EVV to the claim being paid or denied.</Text>
        <Timeline trace="visit" steps={steps} />
        <Footer agency={a.agency_name} />
      </Page>
      {/* 4. leaks */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Three biggest leaks</Text>
        {leaks.length === 0 ? <Text>Leaks have not been calculated yet.</Text> : leaks.map((l, i) => (
          <View style={s.leak} key={l.key} wrap={false}>
            <Text style={s.small}>Leak {i + 1} · {l.door}</Text>
            <Text style={s.h3}>{l.label}</Text>
            <Text style={s.big}>{money(l.dollars_per_year)} / yr</Text>
            <Text style={s.small}>How we got there: {l.formula}</Text>
          </View>
        ))}
        <Text style={[s.small, { marginTop: 8 }]}>
          Assumptions: on-time response {ASSUMPTIONS.on_time_hours} h; {ASSUMPTIONS.lost_share_per_hour * 100}% of referrals lost per hour of delay (cap {ASSUMPTIONS.lost_share_cap * 100}%);
          {' '}{ASSUMPTIONS.unfilled_share * 100}% of open-shift hours never filled at ${ASSUMPTIONS.billed_rate_per_hour}/h and {ASSUMPTIONS.margin_share * 100}% margin;
          {' '}{money(ASSUMPTIONS.replacement_cost_per_aide)} to replace an aide; {ASSUMPTIONS.unrecovered_share * 100}% of denied claims never recovered. Estimates, not guarantees.
        </Text>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 5. door + pricing */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Recommended first door</Text>
        <Text style={s.pill}>{door}</Text>
        <Text style={s.h3}>{scope.title}</Text>
        {scope.scope.map(x => <Text key={x}>• {x}</Text>)}
        <Text style={{ marginTop: 6 }}>Built on the scheduler, EVV and phone line you already use. Live in weeks. Your systems stay.</Text>
        <Text style={[s.h2, { marginTop: 28 }]}>Pricing</Text>
        <View style={s.row}><Text style={s.cell}>Step 1 · Operations Assessment</Text><Text style={[s.cell, { color: '#000' }]}>{pricing.assessment}{a.fee_cents ? ` (paid ${money(a.fee_cents / 100)}, credited toward the build for 60 days)` : ''}</Text></View>
        <View style={s.row}><Text style={s.cell}>Step 2 · Build</Text><Text style={[s.cell, { color: '#000' }]}>{pricing.build}</Text></View>
        <View style={s.row}><Text style={s.cell}>Step 3 · Run (retainer)</Text><Text style={[s.cell, { color: '#000' }]}>{pricing.retainer}</Text></View>
        <Footer agency={a.agency_name} />
      </Page>
      {/* 6. next steps */}
      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Next steps</Text>
        {[
          'Pick the first door. We recommend the one above; you choose.',
          'Sign the Business Associate Agreement before any client data moves.',
          'Build: connected to your systems, with a how-to guide and 30 days of fixes.',
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
