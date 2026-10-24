/**
 * Proposal PDF: a customer-readable commercial scope document for one engagement.
 * Black-on-white print version of Black Glass, rendered server-side with @react-pdf/renderer.
 * Carries the line "Commercial scope summary. Not a lawyer-reviewed contract." on every page.
 */
import React from 'react'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import { getService, AVAILABILITY_LABEL } from '../catalog/services'
import { getPricing, range, SCOPE_CONSIDERATIONS } from '../catalog/pricing'
import { INTEGRATIONS, INTEGRATION_LEVEL_LABEL } from '../catalog/integrations'
import { INPUT_METHOD_LABEL } from '../engagements/defaults'
import { STATUS_LABEL } from '../engagements/states'
import type { EngagementView } from '../engagements/types'

export const PROPOSAL_DISCLAIMER = 'Commercial scope summary. Not a lawyer-reviewed contract.'

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 10.5, color: '#444444', padding: 52, paddingBottom: 64, lineHeight: 1.45 },
  brand: { fontFamily: 'Helvetica-Bold', fontSize: 20, color: '#000', letterSpacing: -0.5 },
  h1: { fontFamily: 'Helvetica-Bold', fontSize: 26, color: '#000', letterSpacing: -0.6, lineHeight: 1.1, marginBottom: 8 },
  h1grey: { fontFamily: 'Helvetica-Bold', fontSize: 26, color: '#8A8A8A', letterSpacing: -0.6, lineHeight: 1.1 },
  h2: { fontFamily: 'Helvetica-Bold', fontSize: 15, color: '#000', letterSpacing: -0.3, marginTop: 14, marginBottom: 6 },
  h3: { fontFamily: 'Helvetica-Bold', fontSize: 11, color: '#000', marginTop: 8, marginBottom: 2 },
  small: { fontSize: 8.5, color: '#8A8A8A' },
  pill: { borderWidth: 1, borderColor: '#000', borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9, fontSize: 8.5, color: '#000', alignSelf: 'flex-start', marginBottom: 10 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#E6E6E6', paddingVertical: 5 },
  k: { width: 170, color: '#8A8A8A' },
  v: { flex: 1, color: '#000' },
  box: { borderWidth: 1, borderColor: '#000', borderRadius: 10, padding: 12, marginTop: 8 },
  big: { fontFamily: 'Helvetica-Bold', fontSize: 20, color: '#000', letterSpacing: -0.4 },
  footer: { position: 'absolute', bottom: 26, left: 52, right: 52, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#8A8A8A' },
  disclaimer: { position: 'absolute', bottom: 40, left: 52, right: 52, fontSize: 8, color: '#000' },
})

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—')

function Footer({ agency }: { agency: string }) {
  return (
    <>
      <Text style={s.disclaimer} fixed>{PROPOSAL_DISCLAIMER}</Text>
      <View style={s.footer} fixed>
        <Text>Deploi · Proposal · {agency}</Text>
        <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
      </View>
    </>
  )
}
const Row = ({ k, v }: { k: string; v: string | number | null | undefined }) => (
  <View style={s.row}><Text style={s.k}>{k}</Text><Text style={s.v}>{v == null || v === '' ? '—' : String(v)}</Text></View>
)
const List = ({ items, empty = 'None listed.' }: { items: string[]; empty?: string }) => (
  <View>{items.length ? items.map((x, i) => <Text key={i}>• {x}</Text>) : <Text style={s.small}>{empty}</Text>}</View>
)

