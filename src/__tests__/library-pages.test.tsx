import { describe, expect, it } from 'vitest'
import { render, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents, { OFFICE_AGENTS } from '../pages/Agents'
import { AGENTS, TIERS, LIBRARY, PRICING_COMING_SOON, lowestTierFor } from '../lib/library'
import appConfig from '../../deploi-app/lib/library/agent-library.json'

describe('the agent library config is shared with the app', () => {
  it('is the same file the app reads: twelve agents, three nested tiers', () => {
    expect(LIBRARY).toBe(appConfig)
    expect(AGENTS).toHaveLength(12)
    expect(TIERS.map(t => t.key)).toEqual(['starter', 'growth', 'pro'])
    for (let i = 1; i < TIERS.length; i++) for (const k of TIERS[i - 1].agents) expect(TIERS[i].agents).toContain(k)
    expect(lowestTierFor('inventory_watcher')?.key).toBe('starter')
    expect(PRICING_COMING_SOON).toBe(true)
  })
})

describe('Agent capabilities page', () => {
  it('shows the Office agents and all twelve Commerce agents with a character, description and example task', () => {
    const { container } = render(<MemoryRouter><Agents /></MemoryRouter>)
    expect(OFFICE_AGENTS.map(a => a.title)).toEqual(['Lead Follow-up', 'Meeting Scheduler', 'CRM Updater', 'Customer Reply'])
    const cards = Array.from(container.querySelectorAll<HTMLElement>('li.agent-card'))
    expect(cards).toHaveLength(12)
    for (const a of AGENTS) {
      const card = cards.find(c => c.dataset.agent === a.key)!
      expect(within(card).getByRole('heading', { level: 3, name: a.name })).toBeInTheDocument()
      expect(within(card).getByRole('img', { name: `${a.name} character` })).toBeInTheDocument()
      expect(within(card).getByText(a.description)).toBeInTheDocument()
      expect(within(card).getByText(`“${a.exampleTask}”`)).toBeInTheDocument()
    }
    expect(container.textContent).toMatch(/not yet in the Shopify App Store/)
    expect(container.textContent).toMatch(/starts at drafts only/)
  })
})
