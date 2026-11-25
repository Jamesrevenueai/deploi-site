import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePhone, parseLeadEmail, parseMoveIn, type LeadEmail, type ParsedLead } from '../../lib/leads/email-parsers'

const DIR = join(__dirname, '..', 'fixtures', 'lead-emails')
const fixtures = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => ({ file: f, ...(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as LeadEmail & { expect: Partial<ParsedLead> | null }) }))

describe('lead notification emails (rules only)', () => {
  it('has fixtures for every portal, the generic parser, edge cases and malformed mail', () => {
    const names = fixtures.map(f => f.file).join(' ')
    for (const k of ['zillow', 'apartments-com', 'zumper', 'generic', 'edge', 'malformed']) expect(names).toContain(k)
  })

  for (const f of fixtures) {
    it(`${f.file}`, () => {
      const r = parseLeadEmail(f)
      if (f.expect === null) { expect(r).toBeNull(); return }
      expect(r).not.toBeNull()
      expect(r).toMatchObject(f.expect)
    })
  }

  it('a portal sender alone is not enough: account mail from the same domain is not a lead', () => {
    expect(parseLeadEmail({ from: 'receipts@zillow.com', subject: 'Your payment receipt', text: 'Thanks for your payment of $29.99.' })).toBeNull()
  })

  it('the sender domain must really be the portal (look-alike domains get the generic parser at most)', () => {
    const r = parseLeadEmail({ from: 'leads@zillow.com.evil.example', subject: 'New Zillow Rentals lead for 1 Main St', text: 'Name: X Y\nEmail: x@y.example' })
    expect(r?.source).toBe('generic')
  })

  it('input is bounded and never throws on odd text', () => {
    const huge = `Email: a@b.example\nName: ${"A".repeat(200_000)}\nlead`
    const r = parseLeadEmail({ from: 'x@y.example', subject: 'new lead', text: huge })
    expect(r!.name!.length).toBeLessThanOrEqual(120)
    expect(() => parseLeadEmail({ from: '\u0000', subject: '￿'.repeat(1000), text: '::::\n'.repeat(5000) })).not.toThrow()
  })

  it('dates and phones', () => {
    expect(parseMoveIn('12/01/2026')).toBe('2026-12-01')
    expect(parseMoveIn('2026-02-30')).toBe('2026-02-30') // not a real date: kept as words, never guessed
    expect(parseMoveIn('Dec 1st, 2026')).toBe('2026-12-01')
    expect(parseMoveIn('1 March 2027')).toBe('2027-03-01')
    expect(parseMoveIn('Flexible')).toBe('Flexible')
    expect(normalizePhone('(503) 555-0147')).toBe('+15035550147')
    expect(normalizePhone('1-503-555-0147')).toBe('+15035550147')
    expect(normalizePhone('12345')).toBeNull()
  })
})
