import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Nav, NAV_LINKS } from '../components/Nav'
import { Footer } from '../components/Footer'
import Legal, { PRIVACY, termsSections } from '../pages/Legal'
import Support, { SUPPORT_FAQ } from '../pages/Support'
import Home, { FAQ, FAQS, FLOW, CHECKS, PLATFORM_CARDS, SHOPIFY_STATUS_LINE, EXAMPLE_AGENT, AGENT_ROLES } from '../pages/Home'
import { AppRoutes, Shell } from '../App'
import { CONTACT_EMAIL } from '../lib/brand'

const CONSULTING = /home care|assessment|retainer|EVV|BAA|Website Improvement|\$500/i

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

describe('Nav', () => {
  it('renders the wordmark, the product links and the early access button', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>)
    expect(screen.getByLabelText('Deploi AI home')).toHaveTextContent('deploi ai')
    for (const l of NAV_LINKS) expect(screen.getAllByText(l.label).length).toBeGreaterThan(0)
    expect(NAV_LINKS.map(l => l.to)).toEqual(['/agents', '/pricing', '/#how', '/#shopify', '/#controls', '/#faq'])
    const ctas = screen.getAllByRole('link', { name: 'Apply for Early Access' })
    expect(ctas.length).toBeGreaterThan(0)
    for (const a of ctas) expect(a).toHaveAttribute('href', '/#early-access')
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument()
  })
})

