/**
 * Email templates for owner and crew updates, registered on the system mailer (lib/email/system.ts):
 *
 *   agent_update         an agent tells the owner what it did: What happened / What I did / Proof / See details / Undo
 *   agent_action_needed  the same layout for an ask_first action: nothing was done yet, the owner decides
 *   crew_jobs            a crew member's jobs for the day, with addresses, details, photos, what changed and a
 *                        one-time "Mark done" link per job
 *   morning_report       the daily report (lib/notify/morning.ts)
 *
 * Email clients ignore stylesheets and CSS variables, so the HTML is tables with inline styles in a fixed
 * dark-on-light palette that mirrors the Aurora light-surface tokens (styles/aurora.css, `.surface-light`).
 * Every value from an agent, an owner or a crew member is escaped (html`` tag); links are only http(s) URLs or
 * app paths built here. Each template also renders a plain-text alternative. Structured content reaches a
 * template as JSON in params.data; single-use links travel in their own params (secretParams), so the stored
 * copy in system_emails never holds a working undo or "mark done" link.
 */
import { COMPANY_NAME } from '../env'
import { escapeHtml, html, raw, registerSystemTemplate, type Rendered } from '../email/system'
import type { ProofItem } from './index'

/** Light-surface Aurora tokens as literal colours (email clients cannot read CSS variables). */
export const EMAIL_PALETTE = {
  page: '#F5F6FA', surface: '#FFFFFF', ink: '#0B1020', body: '#3A4256', muted: '#5B6476', line: '#E7E9F1',
  accent: '#2347D1', accentSoft: '#EEF2FF', accentLine: '#C7D2FE', btn: '#0B1020', btnInk: '#FFFFFF',
  ok: '#047857', okSoft: '#ECFDF5', okLine: '#A7E3C9', warn: '#B45309', warnSoft: '#FFFBEB', warnLine: '#F6D69B',
  danger: '#C81E1E', dangerSoft: '#FEF2F2', dangerLine: '#F5B5B5',
} as const
const C = EMAIL_PALETTE
export const LINK_REMOVED = '[link removed]'