export function ProposalDocument({ e, generatedAt = new Date() }: { e: EngagementView; generatedAt?: Date }) {
  const svc = getService(e.service_key)
  const p = getPricing()
  const integration = INTEGRATIONS.find(i => i.key === e.integration_key)
  const generated = generatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const net = Math.max(0, e.setup_fee_cents - e.credit_applied_cents)
  return (
    <Document title={`Proposal — ${e.agency_name} — ${svc?.name ?? e.service_key}`} author="Deploi AI" creator="Deploi AI">
      <Page size="LETTER" style={s.page}>
        <Text style={s.brand}>deploi</Text>
        <View style={{ marginTop: 120 }}>
          <Text style={s.pill}>Proposal · {STATUS_LABEL[e.status]}</Text>
          <Text style={s.h1grey}>{e.agency_name}</Text>
          <Text style={s.h1}>{svc?.name ?? e.service_key}</Text>
          <Text>{svc?.description}</Text>
          <Text style={[s.small, { marginTop: 14 }]}>Prepared for {e.agency_contact ?? e.owner_name ?? 'the owner'} · {generated}{svc ? ` · Service status: ${AVAILABILITY_LABEL[svc.availability]}` : ''}</Text>
        </View>
        <View style={{ position: 'absolute', bottom: 110, left: 52, right: 52 }}>
          <View style={{ flexDirection: 'row', gap: 28 }}>
            <View><Text style={s.big}>{money(e.setup_fee_cents)}</Text><Text style={s.small}>build and setup, one time{e.credit_applied_cents ? ` · ${money(e.credit_applied_cents)} assessment credit applied · ${money(net)} net` : ''}</Text></View>
            <View><Text style={s.big}>{money(e.monthly_fee_cents)} / mo</Text><Text style={s.small}>monthly management, {e.initial_term_months ?? p.management.initialTermMonths}-month initial term</Text></View>
          </View>
          <Text style={[s.small, { marginTop: 8 }]}>Published ranges: build {range(p.build)}, management {range(p.management)} per month. Exact scope sets the final quote.</Text>
        </View>
        <Footer agency={e.agency_name} />
      </Page>

      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>What we run for you</Text>
        <Text>{e.defined_workflow ?? svc?.description ?? '—'}</Text>
        <Text style={s.h3}>Included volume</Text>
        <Text>{e.included_volume != null ? `${e.included_volume.toLocaleString('en-US')} ${e.volume_units ?? ''}`.trim() : 'See usage terms.'}</Text>
        <Text style={s.h3}>Usage and overage</Text>
        <Text>{e.usage_terms ?? '—'}</Text>
        <Text style={s.h3}>Input and integration</Text>
        <Text>Input: {e.input_method ? INPUT_METHOD_LABEL[e.input_method] ?? e.input_method : '—'}{integration ? ` · ${integration.name}: ${INTEGRATION_LEVEL_LABEL[integration.level]}` : ' · no vendor integration; file or manual based'}</Text>
        {integration ? <Text style={s.small}>{integration.note} A vendor name is a compatibility statement, never a partnership claim.</Text> : null}
        <Text style={s.h2}>What is included</Text>
        <Text style={s.h3}>Build</Text>
        <List items={svc?.setupDeliverables ?? []} />
        <Text style={s.h3}>Monthly management</Text>
        <List items={svc?.ongoingDeliverables ?? []} />
        <Text style={s.h3}>Human review</Text>
        <List items={svc?.humanReview ?? []} />
        <Text style={s.h2}>Exclusions</Text>
        <List items={e.exclusions} />
        <Footer agency={e.agency_name} />
      </Page>

      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Implementation milestones</Text>
        <List items={e.milestones.map(m => `${m.title}${m.due_on ? ` — target ${m.due_on}` : ''}${m.done ? ' (done)' : ''}`)} empty="Milestones are set when the build is scheduled." />
        <Text style={s.h2}>Acceptance criteria</Text>
        <List items={e.acceptance_criteria} />
        <Text style={s.h2}>Responsibilities</Text>
        <Text style={s.h3}>{e.agency_name}</Text>
        <List items={svc?.customerResponsibilities ?? []} />
        <Text style={s.h3}>Deploi</Text>
        <List items={svc?.deploiResponsibilities ?? []} />
        <Text style={s.h2}>People, support and escalation</Text>
        <Row k="Agency contact" v={e.agency_contact} />
        <Row k="Deploi owner" v={e.deploi_owner} />
        <Row k="Action-approval owner" v={e.approval_owner} />
        <Row k="Support hours" v={e.support_hours ? `${e.support_hours} (${e.support_timezone ?? 'local time'})` : null} />
        <Row k="Escalation contact" v={e.escalation_contact} />
        <Row k="Fix period after go-live" v={e.fix_period_days != null ? `${e.fix_period_days} days` : null} />
        <Row k="Initial term" v={e.initial_term_months != null ? `${e.initial_term_months} months` : null} />
        <Footer agency={e.agency_name} />
      </Page>

      <Page size="LETTER" style={s.page}>
        <Text style={s.h2}>Pricing</Text>
        <Row k="Build and setup (one time)" v={money(e.setup_fee_cents)} />
        {e.credit_applied_cents ? <Row k="Assessment credit applied" v={`− ${money(e.credit_applied_cents)} (net ${money(net)})`} /> : null}
        <Row k="Monthly management" v={`${money(e.monthly_fee_cents)} per month`} />
        <Row k="Included in the build" v={p.build.includes.join(', ')} />
        <Row k="Included in management" v={p.management.includes.join(', ')} />
        <Text style={[s.small, { marginTop: 6 }]}>Not included in the lowest price: all workers, unlimited volume, continuous support, custom integrations. Volume above the included amount is quoted before it is billed.</Text>
        <Text style={s.h3}>Scope considerations</Text>
        {SCOPE_CONSIDERATIONS.map(c => <Text key={c.key}>• {c.label}: {c.note}</Text>)}
        <Text style={s.h2}>How we measure success</Text>
        {(svc?.successMeasures ?? []).map(m => <Text key={m.key}>• {m.label}: {m.definition}</Text>)}
        <Text style={s.h2}>Change requests</Text>
        <Text>{e.change_request_process ?? '—'}</Text>
        <View style={s.box}>
          <Text style={s.h3}>Acceptance</Text>
          <Text>{e.acceptance_evidence ? `Accepted by ${e.acceptance_evidence.accepted_by} on ${date(e.acceptance_evidence.accepted_at)} (${e.acceptance_evidence.method.replace(/_/g, ' ')}).` : 'Not yet accepted. Reply to the proposal email, return a signed copy, or confirm through the portal; we record the method, reference, who and when.'}</Text>
        </View>
        <Text style={[s.small, { marginTop: 10 }]}>{PROPOSAL_DISCLAIMER} Questions: hello@getdeploi.com</Text>
        <Footer agency={e.agency_name} />
      </Page>
    </Document>
  )
}

/** Render the proposal to PDF bytes. */
export function renderProposal(e: EngagementView, generatedAt?: Date) {
  return renderToBuffer(<ProposalDocument e={e} generatedAt={generatedAt} />)
}