describe('Footer', () => {
  it('links privacy, terms and the contact email, and nothing from the old offer', () => {
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByText('Privacy Policy')).toHaveAttribute('href', '/privacy')
    expect(screen.getByText('Terms of Service')).toHaveAttribute('href', '/terms')
    expect(screen.getByText('Support')).toHaveAttribute('href', '/support')
    expect(screen.getByText(CONTACT_EMAIL)).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`)
    expect(container.querySelector('a[href="/website"], a[href="/evv"], a[href="/baa"]')).toBeNull()
    expect(container.textContent).not.toMatch(CONSULTING)
  })
})

describe('Home', () => {
  it('shows Apply for Early Access and the honest Shopify status line', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    expect(screen.getAllByText('Apply for Early Access').length).toBeGreaterThan(0)
    expect(screen.getByRole('form', { name: 'Apply for Early Access' })).toBeInTheDocument()
    expect(screen.getByText(SHOPIFY_STATUS_LINE)).toBeInTheDocument()
    expect(SHOPIFY_STATUS_LINE).toBe('Early access. Tested on a synthetic store; not yet in the Shopify App Store.')
  })

  it('labels WooCommerce and Amazon Seller Central as Planned and Shopify as Early access', () => {
    const { container } = render(<MemoryRouter><Home /></MemoryRouter>)
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.platform-card'))
    expect(cards).toHaveLength(3)
    const byName = (n: string) => cards.find(c => within(c).queryByText(n, { selector: '.icard-title' }))!
    expect(within(byName('Shopify')).getByText('Early access')).toBeInTheDocument()
    expect(within(byName('WooCommerce')).getByText('Planned')).toBeInTheDocument()
    expect(within(byName('Amazon Seller Central')).getByText('Planned')).toBeInTheDocument()
    expect(PLATFORM_CARDS.filter(p => p.status === 'planned').map(p => p.name)).toEqual(['WooCommerce', 'Amazon Seller Central'])
    expect(container.textContent).toMatch(/not partnerships/)
    for (const c of cards) expect(c.querySelectorAll('img')).toHaveLength(0) // no vendor logos
  })

  it('contains no consulting terms anywhere on the rendered home page', () => {
    const { container } = render(<MemoryRouter initialEntries={['/']}><Shell /></MemoryRouter>)
    expect(container.textContent).not.toMatch(CONSULTING)
  })

  it('renders the five-step flow, the agent library and all four Shopify corrections', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    expect(FLOW.map(f => f.title)).toEqual(['Connect your store', 'Switch on agents', 'Approve their work', 'Agents earn auto-run', 'Weekly summary'])
    for (const f of FLOW) expect(screen.getByRole('heading', { level: 3, name: f.title })).toBeInTheDocument()
    expect(CHECKS).toHaveLength(4)
    for (const c of CHECKS) expect(screen.getAllByText(c.title).length).toBeGreaterThan(0)
    expect(screen.getByText(`Example: ${EXAMPLE_AGENT.name}`)).toBeInTheDocument()
    for (const t of ['Drafts only', 'After your approval', 'Without asking, within limits']) expect(screen.getByRole('heading', { level: 3, name: t })).toBeInTheDocument()
    for (const t of ['Inventory Watcher', 'Supplier Chaser', 'Store Health Checker', 'Order Tracker', 'Returns', 'Listing Writer', 'Customer Care', 'Campaign', 'Promo Manager', 'Weekly Insights', 'Payout and Fees Checker', 'AI Visibility']) expect(screen.getByRole('heading', { level: 3, name: t })).toBeInTheDocument()
    expect(screen.getByText(/time saved clearly labelled as an estimate/)).toBeInTheDocument()
    expect(screen.getAllByText(/fix my store/).length).toBeGreaterThan(0)
  })

  it('shows the agent illustrations with alt text, only roles the product can do today, and each agent once', () => {
    render(<MemoryRouter><Home /></MemoryRouter>)
    expect(AGENT_ROLES.map(r => r.title)).toEqual(['Store Health Checker', 'Inventory Watcher', 'Approval Inbox', 'Supplier Chaser', 'Weekly Summary'])
    for (const r of AGENT_ROLES) {
      const img = screen.getByAltText(r.alt)
      expect(img).toHaveAttribute('src', `/agents/${r.key}-640.webp`)
      expect(img).toHaveAttribute('loading', 'lazy')
      expect(r.alt.startsWith('Illustration:')).toBe(true)
    }
    // the one agent without an illustration is listed as a template, and never claims competitors' sales
    expect(screen.getByRole('heading', { level: 3, name: 'Competitor & Trend Watcher' })).toBeInTheDocument()
    expect(screen.getByText(/Never their sales, which are not public\./)).toBeInTheDocument()
    expect(screen.getByText(/Inventory Watcher, Supplier Chaser and Store Health Checker above/)).toBeInTheDocument()
    expect(screen.getByText(/Illustrations\. The names, products and numbers in them are examples\./)).toBeInTheDocument()
  })

  it('answers the FAQ without inventing a price', () => {
    const { container } = render(<MemoryRouter><FAQ /></MemoryRouter>)
    for (const f of FAQS) expect(screen.getByText(f.q)).toBeInTheDocument()
    const text = container.textContent ?? ''
    expect(text).toContain('Prices are coming soon; early access is free.')
    expect(text).not.toMatch(/\$\d/)
  })
})

describe('Legacy routes', () => {
  for (const path of ['/website', '/evv', '/baa']) {
    it(`redirects ${path} to /`, async () => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
      expect(screen.getAllByText('Apply for Early Access').length).toBeGreaterThan(0)
    })
  }
})

describe('Legal', () => {
  it('replaces the entity placeholder and links the contact email', () => {
    const sections = termsSections('Example Holdings LLC')
    render(<MemoryRouter><ol>{sections.map(s => <li key={s.title}>{s.body}</li>)}</ol></MemoryRouter>)
    expect(screen.getByText('Example Holdings LLC')).toBeInTheDocument()
    expect(screen.getAllByText(CONTACT_EMAIL).length).toBeGreaterThan(0)
  })

  it('keeps the draft notice and states pricing honestly in the terms', async () => {
    const { container } = render(<MemoryRouter><Legal kind="terms" /></MemoryRouter>)
    expect(screen.getByText(/pending legal review/)).toBeInTheDocument()
    expect(container.textContent).toContain('Pricing will be published before general availability.')
    expect(container.textContent).not.toMatch(CONSULTING)
  })

  it('describes what the Shopify app reads, token protection, deletion and no analytics', () => {
    const { container } = render(<MemoryRouter><Legal kind="privacy" /></MemoryRouter>)
    const text = container.textContent ?? ''
    expect(text).toMatch(/Products, product variants \(including prices, SKUs and barcodes\), inventory levels and locations/)
    expect(text).toMatch(/does not read customer or order data/)
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
    expect(text).not.toMatch(CONSULTING)
  })

  it('the privacy policy covers customers, retention and transfers', () => {
    const { container } = render(<MemoryRouter><Legal kind="privacy" /></MemoryRouter>)
    const text = container.textContent ?? ''
    expect(text).toMatch(/does not read, receive or store information about your customers/)
    expect(text).toMatch(/kept for up to 30 days/)
    expect(text).toMatch(/outside your country/)
  })
})
