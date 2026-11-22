import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Footer } from '../components/Footer'
import Legal, { PRIVACY, termsSections } from '../pages/Legal'
import Support, { SUPPORT_FAQ } from '../pages/Support'
import { AppRoutes } from '../App'
import { CONTACT_EMAIL, LEGAL } from '../lib/brand'

const CONSULTING = /home care|assessment|retainer|EVV|BAA|Website Improvement|\$500/i

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

describe('Footer', () => {
  it('links privacy, terms and the contact email, and nothing from the old offer', () => {
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByText('Privacy Policy')).toHaveAttribute('href', '/privacy')
    expect(screen.getByText('Terms of Service')).toHaveAttribute('href', '/terms')
    expect(screen.getByText('Support')).toHaveAttribute('href', '/support')
    expect(screen.getByText('Contact')).toHaveAttribute('href', '/contact')
    expect(screen.getByText(CONTACT_EMAIL)).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`)
    expect(container.querySelector('a[href="/website"], a[href="/evv"], a[href="/baa"]')).toBeNull()
    expect(container.textContent).not.toMatch(CONSULTING)
  })
})

describe('Legacy routes', () => {
  for (const path of ['/website', '/evv', '/baa', '/audit']) {
    it(`redirects ${path} to /`, async () => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
      expect(screen.getAllByText('Apply for a paid pilot').length).toBeGreaterThan(0)
    })
  }
})

describe('Legal', () => {
  it('names the operator from the one config value (LEGAL) and links the contact email', () => {
    const sections = termsSections()
    render(<MemoryRouter><ol>{sections.map(s => <li key={s.title}>{s.body}</li>)}</ol></MemoryRouter>)
    expect(screen.getByText(LEGAL.entity)).toBeInTheDocument()
    expect(screen.getAllByText(CONTACT_EMAIL).length).toBeGreaterThan(0)
  })

  it('keeps the draft notice and states pricing honestly in the terms', async () => {
    const { container } = render(<MemoryRouter><Legal kind="terms" /></MemoryRouter>)
    expect(container.textContent).not.toMatch(/pending legal review|DRAFT/)
    expect(container.textContent).toContain('Pricing will be published before general availability.')
    expect(container.textContent).toMatch(/none is generally available yet/)
    expect(container.textContent).not.toMatch(CONSULTING)
  })

  it('describes what the Shopify app reads, token protection, deletion and no analytics', () => {
    const { container } = render(<MemoryRouter><Legal kind="privacy" /></MemoryRouter>)
    const text = container.textContent ?? ''
    // every Shopify permission the app asks for (deploi-app/shopify.app.deploi-dev.toml.example), with what and why
    for (const s of ['read_products', 'write_products', 'read_inventory', 'read_locations', 'read_discounts', 'read_publications, write_publications (optional)']) expect(text).toContain(s)
    expect(text).toMatch(/does not ask for, read or store your Shopify customers, orders/)
    for (const t of ['customers/data_request', 'customers/redact']) expect(text).toContain(t)
    for (const p of ['Vercel', 'Supabase', 'Resend', 'Twilio', 'No AI provider']) expect(text).toContain(p)
    expect(text).toMatch(/AI features are switched off/)
    expect(text).toMatch(/never use your data to train models/)
    expect(text).toMatch(/stored in the United States/)
    expect(text).toMatch(/encrypted at rest/)
    expect(text).toMatch(/never shown in the browser/)
    expect(text).toMatch(/shop\/redact/)
    expect(text).toMatch(/no analytics/)
    expect(text).not.toMatch(/We use basic cookies and analytics/i)
    expect(text).not.toMatch(CONSULTING)
    expect(PRIVACY[PRIVACY.length - 1].title).toBe('Contact')
  })
})

describe('Support', () => {
  it('gives the support email, install and uninstall answers, data deletion and beta access, with no invented promises', () => {
    const { container } = render(<MemoryRouter><Support /></MemoryRouter>)
    const text = container.textContent ?? ''
    expect(screen.getAllByText(CONTACT_EMAIL)[0]).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`)
    expect(SUPPORT_FAQ.length).toBeGreaterThanOrEqual(6)
    expect(text).toMatch(/You never type your store address into Deploi/)
    expect(text).toMatch(/delete your store.s data/)
    expect(text).toMatch(/invite code/)
    expect(text).not.toMatch(/guarantee|within \d+ (hours|minutes)|24\/7/i)
    expect(text).toMatch(/We reply within 2 business days/)
    expect(text).not.toMatch(CONSULTING)
  })

  it('the privacy policy covers customers, retention and transfers', () => {
    const { container } = render(<MemoryRouter><Legal kind="privacy" /></MemoryRouter>)
    const text = container.textContent ?? ''
    expect(text).toMatch(/does not ask for, read or store your Shopify customers/)
    expect(text).toMatch(/kept for up to 30 days/)
    expect(text).toMatch(/outside your country/)
  })
})
