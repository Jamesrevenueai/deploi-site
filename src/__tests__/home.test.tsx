import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Home, { HERO_EXAMPLE_LABEL, HOME_FAQ, TICKER_LABEL, CREW } from '../pages/Home'
import { Footer } from '../components/Footer'
import catalog from '../../deploi-app/lib/pricing/catalog.json'

const usd = (cents: number) => `$${cents / 100}`
const num = (n: number) => n.toLocaleString('en-US')

function renderHome() {
  return render(<MemoryRouter><Home /></MemoryRouter>)
}
const pricing = (c: HTMLElement) => c.querySelector<HTMLElement>('#pricing')!
const shown = (c: HTMLElement, id: string) => Array.from(pricing(c).querySelectorAll(`[data-testid="${id}"]`)).map(e => e.textContent)

describe('homepage pricing comes from deploi-app/lib/pricing/catalog.json', () => {
  it('Store (default): prices, actions, custom agents and the overage line', () => {
    const { container } = renderHome()
    const store = catalog.store
    expect(shown(container, 'plan-price')).toEqual(store.plans.map(p => usd(p.monthlyCents)))
    expect(shown(container, 'plan-price')).toEqual(['$79', '$199', '$499'])
    expect(shown(container, 'plan-actions')).toEqual(store.plans.map(p => `${num(p.actions)} actions / month`))
    const names = within(pricing(container)).getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(names).toEqual(['Starter', 'Growth', 'Pro'])
    const text = pricing(container).textContent ?? ''
    expect(text).toContain(`${store.plans[0].customAgents} custom agent`)
    expect(text).toContain(`${store.plans[1].customAgents} custom agents`)
    expect(text).toContain('Unlimited custom agents')
    expect(text).toContain(`${store.plans[0].agents.length} core agents`)
    expect(shown(container, 'overage')).toEqual([`${usd(store.overage.priceCents)} per ${store.overage.unitActions} extra actions. Set a monthly cap so you are never surprised.`])
    expect(shown(container, 'bundle')).toEqual([`Run both and save ${catalog.office.bundleDiscountPercent}% on the Office plan. Pay yearly and get ${catalog.office.yearlyMonthsFree} months free.`])
  })

  it('Office: the switch shows the Office plans, texts and the setup fee', () => {
    const { container } = renderHome()
    fireEvent.click(screen.getByRole('button', { name: 'Office' }))
    const office = catalog.office
    expect(shown(container, 'plan-price')).toEqual(office.plans.map(p => usd(p.monthlyCents)))
    expect(shown(container, 'plan-price')).toEqual(['$149', '$349', '$799'])
    expect(shown(container, 'plan-actions')).toEqual(office.plans.map(p => `${num(p.actions)} actions · ${num(p.texts)} texts / month`))
    expect(within(pricing(container)).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Office Solo', 'Office Team', 'Office Business'])
    expect(pricing(container).textContent).toContain(`Up to ${office.plans[1].crew} crew members get job texts`)
    expect(shown(container, 'overage')).toEqual([`${usd(office.overage.actionPriceCents)} per ${office.overage.unitActions} extra actions, ${usd(office.overage.textPriceCents)} per ${office.overage.unitTexts} extra texts. Optional done-for-you setup on Solo and Team: ${usd(office.setup.priceCents)} one time.`])
  })

  it('the Store / Office switch toggles aria-pressed', () => {
    renderHome()
    const store = screen.getByRole('button', { name: 'Store · Shopify' })
    const office = screen.getByRole('button', { name: 'Office' })
    expect(store).toHaveAttribute('aria-pressed', 'true')
    expect(office).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(office)
    expect(store).toHaveAttribute('aria-pressed', 'false')
    expect(office).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(store)
    expect(store).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('homepage content', () => {
  it('has the five FAQ items as details/summary, with the overage price from the catalog', () => {
    const { container } = renderHome()
    const items = container.querySelectorAll('#faq details')
    expect(items).toHaveLength(5)
    expect(HOME_FAQ).toHaveLength(5)
    items.forEach(d => expect(d.querySelector('summary')).toBeTruthy())
    expect(container.querySelector('#faq')!.textContent).toContain(`billed at ${usd(catalog.store.overage.priceCents)} per ${catalog.store.overage.unitActions}`)
  })

  it('labels every example number as example data', () => {
    const { container } = renderHome()
    expect(screen.getByTestId('hero-example-label')).toHaveTextContent('Example data from a Deploi test store')
    expect(HERO_EXAMPLE_LABEL).toBe('Example data from a Deploi test store')
    expect(screen.getByRole('region', { name: TICKER_LABEL })).toBeInTheDocument()
    expect(TICKER_LABEL).toBe('Examples of things Deploi agents do')
    expect(container.textContent).not.toMatch(/testimonial|trusted by|customers love/i)
  })

  it('shows the eight crew agents and links to the full library and the right places', () => {
    const { container } = renderHome()
    expect(CREW).toHaveLength(8)
    expect(container.querySelectorAll('#crew article')).toHaveLength(8)
    expect(screen.getByRole('link', { name: 'See all 12 agents →' })).toHaveAttribute('href', '/agents')
    expect(screen.getByRole('link', { name: 'Watch it work' })).toHaveAttribute('href', '#how')
    expect(screen.getByRole('link', { name: 'Book an Office demo' })).toHaveAttribute('href', '/contact')
    for (const l of screen.getAllByRole('link', { name: /Install on Shopify/ })) expect(l).toHaveAttribute('href', '/signup')
    for (const l of screen.getAllByRole('link', { name: /Start free trial/ })) expect(l).toHaveAttribute('href', '/signup')
  })
})

describe('footer', () => {
  it('carries the Shopify trademark line', () => {
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(container.textContent).toContain('Shopify is a trademark of Shopify Inc.')
  })
})
