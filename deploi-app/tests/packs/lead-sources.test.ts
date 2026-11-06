/**
 * The pack lead sources read the payloads the real connections emit, not only the pack's own contract shape:
 *  - lead.email from the Outlook inbox sync (lib/outlook/mail-events.ts): { providerMessageId, lead: <parsed lead> }
 *  - crm.lead.created from the CRM poll (lib/connections/events.ts packEvents): { provider, contact }
 * Found by scripts/scenario-harness.ts (B02, C02, D03): before this, both parsed to null and the lead was dropped silently.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { emailLeadSource, crmLeadSource } from '../../lib/packs/leads'
import { parseLeadEmail } from '../../lib/leads/email-parsers'
import { packEvents } from '../../lib/connections/events'

const fixture = (n: string) => JSON.parse(readFileSync(join(__dirname, '../fixtures/lead-emails', n), 'utf8')) as { from: string; subject: string; text: string }

describe('pack lead sources: payloads of the real connections', () => {
  it('reads the Outlook inbox sync lead.email payload (a Zillow lead), keyed by the provider message id', () => {
    const f = fixture('zillow-inquiry.json')
    // the payload exactly as emitMailEvents builds it
    const payload = { accountId: 'acc-1', inboundId: 'in-1', providerMessageId: 'AAMk-1', receivedAt: '2026-11-07T09:00:00.000Z', lead: parseLeadEmail({ from: f.from, subject: f.subject, text: f.text }), senderVerified: true }
    expect(emailLeadSource.parse(payload)).toEqual({
      source: 'zillow', externalId: 'AAMk-1', name: 'Maya Thompson', email: 'maya.thompson@gmail.com', phone: '+15035550147', subject: null,
      criteria: { budget: null, moveIn: '2026-12-01', bedrooms: null, pets: null }, intent: 'inquiry',
    })
  })

  it('never mines the free-text message, keeps a worded move-in out of the criteria, and needs the provider id', () => {
    const lead = { source: 'generic', name: 'A B', email: 'a@b.example', phone: null, property: null, moveIn: 'ASAP', message: 'Budget: $9,000. I have 3 dogs.', replyVia: null, confidence: 'low' }
    expect(emailLeadSource.parse({ providerMessageId: 'm-2', lead })).toMatchObject({ source: 'email', criteria: { budget: null, moveIn: null, bedrooms: null, pets: null } })
    expect(emailLeadSource.parse({ lead })).toBeNull()
  })

  it('still reads the pack contract shape', () => {
    expect(emailLeadSource.parse({ from: 'leads@zillow.com', subject: 'New rental lead', text: 'Name: Jo\nEmail: jo@renter.example\nBudget: $2,000', messageId: 'z-1' })).toMatchObject({ source: 'zillow', externalId: 'z-1', email: 'jo@renter.example', criteria: { budget: 2000 } })
    expect(crmLeadSource.parse({ externalId: 'crm-77', email: 'casey@buyer.example', name: 'Casey Fox', intent: 'buyer' })).toMatchObject({ externalId: 'crm-77', intent: 'buyer' })
  })

  it('reads the CRM poll crm.lead.created payload (packEvents), one external id per person', () => {
    const [alias] = packEvents({ source: 'crm', type: 'crm.contact.changed', orgId: '00000000-0000-4000-8000-000000000001', externalId: 'hubspot:contact:77:v1', occurredAt: '2026-11-07T09:00:00Z', connectionId: 'c-1',
      payload: { provider: 'hubspot', connectionId: 'c-1', contact: { id: '77', kind: 'contact', email: 'Casey@Buyer.example', firstName: 'Casey', lastName: 'Fox', phone: '+15550100', company: null, updatedAt: '2026-11-07T09:00:00Z' } } })
    expect(alias.type).toBe('crm.lead.created')
    expect(crmLeadSource.parse(alias.payload)).toEqual({ source: 'crm', externalId: 'hubspot:contact:77', name: 'Casey Fox', email: 'casey@buyer.example', phone: '+15550100', subject: null, criteria: {}, intent: 'inquiry' })
    expect(crmLeadSource.parse({ provider: 'hubspot', contact: { kind: 'contact' } })).toBeNull()
  })
})
