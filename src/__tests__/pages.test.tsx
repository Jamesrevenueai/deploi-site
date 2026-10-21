import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Nav, NAV_LINKS } from '../components/Nav'
import { Footer } from '../components/Footer'
import Legal, { termsSections } from '../pages/Legal'
import Home, { FAQ, FAQS, HowWeWork, Pricing, Services, JOURNEY } from '../pages/Home'
import Website from '../pages/Website'
import { CONTACT_EMAIL } from '../lib/brand'
import { catalog, sellableServices } from '../lib/catalog'
import raw from '../data/catalog.json'

const REMOVED_SERVICES = ['New-patient leads + reviews', 'Referral-source nurturing', 'Instant hiring', 'After-hours line', 'Denial cleanup + managed billing']
const OTHER_PRACTICE_CLAIMS = /dental|therapy|primary care|specialty clinic/i

describe('Nav', () => {
  it('renders the wordmark, every link and the website page', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>)
    expect(screen.getByLabelText('Deploi AI home')).toHaveTextContent('deploi ai')
    for (const l of NAV_LINKS) expect(screen.getAllByText(l.label).length).toBeGreaterThan(0)
    expect(NAV_LINKS.find(l => l.to === '/website')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument()
  })
})

describe('Footer', () => {
  it('links BAA, Website Improvement and the company email', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByText('Business Associate Agreement')).toHaveAttribute('href', '/baa')
    expect(screen.getByText('Website Improvement')).toHaveAttribute('href', '/website')
    expect(screen.getByText(CONTACT_EMAIL)).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`)
    expect(screen.getByText(/All rights reserved/)).toBeInTheDocument()
    expect(screen.getByText(/home care agencies first/)).toBeInTheDocument()
  })
})

describe('Legal', () => {
  it('replaces the entity and contact placeholders', () => {
    const sections = termsSections('Example Holdings LLC')
    render(<MemoryRouter><ol>{sections.map(s => <li key={s.title}>{s.body}</li>)}</ol></MemoryRouter>)
    expect(screen.getByText('Example Holdings LLC')).toBeInTheDocument()
    expect(screen.queryByText(/\[LEGAL ENTITY NAME\]/)).toBeNull()
    expect(screen.queryByText(/\[CONTACT EMAIL\]/)).toBeNull()
    expect(screen.getAllByText(CONTACT_EMAIL).length).toBeGreaterThan(0)
  })
  it('defaults the entity to Deploi and shows the draft badge when unreviewed', () => {
    render(<MemoryRouter><Legal kind="terms" /></MemoryRouter>)
    expect(screen.getByText('Deploi AI', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/pending legal review/)).toBeInTheDocument()
  })
})

describe('Home content', () => {
  it('renders every FAQ question', () => {
    render(<MemoryRouter><FAQ /></MemoryRouter>)
    for (const f of FAQS) expect(screen.getByText(f.q)).toBeInTheDocument()
  })
  it('renders exactly the catalog services, grouped by door, with availability badges', () => {
    const { container } = render(<MemoryRouter><Services /></MemoryRouter>)
    const cards = container.querySelectorAll('.svc-card')
    expect(cards).toHaveLength(sellableServices.length)
    expect(cards).toHaveLength((raw.services as { availability: string }[]).filter(s => s.availability !== 'planned').length)
    expect(sellableServices).toHaveLength(8)
    for (const s of sellableServices) expect(screen.getByText(s.name)).toBeInTheDocument()
    for (const door of Object.values(catalog.doors)) expect(screen.getByRole('heading', { level: 3, name: door })).toBeInTheDocument()
    // every card carries the catalog's availability label and help text
    expect(container.querySelectorAll('.svc-card .avail-badge')).toHaveLength(sellableServices.length)
    expect(screen.getAllByText(catalog.availabilityHelp.demonstration).length).toBeGreaterThan(0)
  })
  it('does not render removed services or "Eleven services"', () => {
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    const text = container.textContent ?? ''
    for (const name of REMOVED_SERVICES) expect(text).not.toContain(name)
    expect(text).not.toMatch(/Eleven services/i)
    expect(text).not.toMatch(/Money · later/)
  })
  it('positions home care first and no longer claims other practice types', () => {
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    const text = container.textContent ?? ''
    expect(text).toMatch(/home care agencies first/)
    expect(text).not.toMatch(OTHER_PRACTICE_CLAIMS)
    expect(text).not.toMatch(/HIPAA compliant|HIPAA certified/i)
    expect(text).toContain('A BAA is signed before any patient data moves')
    expect(text).toContain('Illustration with synthetic data')
    expect(text).toContain('Illustrative situations, not customer quotes.')
  })
  it('lists the Website Improvement card with its price and a link to /website', () => {
    render(<MemoryRouter><Services /></MemoryRouter>)
    expect(screen.getByText(/\$500 one-time/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See Website Improvement' })).toHaveAttribute('href', '/website')
  })
  it('lists integrations with their level label and the no-partnership sentence', () => {
    render(<MemoryRouter><Services /></MemoryRouter>)
    expect(screen.getByText('Sandata EVV')).toBeInTheDocument()
    expect(screen.getAllByText(catalog.integrationLevelLabel.csv_compatible).length).toBeGreaterThan(0)
    expect(screen.getByText(/not a partnership/)).toBeInTheDocument()
  })
  it('renders the six-stage journey and the responsibilities', () => {
    render(<MemoryRouter><HowWeWork /></MemoryRouter>)
    expect(JOURNEY.map(j => j.title)).toEqual(['Discovery', 'Paid assessment', 'Scoped proposal', 'Build', 'Supervised pilot', 'Monthly management'])
    for (const j of JOURNEY) expect(screen.getByRole('heading', { level: 3, name: j.title })).toBeInTheDocument()
    expect(screen.getByText(/Collecting SMS consent/)).toBeInTheDocument()
    expect(screen.getByText(/Corrections inside your own scheduler/)).toBeInTheDocument()
  })
  it('renders pricing from the catalog, never hard-coded', () => {
    const { container } = render(<MemoryRouter><Pricing /></MemoryRouter>)
    const text = container.textContent ?? ''
    const p = catalog.pricing
    expect(text).toContain(`$${p.assessment.min.toLocaleString('en-US')}–${p.assessment.max.toLocaleString('en-US')}`)
    expect(text).toContain(`$${p.build.min.toLocaleString('en-US')}–${p.build.max.toLocaleString('en-US')}`)
    expect(text).toContain(`$${p.management.min.toLocaleString('en-US')}–${p.management.max.toLocaleString('en-US')} /mo`)
    expect(text).toContain(`$${p.website.price} one-time`)
    expect(text).toContain(`${p.assessment.creditTermDays} days`)
    expect(text).toContain(`${p.build.fixPeriodDays} days`)
    expect(text).toContain(`${p.management.initialTermMonths} months`)
    expect(text).toContain('The exact scope determines the final quote.')
    for (const n of catalog.notIncludedInLowestPrice) expect(text).toContain(n)
    for (const c of catalog.scopeConsiderations) expect(text).toContain(c.label)
  })
})

describe('Website page', () => {
  it('renders the catalog description, $500 one-time, scope, exclusions and the ten-step process', () => {
    const { container } = render(<MemoryRouter><Website /></MemoryRouter>)
    const text = container.textContent ?? ''
    const svc = catalog.services.find(s => s.key === 'website_improvement')!
    expect(text).toContain(svc.description)
    expect(text).toContain('$500 one-time')
    for (const d of svc.setupDeliverables) expect(text).toContain(d)
    for (const x of svc.exclusions) expect(text).toContain(x)
    for (const step of ['Inquiry', 'Scope confirmed', 'Accepted', 'Payment confirmed', 'Access received', 'Improving', 'Preview ready', 'Customer approved', 'Published', 'Completed']) {
      expect(screen.getByRole('heading', { level: 3, name: step })).toBeInTheDocument()
    }
    expect(text).toMatch(/5 business days/)
    expect(text).toMatch(/a target, not a guarantee/)
    expect(text).toContain('Please do not submit medical information through this form.')
    expect(text).toContain('Never send passwords through this form; we will arrange access securely.')
  })
  it('has the request form with the required fields and no password field', () => {
    const { container } = render(<MemoryRouter><Website /></MemoryRouter>)
    expect(screen.getByRole('form', { name: 'Request website improvements' })).toBeInTheDocument()
    expect(screen.getByLabelText('Website URL')).toHaveAttribute('type', 'url')
    expect(screen.getByLabelText('Website platform')).toBeInTheDocument()
    expect(screen.getByLabelText('Access status')).toBeInTheDocument()
    expect(screen.getByLabelText('Page 3 to improve')).toBeInTheDocument()
    expect(screen.queryByLabelText('Page 4 to improve')).toBeNull()
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Request website improvements' })).toBeInTheDocument()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/guarantee(d)? (leads|ranking|revenue)/i)
  })
})
