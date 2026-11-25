/**
 * Fair housing: many synthetic renters with different names, backgrounds and languages, who state the same
 * criteria, get the same reply (apart from the greeting), are asked the same questions, are shown the same
 * listings and are held to the same criteria. And the content check refuses protected characteristics and
 * steering language without ever refusing a person because of their name.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { checkMessage, maskRecipient } from '../../lib/packs/content-policy'
import { greetName, leasingReply, tourReminder, leadFollowUp, buyerReply, maintenanceAck, rentReminder } from '../../lib/packs/templates'
import { NW, resetPacks, fire, monday, sentMail, rows, leadEmail } from './helpers'

const ready = await prepareDb()
const T = monday(3)
const day = (n: number) => new Date(T.getTime() + n * 864e5).toISOString().slice(0, 10)

const PEOPLE: { name: string; text: string }[] = [
  { name: 'Christian Black', text: 'Hello, I am looking for a place near my church.' },
  { name: 'Mohammed Al-Sayed', text: 'We are a Muslim family of five with three kids.' },
  { name: 'Nguyen Thi Lan', text: 'Xin chào, tôi muốn thuê căn hộ.' },
  { name: 'José García', text: 'Hola, busco un apartamento para mi familia. Soy de México.' },
  { name: 'Aisha Okafor', text: 'I recently immigrated from Nigeria and have a Section 8 voucher.' },
  { name: 'Wei Chen', text: '你好，我想租一套两居室的公寓。' },
  { name: 'Priya Patel', text: 'I am pregnant with our first child.' },
  { name: 'Olga Ivanova', text: 'Здравствуйте! Ищу квартиру.' },
  { name: 'Robert White', text: 'I use a wheelchair and need an accessible unit.' },
  { name: 'Mary-Kate O\'Brien', text: 'I am 72 and retired.' },
  { name: 'Jamal Washington', text: 'Is the neighborhood safe? Are the schools good?' },
  { name: 'Avi Goldstein', text: 'I keep kosher and observe the Sabbath.' },
  { name: 'Fatima Zahra', text: 'Je cherche un appartement pour moi et mon mari.' },
  { name: 'Kenji Watanabe', text: 'こんにちは、アパートを探しています。' },
  { name: 'Alex Rivera', text: 'My partner and I are a same-sex couple.' },
  { name: 'Grace Kim', text: 'I am a single mom with two children.' },
  { name: 'Hans Müller', text: 'Ich suche eine Wohnung.' },
  { name: 'Lakshmi Iyer', text: 'I am deaf; please email rather than call.' },
  { name: 'Diego Hernández', text: 'I receive disability benefits.' },
  { name: 'Sarah Johnson', text: '' },
  { name: 'Ahmed Hassan', text: 'Is there a mosque nearby?' },
  { name: 'Tyrone Brown', text: 'Looking ASAP.' },
  { name: 'Elena Popescu', text: 'Caut un apartament.' },
  { name: 'Kwame Mensah', text: 'I am a student at the university.' },
  { name: 'Lucía Fernández', text: 'Tengo un perro de asistencia.' },
  { name: 'Ivan Petrov', text: 'Can my elderly mother live with me?' },
  { name: 'Mei Ling', text: 'I am Buddhist and vegetarian.' },
  { name: 'John Smith', text: 'Please send listings.' },
  { name: 'Ngozi Adeyemi', text: 'I just finished my PhD.' },
  { name: 'Sven Larsson', text: 'Hej!' },
]
const FIELDS = { Budget: '$2,000', 'Move-in': day(20), Bedrooms: '2', Pets: 'No' }
const normalize = (body: string, name: string) => body.replace(`Hi ${greetName(name)},`, 'Hi {name},')

describe.skipIf(!ready)('fair housing: identical treatment for the same stated criteria', () => {
  beforeAll(async () => {
    await resetPacks(NW, 'leasing_agent', { settings: { applicationUrl: 'https://apply.example/general' } })
    await admin(async db => {
      const p = (await db.one<{ id: string }>(`insert into leasing_properties (org_id, name, billing_email, commission_type, commission_value) values ($1,'Maple Court','ap@maple.example','percent',50) returning id`, [NW.org]))!
      for (const [unit, beds, rent, pets] of [['4B', 2, 1950, false], ['2A', 2, 1800, true], ['7D', 2, 1999, false], ['9F', 3, 1900, true], ['1C', 2, 2200, true]] as const)
        await db.query(`insert into leasing_listings (org_id, property_id, unit, bedrooms, monthly_rent, pets_allowed) values ($1,$2,$3,$4,$5,$6)`, [NW.org, p.id, unit, beds, rent, pets])
    })
    let i = 0
    for (const p of PEOPLE) {
      const email = `renter${++i}@renters.example`
      const from = ['leads@zillow.com', 'leads@apartments.com', 'leads@zumper.com'][i % 3]
      await fire(NW, 'lead.email', leadEmail({ id: `fh-${i}`, from, name: p.name, email, fields: FIELDS, text: p.text }), T)
      // the same people, without some answers: asked the same questions
      await fire(NW, 'lead.email', leadEmail({ id: `fh-q-${i}`, from, name: p.name, email: `q-${email}`, fields: { Bedrooms: '2' }, text: p.text }), T)
    }
  })

  it(`${PEOPLE.length} renters who state the same criteria get the same reply, word for word, apart from their name`, async () => {
    const mail = (await sentMail(NW)).filter(m => !m.to.startsWith('q-'))
    expect(mail).toHaveLength(PEOPLE.length)
    const leads = await rows<{ email: string; name: string }>(`select email, name from pack_leads where org_id = $1`, [NW.org])
    const nameOf = new Map(leads.map(l => [l.email, l.name]))
    const bodies = new Set(mail.map(m => normalize(m.body, nameOf.get(m.to)!)))
    const subjects = new Set(mail.map(m => m.subject))
    expect(subjects.size).toBe(1)
    expect(bodies.size).toBe(1)
    const [body] = [...bodies]
    expect(body).toMatch(/unit 2A[\s\S]*unit 4B[\s\S]*unit 7D/) // the same listings, in the same order
    expect(body).not.toMatch(/9F|1C/)
    // nothing anyone wrote about themselves is echoed back
    for (const p of PEOPLE) if (p.text) expect(body).not.toContain(p.text)
  })

  it('renters missing the same answers are asked the same questions, word for word', async () => {
    const mail = (await sentMail(NW)).filter(m => m.to.startsWith('q-'))
    expect(mail).toHaveLength(PEOPLE.length)
    const leads = await rows<{ email: string; name: string }>(`select email, name from pack_leads where org_id = $1`, [NW.org])
    const nameOf = new Map(leads.map(l => [l.email, l.name]))
    expect(new Set(mail.map(m => normalize(m.body, nameOf.get(m.to)!))).size).toBe(1)
    expect(mail[0].body).toMatch(/budget[\s\S]*move in[\s\S]*pets/)
  })

  it('the criteria recorded are the stated answers only, identical for everyone; status and listings are identical too', async () => {
    const leads = await rows<{ criteria: unknown; status: string; email: string }>(`select criteria, status, email from pack_leads where org_id = $1`, [NW.org])
    const full = leads.filter(l => !l.email.startsWith('q-'))
    expect(new Set(full.map(l => JSON.stringify(l.criteria))).size).toBe(1)
    expect(full[0].criteria).toEqual({ budget: 2000, moveIn: day(20), bedrooms: 2, pets: false })
    expect(new Set(full.map(l => l.status))).toEqual(new Set(['slots_offered']))
    const partial = leads.filter(l => l.email.startsWith('q-'))
    expect(new Set(partial.map(l => JSON.stringify(l.criteria))).size).toBe(1)
    expect(new Set(partial.map(l => l.status))).toEqual(new Set(['qualifying']))
  })

  it('every one of those messages passed the fair-housing content check', async () => {
    const msgs = await rows<{ status: string; policy: { ok: boolean; fairHousing: boolean } }>(`select status, policy from pack_messages where org_id = $1`, [NW.org])
    expect(msgs).toHaveLength(PEOPLE.length * 2)
    expect(msgs.every(m => m.status === 'sent' && m.policy.ok && m.policy.fairHousing)).toBe(true)
  })
})

describe('fair housing content check', () => {
  const to = 'renter@renters.example'
  const check = (body: string, names: string[] = []) => checkMessage({ to, subject: 'Your rental inquiry', body }, { kind: 'fair_housing', recipientNames: names })

  it('refuses protected characteristics and steering language', () => {
    for (const bad of ['This is a great area for families with children.', 'It is in a safe neighborhood.', 'The school district is excellent, good schools nearby.', 'Perfect for young professionals.',
      'There is a church on the corner.', 'Adults only building.', 'We do not take Section 8.', 'The unit is not suitable for a wheelchair.', 'Mostly Hispanic neighbors.', 'You would fit in here.',
      'English-speaking tenants preferred.', 'Ideal for you and your husband: a married couple building.', 'Low crime and exclusive.'])
      expect(check(`Hi Sam,\n\n${bad}`).ok, bad).toBe(false)
  })

  it('never refuses a person because of their own name or address', () => {
    for (const name of ['Christian Black', 'Faith White', 'Hope Church', 'Asia Brown', 'Temple Grandin', 'Major Gay', 'Child Jones', 'Deaf Leppard'])
      expect(check(`Hi ${greetName(name)},\n\nThanks for your interest.`, [name]).ok, name).toBe(true)
    expect(maskRecipient('Hi Christian, black@x.example', ['Christian Black'], 'black@x.example')).toBe('Hi [name], [address]')
    // a protected word that is not the recipient's name is still refused
    expect(check('Hi Christian,\n\nA Christian building.', ['Christian Black']).ok).toBe(true) // the whole word is the name
    expect(check('Hi Sam,\n\nA Christian building.', ['Sam Park']).ok).toBe(false)
  })

  it('every template the leasing, real estate and property packs write passes the check', () => {
    const slots = [{ start: '2026-11-24T10:00:00.000Z', end: '2026-11-24T10:30:00.000Z', label: 'Tuesday 24 November, 10:00 (UTC)' }]
    const drafts = [
      leasingReply({ name: 'Sam', business: 'Locator Co', criteria: {}, listings: [], slots: [], currency: 'USD', applicationUrl: null }),
      leasingReply({ name: 'Sam', business: 'Locator Co', criteria: { budget: 2000, moveIn: '2026-12-01', bedrooms: 2, pets: true }, listings: [{ unit: '2A', property: 'Maple Court', bedrooms: 2, rent: 1800, availableFrom: null, petsAllowed: true, applicationUrl: 'https://apply.example/a' }], slots, currency: 'USD', applicationUrl: 'https://apply.example/a' }),
      leasingReply({ name: 'Sam', business: 'Locator Co', criteria: { budget: 900, moveIn: '2026-12-01', bedrooms: 0, pets: false }, listings: [], slots: [], currency: 'USD', applicationUrl: null }),
      tourReminder({ name: 'Sam', business: 'Locator Co', when: slots[0].label, applicationUrl: 'https://apply.example/a' }),
      leadFollowUp({ name: 'Sam', business: 'Locator Co', n: 3, max: 3, fair: true }),
      buyerReply({ name: 'Sam', business: 'Realty Co', slots }),
      maintenanceAck({ name: 'Sam', business: 'PM Co', category: 'plumbing', emergency: true }),
      rentReminder({ name: 'Sam', business: 'PM Co', amount: 'USD 1,200.00', due: '1 December 2026', unit: '4B' }),
    ]
    for (const d of drafts) expect(checkMessage({ to, ...d }, { kind: 'fair_housing', recipientNames: ['Sam'] }), d.subject).toMatchObject({ ok: true })
  })

  it('general checks: one valid recipient, no unfilled fields, no HTML', () => {
    expect(checkMessage({ to: 'a@x.example, b@x.example', subject: 's', body: 'b' }, { kind: 'general' }).ok).toBe(false)
    expect(checkMessage({ to, subject: 's', body: 'Hi {{name}}' }, { kind: 'general' }).ok).toBe(false)
    expect(checkMessage({ to, subject: 's', body: 'Amount: undefined' }, { kind: 'general' }).ok).toBe(false)
    expect(checkMessage({ to, subject: 's', body: '<script>x</script>' }, { kind: 'general' }).ok).toBe(false)
    expect(checkMessage({ to, subject: '', body: 'b' }, { kind: 'general' }).ok).toBe(false)
    expect(checkMessage({ to, subject: 'Hello', body: 'A safe area' }, { kind: 'general' }).ok).toBe(true) // fair housing only where it applies
  })
})
