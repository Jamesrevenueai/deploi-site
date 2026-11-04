import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// legalReviewed is flipped per test through this mutable mock
const envMock = vi.hoisted(() => ({ env: { appApiUrl: '', formspreeEndpoint: '', legalEntity: 'Deploi AI', legalReviewed: false } }))
vi.mock('../lib/env', () => envMock)

import Home, { PRODUCTS, OWNER_CONTROL, HOME_TITLE, HOME_DESCRIPTION } from '../pages/Home'
import Pricing from '../pages/Pricing'
import Legal from '../pages/Legal'
import { Footer } from '../components/Footer'
import { CTA_HREF, CTA_LABEL } from '../components/Button'

beforeEach(() => { envMock.env.legalReviewed = false })

describe('positioning: the full product', () => {
  it('presents Deploi Commerce for Shopify and WooCommerce and Deploi Office for HubSpot and Google Calendar, with honest statuses', () => {
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    expect(PRODUCTS.map(p => p.name)).toEqual(['Deploi Commerce', 'Deploi Office'])
    const commerce = container.querySelector<HTMLElement>('[data-product="commerce"]')!
    const office = container.querySelector<HTMLElement>('[data-product="office"]')!
    expect(commerce.textContent).toMatch(/Shopify in early access; WooCommerce in paid pilots/)
    expect(within(commerce).getByText('Early access')).toBeInTheDocument()
    expect(within(office).getByText('Paid pilot')).toBeInTheDocument()
    expect(office.textContent).toMatch(/HubSpot/)
    expect(office.textContent).toMatch(/Google Calendar/)
    expect(office.textContent).toMatch(/not generally available/)
    expect(HOME_DESCRIPTION).toMatch(/Shopify and WooCommerce/)
    expect(HOME_TITLE).toMatch(/store and your office/)
    // no "live" or "available now" claims for the pilot products
    expect(container.textContent).not.toMatch(/live now|generally available now|available today for everyone/i)
  })

  it('explains permissions, approvals and audit', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    expect(OWNER_CONTROL.map(c => c.title)).toEqual(['Permissions', 'Approvals', 'Audit'])
    for (const c of OWNER_CONTROL) expect(screen.getByRole('heading', { level: 3, name: c.title })).toBeInTheDocument()
    expect(screen.getAllByText(/starts at drafts only/).length).toBeGreaterThan(0)
    expect(screen.getByText(/One switch stops every agent at once/)).toBeInTheDocument()
  })

  it('the call to action is the paid pilot application, which is the existing early access form', () => {
    expect(CTA_LABEL).toBe('Apply for a paid pilot')
    expect(CTA_HREF).toBe('/#early-access')
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    expect(container.querySelector('#early-access form')).toHaveAccessibleName('Apply for a paid pilot')
    expect(container.textContent).toMatch(/you approve every charge/)
    expect(container.textContent).not.toMatch(/\$\d/)
  })

  it('pricing leads with the pilot and invents no price', () => {
    const { container } = render(<MemoryRouter><Pricing /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Start with a paid pilot' })).toBeInTheDocument()
    expect(within(container.querySelector<HTMLElement>('#pilot')!).getByRole('link', { name: 'Apply for a paid pilot' })).toHaveAttribute('href', '/#early-access')
    expect(container.querySelector('#pilot')!.textContent).not.toMatch(/\$\d/)
  })
})

describe('legal links carry a DRAFT label until review', () => {
  it('shows Draft next to Terms and Privacy in the footer and DRAFT on the pages while unreviewed', () => {
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(container.querySelectorAll('.legal-draft-tag')).toHaveLength(2)
    expect(screen.getByText('Terms of Service')).toHaveAttribute('href', '/terms')
    render(<MemoryRouter><Legal kind="terms" /></MemoryRouter>)
    expect(screen.getByRole('status')).toHaveTextContent('DRAFT — pending legal review')
  })

  it('drops the labels when VITE_LEGAL_REVIEWED=true', () => {
    envMock.env.legalReviewed = true
    const { container } = render(<MemoryRouter><Footer /><Legal kind="privacy" /></MemoryRouter>)
    expect(container.querySelectorAll('.legal-draft-tag')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/DRAFT|pending legal review/)
  })
})
