import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes, PAGES, Shell } from '../App'
import { Nav, NAV_LINKS } from '../components/Nav'
import { CORE_MESSAGE, INTEGRATIONS, LIVE_VERIFIED, PLANS, PRICING_LINE, shownStatus } from '../lib/site-config'
import Integrations from '../pages/Integrations'
import Pricing from '../pages/Pricing'
import Security from '../pages/Security'
import Home from '../pages/Home'

/** Words that would claim results, endorsements or certifications the business does not have. */
const INVENTED = /testimonial|case stud|customers? (love|say)|trusted by|\d+% (more|less|faster)|saved \$\d|SOC 2 (certified|compliant)|ISO 27001 certified|HIPAA compliant|guarantee/i
const STALE = /James Revenue|jamesrevenue|claimyours/i

async function renderAt(path: string) {
  const r = render(<MemoryRouter initialEntries={[path]}><Shell /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('main h1')).toBeTruthy())
  return r
}

describe('every page renders, with one headline and no invented claims', () => {
  for (const path of PAGES) {
    it(path, async () => {
      const { container } = await renderAt(path)
      expect(container.querySelectorAll('main h1')).toHaveLength(1)
      const text = container.textContent ?? ''
      expect(text).not.toMatch(INVENTED)
      expect(text).not.toMatch(STALE)
      expect(text).toContain(CORE_MESSAGE) // the footer carries the core message on every page
    })
  }
  it('an unknown page says so', async () => {
    await renderAt('/no-such-page')
    expect(screen.getAllByText(/not found|doesn.t exist|could not find/i).length).toBeGreaterThan(0)
  })
})

describe('navigation', () => {
  it('links every main page and the pilot application', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>)
    expect(NAV_LINKS.map(l => l.to)).toEqual(['/office', '/commerce', '/how-it-works', '/integrations', '/agents', '/pricing', '/security'])
    for (const l of NAV_LINKS) expect(PAGES).toContain(l.to)
    expect(screen.getAllByRole('link', { name: 'Apply for a paid pilot' })[0]).toHaveAttribute('href', '/#early-access')
    expect(screen.getAllByRole('link', { name: 'Sign up' })[0]).toHaveAttribute('href', '/signup')
  })
})

describe('core message', () => {
  it('leads the home page', () => {
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    expect(container.querySelector('h1')!.textContent).toBe('Your business has unfinished work.Deploi finds it, handles it, and shows you what got done.')
    expect(screen.getByRole('form', { name: 'Apply for a paid pilot' })).toBeInTheDocument()
    expect(container.querySelector('[data-product="office"]')).toBeTruthy()
    expect(container.querySelector('[data-product="commerce"]')).toBeTruthy()
  })
})

describe('integrations honesty rule', () => {
  it('no integration is shown as Available unless it is live-verified (none are today)', () => {
    expect(LIVE_VERIFIED).toEqual([])
    for (const i of INTEGRATIONS) if (!LIVE_VERIFIED.includes(i.key)) expect(shownStatus(i)).not.toBe('available')
    // even an entry that claims Available is shown as Pilot until it is live-verified
    expect(shownStatus({ key: 'made_up', status: 'available' })).toBe('pilot')
    const { container } = render(<MemoryRouter><Integrations /></MemoryRouter>)
    expect(container.querySelectorAll('[data-status="available"]')).toHaveLength(LIVE_VERIFIED.length)
  })
  it('marks the pilot and planned integrations as the brief states', () => {
    const by = (s: string) => INTEGRATIONS.filter(i => shownStatus(i) === s).map(i => i.name)
    expect(by('pilot')).toEqual(['Shopify', 'WooCommerce', 'Deploi Email', 'HubSpot', 'Google Calendar', 'QuickBooks'])
    for (const n of ['Outlook', 'Gmail', 'Pipedrive', 'Salesforce', 'Xero', 'Slack']) expect(by('planned')).toContain(n)
    const { container } = render(<MemoryRouter><Integrations /></MemoryRouter>)
    for (const i of INTEGRATIONS) {
      const row = container.querySelector<HTMLElement>(`[data-integration="${i.key}"]`)!
      expect(within(row).getByText(shownStatus(i) === 'pilot' ? 'Pilot' : 'Planned')).toBeInTheDocument()
    }
  })
})

describe('pricing', () => {
  it('shows the pilot hypotheses from the single config, labelled as pilot pricing', () => {
    expect(PRICING_LINE).toBe('Pilot pricing — Office Starter $149/mo, Commerce Operations $299/mo, Business Workforce from $499/mo — final pricing confirmed at pilot start')
    const { container } = render(<MemoryRouter><Pricing /></MemoryRouter>)
    expect(container.textContent).toContain(PRICING_LINE)
    expect(container.querySelectorAll('[data-plan]')).toHaveLength(PLANS.length)
    for (const p of PLANS) expect(within(container.querySelector<HTMLElement>(`[data-plan="${p.key}"]`)!).getByText('Pilot pricing')).toBeInTheDocument()
    expect(container.textContent).toMatch(/Final pricing confirmed at pilot start/)
  })
})

describe('security', () => {
  it('claims no certification', () => {
    const { container } = render(<MemoryRouter><Security /></MemoryRouter>)
    expect(screen.getByTestId('no-certifications')).toHaveTextContent(/holds no security certifications/)
    expect(container.textContent).not.toMatch(/\b(certified|compliant)\b/i)
  })
})

describe('signup', () => {
  it('links to the app', async () => {
    render(<MemoryRouter initialEntries={['/signup']}><AppRoutes /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('app-signin')).toBeInTheDocument())
    expect(screen.getByTestId('app-signin').getAttribute('href')).toMatch(/^https?:\/\/.+\/login$/)
  })
})
