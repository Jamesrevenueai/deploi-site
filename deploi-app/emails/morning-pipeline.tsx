/** @jsxRuntime automatic @jsxImportSource react */
import { Body, Container, Head, Heading, Html, Link, Preview, Section, Text, render } from '@react-email/components'
import type { MorningData, MorningItem } from '@/lib/sales/morning'

const grey = '#555555'
const line = '#E5E5E5'

function List({ title, items, empty }: { title: string; items: MorningItem[]; empty: string }) {
  return (
    <Section style={{ marginTop: 20 }}>
      <Heading as="h2" style={{ fontSize: 16, margin: '0 0 8px', color: '#000' }}>{title} <span style={{ color: grey, fontWeight: 400 }}>({items.length})</span></Heading>
      {items.length === 0 ? <Text style={{ color: grey, margin: 0 }}>{empty}</Text> : items.map(i => (
        <Text key={i.id} style={{ margin: '0 0 6px', borderBottom: `1px solid ${line}`, paddingBottom: 6 }}>
          <strong>{i.agency_name}</strong>{i.owner_name ? ` · ${i.owner_name}` : ''} · {i.stage}
          {i.when ? <span style={{ color: grey }}> · {String(i.when).slice(0, 10)}</span> : null}
          {i.note ? <><br /><span style={{ color: grey }}>{i.note}</span></> : null}
        </Text>
      ))}
    </Section>
  )
}

export function MorningPipelineEmail({ data }: { data: MorningData }) {
  return (
    <Html>
      <Head />
      <Preview>{`${data.replies.length} replies · ${data.callsToday.length} calls · ${data.followUpsDue.length} follow-ups · ${data.conversations.held}/${data.conversations.goal} conversations`}</Preview>
      <Body style={{ background: '#fff', fontFamily: 'Inter, -apple-system, Segoe UI, sans-serif', color: '#111' }}>
        <Container style={{ maxWidth: 560, padding: '24px 20px' }}>
          <Text style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>deploi</Text>
          <Heading style={{ fontSize: 22, margin: '16px 0 4px' }}>Morning pipeline</Heading>
          <Text style={{ color: grey, margin: 0 }}>{data.dateLabel}</Text>
          <Section style={{ marginTop: 16, padding: 14, border: `1px solid ${line}`, borderRadius: 12 }}>
            <Text style={{ margin: 0, fontSize: 15 }}>
              Owner conversations: <strong>{`${data.conversations.held} / ${data.conversations.goal}`}</strong>
              {data.conversations.held >= data.conversations.goal ? ' · gate open' : ` · ${data.conversations.goal - data.conversations.held} to go`}
            </Text>
          </Section>
          <List title="New replies" items={data.replies} empty="No replies in the last 24 hours." />
          <List title="Calls today" items={data.callsToday} empty="No calls booked for today." />
          <List title="Follow-ups due" items={data.followUpsDue} empty="Nothing due." />
          <Text style={{ marginTop: 24, color: grey, fontSize: 13 }}>
            <Link href={`${data.appUrl}/staff/pipeline`} style={{ color: '#000' }}>Open the pipeline</Link> · sent by Deploi (hello@getdeploi.com)
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export function morningPipelineText(d: MorningData) {
  const l = (items: MorningItem[]) => items.length ? items.map(i => `- ${i.agency_name}${i.owner_name ? ` (${i.owner_name})` : ''} · ${i.stage}${i.when ? ` · ${String(i.when).slice(0, 10)}` : ''}${i.note ? `\n    ${i.note}` : ''}`).join('\n') : '  none'
  return [
    `Deploi — morning pipeline · ${d.dateLabel}`, '',
    `Owner conversations: ${d.conversations.held} / ${d.conversations.goal}`, '',
    `New replies (${d.replies.length})`, l(d.replies), '',
    `Calls today (${d.callsToday.length})`, l(d.callsToday), '',
    `Follow-ups due (${d.followUpsDue.length})`, l(d.followUpsDue), '',
    `${d.appUrl}/staff/pipeline`,
  ].join('\n')
}

export async function renderMorningPipeline(data: MorningData) {
  const html = await render(<MorningPipelineEmail data={data} />)
  return { html, text: morningPipelineText(data) }
}