/** An http(s) URL, or null. Anything else (javascript:, data:, relative junk) is shown as text, never linked. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u || typeof u !== 'string' || u.length > 2000) return null
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null } catch { return null }
}
/** An app path ('/store/work/DC-1'): must start with one slash; anything else falls back. */
export function safePath(p: string | null | undefined, fallback = '/store/work'): string {
  return typeof p === 'string' && /^\/(?!\/)[A-Za-z0-9\-._~/%?=&#:@+]*$/.test(p) && p.length <= 300 ? p : fallback
}
export const appLink = (appUrl: string, path: string) => `${appUrl.replace(/\/$/, '')}${safePath(path)}`

const font = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

/** The outer frame: preheader, wordmark, the card, footer. `body` is already-safe HTML. */
export function frame(opts: { preheader: string; body: string; footer: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(COMPANY_NAME)}</title></head>`
    + `<body style="margin:0;padding:0;background:${C.page};${font};color:${C.ink};-webkit-text-size-adjust:100%">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${escapeHtml(opts.preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">`
    + `<tr><td style="padding:0 4px 12px;font-size:18px;font-weight:700;letter-spacing:-0.2px;color:${C.ink}">deploi<span style="color:${C.accent}">.</span></td></tr>`
    + `<tr><td style="background:${C.surface};border:1px solid ${C.line};border-radius:14px;padding:0">${opts.body}</td></tr>`
    + `<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:${C.muted}">${opts.footer}</td></tr>`
    + `</table></td></tr></table></body></html>`
}

export const sectionTitle = (t: string) => html`<tr><td style="padding:20px 24px 6px;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${C.muted}">${t}</td></tr>`
export const para = (t: string) => html`<tr><td style="padding:0 24px;font-size:15px;line-height:1.55;color:${C.body};white-space:pre-wrap">${t}</td></tr>`
export function emailButton(href: string, label: string, kind: 'primary' | 'secondary' = 'primary'): string {
  const s = kind === 'primary' ? `background:${C.btn};color:${C.btnInk};border:1px solid ${C.btn}` : `background:${C.surface};color:${C.ink};border:1px solid ${C.line}`
  return html`<a href="${href}" style="display:inline-block;${raw(s)};text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:999px;margin:0 8px 8px 0">${label}</a>`
}

type Tone = 'ok' | 'warn' | 'danger' | 'info'
const TONE: Record<Tone, { fg: string; bg: string; line: string }> = {
  ok: { fg: C.ok, bg: C.okSoft, line: C.okLine }, warn: { fg: C.warn, bg: C.warnSoft, line: C.warnLine },
  danger: { fg: C.danger, bg: C.dangerSoft, line: C.dangerLine }, info: { fg: C.accent, bg: C.accentSoft, line: C.accentLine },
}
export const pill = (label: string, tone: Tone) => html`<span style="display:inline-block;background:${TONE[tone].bg};color:${TONE[tone].fg};border:1px solid ${TONE[tone].line};border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700">${label}</span>`

/** Label/value rows; a value with an http(s) url becomes a link. */
export function proofTable(items: ProofItem[]): string {
  const rows = items.map((p, i) => {
    const url = safeUrl(p.url ?? null)
    const value = url ? html`<a href="${url}" style="color:${C.accent};text-decoration:underline;word-break:break-all">${p.value || url}</a>` : html`${p.value}`
    const border = i < items.length - 1 ? `border-bottom:1px solid ${C.line};` : ''
    return `<tr><td valign="top" style="${border}padding:10px 12px;font-size:13px;color:${C.muted};width:38%">${escapeHtml(p.label)}</td><td valign="top" style="${border}padding:10px 12px;font-size:14px;color:${C.ink};word-break:break-word">${value}</td></tr>`
  }).join('')
  return `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:10px;border-collapse:separate">${rows}</table></td></tr>`
}

// ------------------------------------------------------------------ owner update

export type UpdateData = {
  agentName: string; headline: string; whatHappened: string; whatIDid: string[]; proof: ProofItem[]
  caseRef?: string | null; severity: 'info' | 'action' | 'warning'; detailsPath: string; orgName?: string | null
}
const SEVERITY: Record<UpdateData['severity'], { label: string; tone: Tone; band: string }> = {
  info: { label: 'Done', tone: 'ok', band: C.ok },
  action: { label: 'Your decision needed', tone: 'info', band: C.accent },
  warning: { label: 'Check this', tone: 'warn', band: C.warn },
}

export function updateSubject(d: Pick<UpdateData, 'agentName' | 'headline' | 'severity'>): string {
  return d.severity === 'action' ? `[Deploi] ${d.agentName} needs your OK: ${d.headline}` : `[Deploi] ${d.agentName}: ${d.headline}`
}

/** Render an owner update. undoUrl: '' (none), a URL, or LINK_REMOVED (the stored copy). */
export function renderUpdate(d: UpdateData, appUrl: string, undoUrl: string): Rendered {
  const sev = SEVERITY[d.severity] ?? SEVERITY.info
  const action = d.severity === 'action'
  const details = appLink(appUrl, d.detailsPath)
  const did = d.whatIDid.filter(Boolean)
  const undo = undoUrl === LINK_REMOVED ? null : safeUrl(undoUrl)
  const body =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`
    + `<tr><td style="height:4px;background:${sev.band};border-radius:14px 14px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>`
    + `<tr><td style="padding:20px 24px 0">${pill(sev.label, sev.tone)} <span style="font-size:13px;color:${C.muted};padding-left:6px">${escapeHtml(d.agentName)}${d.caseRef ? ` · ${escapeHtml(d.caseRef)}` : ''}</span></td></tr>`
    + html`<tr><td style="padding:12px 24px 0;font-size:22px;line-height:1.3;font-weight:700;color:${C.ink}">${d.headline}</td></tr>`
    + sectionTitle('What happened') + para(d.whatHappened || 'No details were given.')
    + sectionTitle(action ? 'What I will do once you say yes' : 'What I did')
    + `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${(did.length ? did : ['Nothing yet.']).map(x => html`<tr><td valign="top" style="width:18px;padding:3px 0;font-size:15px;color:${sev.band}">${action ? '○' : '✓'}</td><td style="padding:3px 0;font-size:15px;line-height:1.5;color:${C.body}">${x}</td></tr>`).join('')}</table></td></tr>`
    + (d.proof.length ? sectionTitle('Proof') + proofTable(d.proof) : '')
    + `<tr><td style="padding:22px 24px 16px">${emailButton(details, action ? 'Review and decide' : 'See details')}${undo ? emailButton(undo, 'Undo', 'secondary') : ''}</td></tr>`
    + (undoUrl === LINK_REMOVED ? `<tr><td style="padding:0 24px 16px;font-size:12px;color:${C.muted}">An undo link was included in the email (removed from this stored copy).</td></tr>` : '')
    + (undo ? `<tr><td style="padding:0 24px 18px;font-size:12px;color:${C.muted}">Undo reverses this change. It works once.</td></tr>` : '')
    + `</table>`
  const footer = html`You get this because you are an owner or admin of ${d.orgName || 'this business'} on ${COMPANY_NAME}. Agents act within the rules you set and tell you after. `
    + html`<a href="${appLink(appUrl, '/store/settings#updates')}" style="color:${C.muted}">Choose how you get updates</a>.`
  const text = [
    `${sev.label.toUpperCase()} · ${d.agentName}${d.caseRef ? ` · ${d.caseRef}` : ''}`,
    d.headline, '',
    'WHAT HAPPENED', d.whatHappened || 'No details were given.', '',
    action ? 'WHAT I WILL DO ONCE YOU SAY YES' : 'WHAT I DID', ...(did.length ? did : ['Nothing yet.']).map(x => `- ${x}`),
    ...(d.proof.length ? ['', 'PROOF', ...d.proof.map(p => `- ${p.label}: ${p.value}${safeUrl(p.url ?? null) && safeUrl(p.url ?? null) !== p.value ? ` (${safeUrl(p.url ?? null)})` : ''}`)] : []),
    '', `${action ? 'Review and decide' : 'See details'}: ${details}`,
    ...(undo ? [`Undo (works once): ${undo}`] : undoUrl === LINK_REMOVED ? ['Undo: [link removed from the stored copy]'] : []),
    '', `Choose how you get updates: ${appLink(appUrl, '/store/settings#updates')}`,
  ].join('\n')
  return { subject: updateSubject(d), text, html: frame({ preheader: `${d.agentName}: ${d.whatHappened}`.slice(0, 140), body, footer }) }
}

// ------------------------------------------------------------------ crew job list

export type CrewJobView = {
  jobRef: string; address: string | null; details: string | null; photos: string[]; status: string
  /** the done-link param name for this job (params[doneParam] is the URL) */
  doneParam: string | null
  changes: string[]
}
export type CrewData = { crewName: string; orgName: string; dateLabel: string; intro: string; jobs: CrewJobView[] }
const mapsUrl = (a: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`

export function renderCrew(d: CrewData, links: Record<string, string>): Rendered {
  const open = d.jobs.filter(j => j.status !== 'done' && j.status !== 'cancelled')
  const jobBlock = (j: CrewJobView, i: number) => {
    const link = j.doneParam ? links[j.doneParam] : ''
    const done = link === LINK_REMOVED ? null : safeUrl(link)
    const st = j.status === 'done' ? pill('Done', 'ok') : j.status === 'cancelled' ? pill('Cancelled', 'danger') : ''
    const photos = j.photos.map(p => safeUrl(p)).filter((p): p is string => Boolean(p))
    return `<tr><td style="padding:${i ? 12 : 4}px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:10px;border-collapse:separate">`
      + `<tr><td style="padding:14px 16px 0;font-size:16px;font-weight:700;color:${C.ink}">${escapeHtml(`${i + 1}. ${j.jobRef}`)} ${st}</td></tr>`
      + (j.changes.length ? `<tr><td style="padding:8px 16px 0">${j.changes.map(c => `<div style="display:inline-block;background:${C.warnSoft};color:${C.warn};border:1px solid ${C.warnLine};border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600;margin:0 6px 4px 0">${escapeHtml(c)}</div>`).join('')}</td></tr>` : '')
      + (j.address ? html`<tr><td style="padding:8px 16px 0;font-size:14px;color:${C.body}"><strong style="color:${C.ink}">Address:</strong> <a href="${mapsUrl(j.address)}" style="color:${C.accent}">${j.address}</a></td></tr>` : '')
      + (j.details ? html`<tr><td style="padding:8px 16px 0;font-size:14px;line-height:1.5;color:${C.body};white-space:pre-wrap">${j.details}</td></tr>` : '')
      + (photos.length ? `<tr><td style="padding:8px 16px 0;font-size:14px;color:${C.body}"><strong style="color:${C.ink}">Photos:</strong> ${photos.map((p, k) => html`<a href="${p}" style="color:${C.accent}">photo ${k + 1}</a>`).join(' · ')}</td></tr>` : '')
      + `<tr><td style="padding:12px 16px 14px">${done ? emailButton(done, 'Mark done') : link === LINK_REMOVED ? `<span style="font-size:12px;color:${C.muted}">Mark-done link removed from this stored copy.</span>` : ''}</td></tr>`
      + `</table></td></tr>`
  }
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`
    + `<tr><td style="padding:20px 24px 0">${pill(`${open.length} job${open.length === 1 ? '' : 's'} today`, 'info')} <span style="font-size:13px;color:${C.muted};padding-left:6px">${escapeHtml(d.dateLabel)}</span></td></tr>`
    + html`<tr><td style="padding:12px 24px 0;font-size:22px;line-height:1.3;font-weight:700;color:${C.ink}">Hi ${d.crewName}, here are your jobs</td></tr>`
    + (d.intro ? html`<tr><td style="padding:8px 24px 0;font-size:15px;line-height:1.55;color:${C.body}">${d.intro}</td></tr>` : '')
    + sectionTitle("Today's jobs")
    + (d.jobs.length ? d.jobs.map(jobBlock).join('') : para('No jobs today.'))
    + `<tr><td style="padding:18px 24px 20px;font-size:13px;line-height:1.5;color:${C.muted}">Finished a job? Tap <strong>Mark done</strong> under it. Each link works once.</td></tr>`
    + `</table>`
  const footer = html`Sent by ${COMPANY_NAME} for ${d.orgName}. Questions about a job: ask the person who manages your work.`
  const text = [
    `Hi ${d.crewName}, your jobs for ${d.dateLabel} (${open.length} open):`, ...(d.intro ? ['', d.intro] : []), '',
    ...d.jobs.flatMap((j, i) => {
      const link = j.doneParam ? links[j.doneParam] : ''
      return [
        `${i + 1}. ${j.jobRef}${j.status === 'done' ? ' (done)' : j.status === 'cancelled' ? ' (cancelled)' : ''}`,
        ...j.changes.map(c => `   CHANGED: ${c}`),
        ...(j.address ? [`   Address: ${j.address}`] : []),
        ...(j.details ? [`   ${j.details.replace(/\n/g, '\n   ')}`] : []),
        ...j.photos.map(p => safeUrl(p)).filter(Boolean).map((p, k) => `   Photo ${k + 1}: ${p}`),
        ...(link === LINK_REMOVED ? ['   Mark done: [link removed from the stored copy]'] : safeUrl(link) ? [`   Mark done (works once): ${safeUrl(link)}`] : []),
        '',
      ]
    }),
    'Finished a job? Use its Mark done link. Each link works once.',
  ].join('\n')
  return { subject: `[Deploi] Your jobs for ${d.dateLabel}: ${open.length} open${d.jobs.some(j => j.changes.length) ? ' (changes inside)' : ''}`, text, html: frame({ preheader: `${open.length} job(s) for ${d.dateLabel}`, body, footer }) }
}

// ------------------------------------------------------------------ morning report

export type MorningData = {
  orgName: string; dateLabel: string; since: string
  did: { agentName: string; headline: string; severity: string; detailsPath: string; at: string }[]
  resolved: { ref: string; title: string }[]
  crew: { done: number; open: number }
  estimate: { minutes: number; minutesFormula: string; usd: number; usdFormula: string }
  unfinished: { ref: string; title: string; status: string; why: string }[]
  waiting: { count: number; label: string }[]
}

const STATUS_WORDS: Record<string, string> = { waiting_external: 'waiting on someone else', awaiting_approval: 'waiting for you', blocked: 'blocked', failed: 'failed', escalated: 'handed to a person' }
const statusWords = (s: string) => STATUS_WORDS[s] ?? s.replace(/_/g, ' ')

export function renderMorning(d: MorningData, appUrl: string): Rendered {
  const nothing = !d.did.length && !d.resolved.length && !d.crew.done
  const stat = (n: string, label: string) => `<td width="33%" valign="top" style="padding:12px;border:1px solid ${C.line};border-radius:10px;background:${C.surface}"><div style="font-size:22px;font-weight:700;color:${C.ink}">${escapeHtml(n)}</div><div style="font-size:12px;color:${C.muted};padding-top:2px">${escapeHtml(label)}</div></td>`
  const list = (rows: string[]) => `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table></td></tr>`
  const li = (main: string, sub: string) => `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.line};font-size:14px;line-height:1.45;color:${C.ink}">${main}<div style="font-size:12px;color:${C.muted};padding-top:2px">${sub}</div></td></tr>`
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`
    + `<tr><td style="padding:20px 24px 0">${pill('Morning report', 'info')} <span style="font-size:13px;color:${C.muted};padding-left:6px">${escapeHtml(d.dateLabel)}</span></td></tr>`
    + html`<tr><td style="padding:12px 24px 0;font-size:22px;line-height:1.3;font-weight:700;color:${C.ink}">Good morning. Here is what your team did overnight.</td></tr>`
    + html`<tr><td style="padding:4px 24px 0;font-size:13px;color:${C.muted}">${d.orgName} · since ${d.since}</td></tr>`
    + `<tr><td style="padding:16px 18px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0"><tr>${stat(String(d.did.length + d.resolved.length), 'things handled')}${stat(`${d.estimate.minutes} min`, 'time saved (estimate)')}${stat(`$${d.estimate.usd}`, 'money saved (estimate)')}</tr></table></td></tr>`
    + sectionTitle('What your agents did')
    + (nothing ? para('A quiet night: nothing needed doing.') : list([
      ...d.did.map(u => li(html`<a href="${appLink(appUrl, u.detailsPath)}" style="color:${C.ink};text-decoration:none"><strong>${u.agentName}</strong>: ${u.headline}</a>`, html`${u.severity === 'action' ? 'waiting for your OK' : u.severity === 'warning' ? 'needs a check' : 'done'} · ${u.at}`)),
      ...d.resolved.map(c => li(html`<strong>${c.ref}</strong> ${c.title}`, 'case resolved and verified')),
      ...(d.crew.done ? [li(html`<strong>Crew</strong>: ${d.crew.done} job${d.crew.done === 1 ? '' : 's'} marked done`, `${d.crew.open} still open today`)] : []),
    ]))
    + sectionTitle('Not finished yet, and why')
    + (d.unfinished.length || d.waiting.length ? list([
      ...d.waiting.map(w => li(html`<strong>${String(w.count)}</strong> ${w.label}`, 'waiting for you')),
      ...d.unfinished.map(c => li(html`<strong>${c.ref}</strong> ${c.title}`, html`${statusWords(c.status)}: ${c.why}`)),
    ]) : para('Nothing is stuck and nothing is waiting for you.'))
    + `<tr><td style="padding:18px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.warnSoft};border:1px solid ${C.warnLine};border-radius:10px;border-collapse:separate"><tr><td style="padding:12px 14px;font-size:13px;line-height:1.5;color:${C.body}">`
    + html`<strong style="color:${C.ink}">These savings are estimates, not measurements.</strong><br>Time: ${d.estimate.minutesFormula}.<br>Money: ${d.estimate.usdFormula}.`
    + `</td></tr></table></td></tr>`
    + `<tr><td style="padding:20px 24px 20px">${emailButton(appLink(appUrl, '/store/work'), 'Open Deploi')}</td></tr>`
    + `</table>`
  const footer = html`One report per morning for ${d.orgName}. `
    + html`<a href="${appLink(appUrl, '/store/settings#updates')}" style="color:${C.muted}">Choose how you get updates</a>.`
  const text = [
    `Morning report for ${d.orgName}, ${d.dateLabel} (since ${d.since})`, '',
    'WHAT YOUR AGENTS DID',
    ...(nothing ? ['- A quiet night: nothing needed doing.'] : [
      ...d.did.map(u => `- ${u.agentName}: ${u.headline} (${u.severity === 'action' ? 'waiting for your OK' : u.severity === 'warning' ? 'needs a check' : 'done'})`),
      ...d.resolved.map(c => `- ${c.ref} ${c.title} (resolved and verified)`),
      ...(d.crew.done ? [`- Crew: ${d.crew.done} job(s) marked done, ${d.crew.open} still open today`] : []),
    ]), '',
    'NOT FINISHED YET, AND WHY',
    ...(d.unfinished.length || d.waiting.length ? [...d.waiting.map(w => `- ${w.count} ${w.label}`), ...d.unfinished.map(c => `- ${c.ref} ${c.title}: ${statusWords(c.status)}, ${c.why}`)] : ['- Nothing is stuck and nothing is waiting for you.']), '',
    `Time saved: about ${d.estimate.minutes} minutes (estimate: ${d.estimate.minutesFormula}).`,
    `Money saved: about $${d.estimate.usd} (estimate: ${d.estimate.usdFormula}).`, '',
    `Open Deploi: ${appLink(appUrl, '/store/work')}`,
  ].join('\n')
  const handled = d.did.length + d.resolved.length
  return { subject: `[Deploi] Morning report: ${handled} handled, ${d.unfinished.length + d.waiting.reduce((s, w) => s + w.count, 0)} waiting`, text, html: frame({ preheader: `${handled} handled overnight · about ${d.estimate.minutes} min saved`, body, footer }) }
}

// ------------------------------------------------------------------ registration

const parse = <T>(s: string | undefined): T => JSON.parse(s || '{}') as T

registerSystemTemplate('agent_update', p => renderUpdate(parse<UpdateData>(p.data), p.appUrl, p.undoUrl ?? ''))
registerSystemTemplate('agent_action_needed', p => renderUpdate({ ...parse<UpdateData>(p.data), severity: 'action' }, p.appUrl, ''))
registerSystemTemplate('crew_jobs', p => renderCrew(parse<CrewData>(p.data), p))
registerSystemTemplate('morning_report', p => renderMorning(parse<MorningData>(p.data), p.appUrl))
