/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Morning report email: six numbers in plain text + the three items that need a human.
 * Rendered with @react-email/components; sent from hello@getdeploi.com.
 */
import { Body, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text, render } from '@react-email/components'
import type { Metrics } from '@/lib/dashboard/metrics'

export type MorningReportProps = { metrics: Metrics; dateLabel: string; appUrl: string }

const ink = { color: '#111111', fontFamily: 'Inter, Helvetica, Arial, sans-serif' }
const grey = { ...ink, color: '#555555', fontSize: '14px', lineHeight: '20px', margin: '0' }
const rowStyle = { ...ink, fontSize: '16px', lineHeight: '24px', margin: '0 0 6px 0' }

export function lines(m: Metrics): { label: string; value: string }[] {
  return [
    { label: 'Referrals answered', value: `${m.referrals.today} today · ${m.referrals.week} this week · median ${m.referrals.medianMinutes ?? '—'} min to first response` },
    { label: 'Shifts', value: `${m.shifts.open} open · ${m.shifts.filledWeek} filled this week · median ${m.shifts.medianMinutesToFill ?? '—'} min to fill` },
    { label: 'EVV exceptions', value: `${m.exceptions.open} open · ${m.exceptions.fixedToday} fixed today${m.exceptions.openItems[0]?.daysLeft != null ? ` · soonest window closes in ${m.exceptions.openItems[0].daysLeft} days` : ''}` },
    { label: 'Authorization units', value: `${m.authorizations.lowCount} of ${m.authorizations.total} auths at ≤ 15% left (${m.authorizations.lowPct}%) · ${m.authorizations.expiring30} expire within 30 days` },
    { label: 'Applicants', value: `${m.applicants.new} new · ${m.applicants.screened} screened · ${m.applicants.interviewsBooked} interviews booked` },
    { label: 'Credential lapses', value: `${m.credentials.lapsing30} in the next 30 days` },
  ]
}

export function MorningReportEmail({ metrics, dateLabel, appUrl }: MorningReportProps) {
  const rows = lines(metrics)
  return (
    <Html lang="en">
      <Head />
      <Preview>{`Morning report for ${metrics.agency.name}: ${metrics.shifts.open} open shifts, ${metrics.exceptions.open} EVV exceptions`}</Preview>
      <Body style={{ backgroundColor: '#ffffff', margin: 0, padding: '24px 0' }}>
        <Container style={{ maxWidth: '560px', padding: '0 24px' }}>
          <Text style={{ ...ink, fontWeight: 700, fontSize: '22px', margin: '0 0 4px 0' }}>deploi</Text>
          <Heading as="h1" style={{ ...ink, fontSize: '22px', fontWeight: 600, margin: '16px 0 4px 0' }}>Morning report · {metrics.agency.name}</Heading>
          <Text style={grey}>{dateLabel}</Text>
          <Hr style={{ borderColor: '#e5e5e5', margin: '20px 0' }} />
          <Section>
            {rows.map(r => (
              <Text key={r.label} style={rowStyle}><strong>{r.label}:</strong> {r.value}</Text>
            ))}
          </Section>
          <Hr style={{ borderColor: '#e5e5e5', margin: '20px 0' }} />
          <Heading as="h2" style={{ ...ink, fontSize: '17px', fontWeight: 600, margin: '0 0 8px 0' }}>Needs a human today</Heading>
          {metrics.needsHuman.length === 0 && <Text style={rowStyle}>Nothing is waiting on a person this morning.</Text>}
          {metrics.needsHuman.map((h, i) => (
            <Text key={i} style={rowStyle}>{i + 1}. <strong>{h.title}</strong> — {h.detail} (<Link href={`${appUrl}${h.href}`} style={{ color: '#2F6BFF' }}>open</Link>)</Text>
          ))}
          <Hr style={{ borderColor: '#e5e5e5', margin: '20px 0' }} />
          <Text style={grey}>Full dashboard: <Link href={`${appUrl}/app/home`} style={{ color: '#2F6BFF' }}>{appUrl.replace(/^https?:\/\//, '')}/app/home</Link></Text>
          <Text style={grey}>Sent by Deploi · hello@getdeploi.com · Reply to this email to reach a person.</Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function buildMorningReport(metrics: Metrics, appUrl: string, now = new Date()) {
  const dateLabel = now.toLocaleDateString('en-US', { timeZone: metrics.agency.timezone || 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const el = <MorningReportEmail metrics={metrics} dateLabel={dateLabel} appUrl={appUrl} />
  const [html, text] = await Promise.all([render(el), render(el, { plainText: true })])
  return { subject: `${metrics.agency.name} — morning report, ${dateLabel}`, html, text }
}
