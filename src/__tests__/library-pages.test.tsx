import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from '../pages/Agents'
import Pricing, { PRICING_STATUS_LINE } from '../pages/Pricing'
import { AppRoutes } from '../App'
import { AGENTS, TIERS, LIBRARY, PRICING_COMING_SOON, lowestTierFor, tierIncludes } from '../lib/library'
import appConfig from '../../deploi-app/lib/library/agent-library.json'

describe('the agent library config is shared with the app', () => {
  it('is the same file the app reads: twelve agents, three nested tiers', () => {
    expect(LIBRARY).toBe(appConfig)
    expect(AGENTS).toHaveLength(12)
    expect(TIERS.map(t => t.key)).toEqual(['starter', 'growth', 'pro'])
    expect(TIERS.map(t => t.agents.length)).toEqual([4, 8, 12])
    for (let i = 1; i < TIERS.length; i++) for (const k of TIERS[i - 1].agents) expect(TIERS[i].agents).toContain(k)
    expect(lowestTierFor('customer_care')?.key).toBe('pro')
    expect(lowestTierFor('order_tracker')?.key).toBe('growth')
    expect(lowestTierFor('inventory_watcher')?.key).toBe('starter')
    expect(PRICING_COMING_SOON).toBe(true)
  })
})

describe('Agents page', () => {
  it('shows all twelve agents with a character, plain-English description, an example task and the tier that includes it', () => {
    const { container } = render(<MemoryRouter><Agents /></MemoryRouter>)
    const cards = Array.from(container.querySelectorAll<HTMLElement>('li.agent-card'))
    expect(cards).toHaveLength(12)
    for (const a of AGENTS) {
      const card = cards.find(c => c.dataset.agent === a.key)!
      expect(within(card).getByRole('heading', { level: 2, name: a.name })).toBeInTheDocument()
      expect(within(card).getByRole('img', { name: `${a.name} character` })).toBeInTheDocument()
      expect(within(card).getByText(a.description)).toBeInTheDocument()
      expect(within(card).getByText(`“${a.exampleTask}”`)).toBeInTheDocument()
      expect(within(card).getByText(`Included from ${lowestTierFor(a.key)!.name}`)).toBeInTheDocument()
    }
    expect(container.textContent).toMatch(/not yet in the Shopify App Store/)
    expect(container.textContent).not.toMatch(/\$\d/)
  })
})

describe('Pricing page', () => {
  it('shows the three tiers with included agents, allowance and overage, prices as coming soon, and a comparison table', () => {
    const { container } = render(<MemoryRouter><Pricing /></MemoryRouter>)
    expect(screen.getByText(PRICING_STATUS_LINE)).toBeInTheDocument()
    const plans = Array.from(container.querySelectorAll<HTMLElement>('.plan-card'))
    expect(plans.map(p => p.dataset.tier)).toEqual(['starter', 'growth', 'pro'])
    for (const t of TIERS) {
      const card = plans.find(p => p.dataset.tier === t.key)!
      expect(within(card).getByText('Coming soon')).toBeInTheDocument()
      expect(within(card).getByText(String(t.monthlyActions))).toBeInTheDocument()
      expect(within(card).getByText(String(t.agents.length))).toBeInTheDocument()
      for (const k of t.agents) expect(within(card).getByText(AGENTS.find(a => a.key === k)!.name)).toBeInTheDocument()
      if (t.buildYourOwn) expect(within(card).getByText(/Build your own agent/)).toBeInTheDocument()
    }
    const table = screen.getByRole('table', { name: 'Plan comparison' })
    for (const a of AGENTS) {
      const row = within(table).getByRole('row', { name: new RegExp(`^${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
      const cells = Array.from(row.querySelectorAll('td'))
      expect(cells.map(c => c.dataset.included)).toEqual(TIERS.map(t => String(tierIncludes(t.key, a.key))))
    }
    expect(container.textContent).not.toMatch(/\$\d/)
    expect(container.textContent).toMatch(/Private beta is free/)
  })
  it('is routed at /pricing and /agents', () => {
    render(<MemoryRouter initialEntries={['/pricing']}><AppRoutes /></MemoryRouter>)
    expect(screen.findByText(PRICING_STATUS_LINE)).resolves.toBeInTheDocument()
  })
})
