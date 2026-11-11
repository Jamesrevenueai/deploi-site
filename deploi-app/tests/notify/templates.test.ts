/**
 * Owner and crew email templates (lib/notify/templates.ts), pure: structure, subjects, plain-text alternative,
 * escaping of everything an agent writes (no HTML injection), links limited to http(s), stored copies without
 * working single-use links, and the small helpers (reply parsing, change detection, voice transcript, estimates).
 */
import { describe, it, expect } from 'vitest'
import { renderSystemEmail } from '../../lib/email/system'
import { renderUpdate, renderCrew, renderMorning, safeUrl, safePath, updateSubject, LINK_REMOVED, type UpdateData, type CrewData, type MorningData } from '../../lib/notify/templates'
import { parseCrewReply, jobChanges, crewToken, verifyCrewToken } from '../../lib/notify/crew'
import { voiceTranscript, normalizePhone, clipText } from '../../lib/notify/channels'
import { estimate } from '../../lib/notify/morning'
import { shortUpdate } from '../../lib/notify/owner'
import '../../lib/notify/impl'

const APP = 'https://app.example.test'
const EVIL = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`
const base: UpdateData = {
  agentName: 'Refund Agent', headline: 'Refunded order #1001', whatHappened: 'The customer was charged twice.', whatIDid: ['Refunded the duplicate charge of $42.00', 'Emailed the customer'],
  proof: [{ label: 'Refund', value: 're_123', url: 'https://admin.shopify.com/store/x/orders/1001' }, { label: 'Amount', value: '$42.00' }],
  caseRef: 'DC-000123', severity: 'info', detailsPath: '/store/work/DC-000123', orgName: 'Northwind Goods',
}

describe('owner update email', () => {
  it('subject "[Deploi] <Agent>: <headline>", sections in order, buttons, plain text', () => {
    const r = renderUpdate(base, APP, 'https://app.example.test/undo/tok123')
    expect(r.subject).toBe('[Deploi] Refund Agent: Refunded order #1001')
    const order = ['What happened', 'What I did', 'Proof', 'See details', 'Undo'].map(s => r.html.indexOf(s))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(r.html).toContain('href="https://app.example.test/store/work/DC-000123"')
    expect(r.html).toContain('href="https://app.example.test/undo/tok123"')
    expect(r.html).toContain('<table role="presentation"')
    expect(r.html).not.toMatch(/var\(--/) // email clients cannot read CSS variables
    expect(r.text).toMatch(/WHAT HAPPENED\nThe customer was charged twice\./)
    expect(r.text).toContain('- Refunded the duplicate charge of $42.00')
    expect(r.text).toContain('- Refund: re_123 (https://admin.shopify.com/store/x/orders/1001)')
    expect(r.text).toContain('See details: https://app.example.test/store/work/DC-000123')
    expect(r.text).toContain('Undo (works once): https://app.example.test/undo/tok123')
  })

  it('no undo button without a token; the stored copy says the link was removed', () => {
    expect(renderUpdate(base, APP, '').html).not.toContain('>Undo<')
    const stored = renderUpdate(base, APP, LINK_REMOVED)
    expect(stored.html).not.toContain('/undo/')
    expect(stored.html).toContain('removed from this stored copy')
    expect(stored.text).toContain('Undo: [link removed from the stored copy]')
  })

  it('escapes everything an agent writes: headline, text, steps, proof labels and values', () => {
    const r = renderUpdate({ ...base, agentName: EVIL, headline: EVIL, whatHappened: EVIL, whatIDid: [EVIL], proof: [{ label: EVIL, value: EVIL }], caseRef: EVIL }, APP, '')
    expect(r.html).not.toContain('<script>')
    expect(r.html).not.toMatch(/<img/i)
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(r.html).toContain('&quot;&#39;&amp;')
  })

  it('links only http(s): javascript:, data: and relative proof links are shown as text; odd details paths fall back', () => {
    const r = renderUpdate({ ...base, proof: [{ label: 'a', value: 'click', url: 'javascript:alert(1)' }, { label: 'b', value: 'img', url: 'data:text/html,<b>x</b>' }], detailsPath: '//evil.example/x' }, APP, 'javascript:alert(3)')
    expect(r.html).not.toMatch(/href="(javascript|data):/)
    expect(r.html).not.toContain('evil.example')
    expect(r.html).toContain('href="https://app.example.test/store/work"')
    expect(r.html).not.toContain('>Undo<')
    expect(safeUrl('https://x.test/a?b=1')).toBe('https://x.test/a?b=1')
    expect(safeUrl('ftp://x.test')).toBeNull()
    expect(safePath('/store/work/DC-1')).toBe('/store/work/DC-1')
    expect(safePath('https://evil.example')).toBe('/store/work')
    expect(safePath('/"><script>')).toBe('/store/work')
  })

  it('severity styling: done (green), check this (amber), your decision needed (blue) with its own subject and wording', () => {
    expect(renderUpdate(base, APP, '').html).toContain('#047857')
    const w = renderUpdate({ ...base, severity: 'warning' }, APP, '')
    expect(w.html).toContain('Check this'); expect(w.html).toContain('#B45309')
    const a = renderUpdate({ ...base, severity: 'action' }, APP, '')
    expect(a.subject).toBe('[Deploi] Refund Agent needs your OK: Refunded order #1001')
    expect(a.html).toContain('Your decision needed'); expect(a.html).toContain('What I will do once you say yes'); expect(a.html).toContain('Review and decide')
    expect(updateSubject({ agentName: 'A', headline: 'B', severity: 'info' })).toBe('[Deploi] A: B')
  })

  it('is registered on the system mailer as agent_update and agent_action_needed; CR/LF never reach the subject', () => {
    const r = renderSystemEmail('agent_update', { data: JSON.stringify({ ...base, headline: 'x\r\nBcc: evil@example.com' }), appUrl: APP, undoUrl: '' })
    expect(r.subject).not.toMatch(/[\r\n]/)
    expect(renderSystemEmail('agent_action_needed', { data: JSON.stringify(base), appUrl: APP }).subject).toMatch(/needs your OK/)
  })

  it('a text message carries the headline and the details link within the length limit', () => {
    const t = shortUpdate({ agentName: 'Refund Agent', headline: 'Refunded order #1001', whatHappened: 'x'.repeat(2000), severity: 'info' }, 'https://app.example.test/store/work/DC-1')
    expect(t.length).toBeLessThanOrEqual(480)
    expect(t).toMatch(/^Deploi - Refund Agent: Refunded order #1001\./)
    expect(t.endsWith('Details: https://app.example.test/store/work/DC-1')).toBe(true)
  })
})

describe('crew job message', () => {
  const d: CrewData = {
    crewName: 'Sam', orgName: 'Northwind Goods', dateLabel: 'Saturday, November 7', intro: 'Two pickups today.',
    jobs: [
      { jobRef: 'J-1', address: '12 Main St, Springfield', details: 'Pack 3 boxes.\nFragile.', photos: ['https://cdn.example.test/p1.jpg', 'javascript:alert(1)'], status: 'sent', doneParam: 'done_0', changes: ['Address changed'] },
      { jobRef: 'J-2', address: null, details: null, photos: [], status: 'done', doneParam: null, changes: [] },
    ],
  }
  it('lists the jobs with address (map link), details, photos, changes and a Mark done link per open job', () => {
    const r = renderCrew(d, { done_0: 'https://app.example.test/crew/done/abc.def' })
    expect(r.subject).toBe('[Deploi] Your jobs for Saturday, November 7: 1 open (changes inside)')
    expect(r.html).toContain('https://www.google.com/maps/search/?api=1&amp;query=12%20Main%20St%2C%20Springfield')
    expect(r.html).toContain('href="https://cdn.example.test/p1.jpg"')
    expect(r.html).not.toContain('javascript:')
    expect(r.html).toContain('Address changed')
    expect(r.html).toContain('href="https://app.example.test/crew/done/abc.def"')
    expect((r.html.match(/>Mark done<\/a>/g) ?? []).length).toBe(1)
    expect(r.text).toContain('   CHANGED: Address changed')
    expect(r.text).toContain('   Mark done (works once): https://app.example.test/crew/done/abc.def')
    expect(r.text).toContain('2. J-2 (done)')
  })
  it('escapes crew and job text; the stored copy has no working link', () => {
    const r = renderCrew({ ...d, crewName: EVIL, intro: EVIL, jobs: [{ ...d.jobs[0], jobRef: EVIL, details: EVIL, address: EVIL }] }, { done_0: LINK_REMOVED })
    expect(r.html).not.toContain('<script>')
    expect(r.html).not.toContain('/crew/done/')
    expect(r.text).toContain('Mark done: [link removed from the stored copy]')
  })
})

describe('morning report', () => {
  const m: MorningData = {
    orgName: 'Northwind Goods', dateLabel: 'Saturday, November 7', since: 'Nov 6, 12:11 PM UTC',
    did: [{ agentName: 'Refund Agent', headline: 'Refunded order #1001', severity: 'info', detailsPath: '/store/work/DC-1', at: 'Nov 6, 9:00 PM UTC' }],
    resolved: [{ ref: 'DC-000001', title: 'Stuck order' }], crew: { done: 2, open: 1 },
    estimate: estimate({ updates: 1, resolved: 1, crewDone: 2 }, 30),
    unfinished: [{ ref: 'DC-000002', title: 'Supplier late', status: 'waiting_external', why: 'waiting for the supplier' }], waiting: [{ count: 2, label: 'change(s) waiting for your approval' }],
  }
  it('what happened, estimates labelled with the formula, unfinished with why; HTML and text', () => {
    const r = renderMorning(m, APP)
    expect(r.subject).toBe('[Deploi] Morning report: 2 handled, 3 waiting')
    expect(r.html).toContain('These savings are estimates, not measurements.')
    expect(r.html).toContain('1 finished update(s) × 6 min + 1 verified case resolution(s) × 10 min + 2 crew job(s) closed × 3 min = 22 min')
    expect(r.html).toContain('$11')
    expect(r.html).toContain('waiting for the supplier')
    expect(r.text).toContain('NOT FINISHED YET, AND WHY')
    expect(r.text).toContain('- DC-000002 Supplier late: waiting on someone else, waiting for the supplier')
    expect(r.text).toContain('Money saved: about $11 (estimate: 22 min ÷ 60 × $30/hour')
  })
  it('a quiet night says so; agent text is escaped', () => {
    const r = renderMorning({ ...m, did: [], resolved: [], crew: { done: 0, open: 0 }, unfinished: [], waiting: [], orgName: EVIL }, APP)
    expect(r.html).toContain('A quiet night')
    expect(r.html).toContain('Nothing is stuck')
    expect(r.html).not.toContain('<script>')
  })
  it('estimate formula is exact', () => {
    expect(estimate({ updates: 0, resolved: 0, crewDone: 0 }, 30)).toMatchObject({ minutes: 0, usd: 0 })
    expect(estimate({ updates: 10, resolved: 0, crewDone: 0 }, 45)).toMatchObject({ minutes: 60, usd: 45 })
  })
})

describe('helpers', () => {
  it('parses crew replies', () => {
    expect(parseCrewReply('done')).toEqual({ done: true, jobRef: null })
    expect(parseCrewReply('DONE J-1001')).toEqual({ done: true, jobRef: 'J-1001' })
    expect(parseCrewReply('Done #J-1001 thanks')).toEqual({ done: true, jobRef: 'J-1001' })
    expect(parseCrewReply('done thanks')).toEqual({ done: true, jobRef: null })
    expect(parseCrewReply('\n\nFinished: A7\n> quoted')).toEqual({ done: true, jobRef: 'A7' })
    expect(parseCrewReply('not done yet')).toEqual({ done: false, jobRef: null })
    expect(parseCrewReply('Running late')).toEqual({ done: false, jobRef: null })
  })
  it('detects what changed since the last message', () => {
    const s = { address: 'A', details: 'D', photos: ['p1'], status: 'sent' }
    expect(jobChanges(null, s, false)).toEqual([])
    expect(jobChanges(null, s, true)).toEqual(['New job since my last message'])
    expect(jobChanges(s, s, true)).toEqual([])
    expect(jobChanges(s, { address: 'B', details: 'E', photos: ['p1', 'p2'], status: 'cancelled' }, true)).toEqual(['Cancelled: do not do this job', 'Address changed', 'Details changed', '1 new photo'])
  })
  it('voice transcript speaks links as words; phone numbers normalize to E.164', () => {
    expect(voiceTranscript('Refunded order. Details: https://x.test/a')).toBe("Hi, this is Deploi. Refunded order. Details: the link in your messages That's all for now. Goodbye.")
    expect(normalizePhone('+1 (555) 010-0100')).toBe('+15550100100')
    expect(normalizePhone('555-0100')).toBeNull()
    expect(clipText('abcdef', 4)).toBe('abc…')
  })
  it('crew tokens: valid, tampered and malformed', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const t = crewToken(id, new Date(Date.now() + 3600e3))!
    expect(verifyCrewToken(t)?.linkId).toBe(id)
    const [body, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ l: '00000000-0000-4000-8000-000000000002', x: 9999999999 })).toString('base64url')
    expect(verifyCrewToken(`${forged}.${sig}`)).toBeNull()
    expect(verifyCrewToken(`${body}.${sig.slice(0, -2)}xx`)).toBeNull()
    expect(verifyCrewToken(`${t}.extra`)).toBeNull()
    expect(verifyCrewToken('nonsense')).toBeNull()
  })
})
